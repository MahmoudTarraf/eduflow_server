const cloudinary = require('../config/cloudinary');
const mongoose = require('mongoose');
const CloudinaryAsset = require('../models/CloudinaryAsset');
const fs = require('fs').promises;

/**
 * Upload file to Cloudinary
 * Handles PDFs, images, ZIPs, documents, etc.
 * @route POST /api/upload/cloudinary
 * @access Private (Instructor/Admin)
 */
exports.uploadToCloudinary = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { 
      title, 
      description, 
      courseId, 
      sectionId, 
      groupId, 
      contentId,
      resourceType = 'auto' // auto, image, raw, video
    } = req.body;

    if (!req.file) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'File is required'
      });
    }

    // Validate file size
    const maxSize = 100 * 1024 * 1024; // 100MB
    if (req.file.size > maxSize) {
      await session.abortTransaction();
      session.endSession();
      // Clean up uploaded file
      await fs.unlink(req.file.path).catch(console.error);
      return res.status(400).json({
        success: false,
        message: 'File size exceeds 100MB limit'
      });
    }

    console.log('📤 Uploading file to Cloudinary:', req.file.originalname);

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(req.file.path, {
      resource_type: resourceType,
      folder: `eduflow/${courseId || 'general'}`,
      public_id: `${Date.now()}_${req.file.originalname.replace(/\.[^/.]+$/, '')}`,
      overwrite: false,
      use_filename: true,
      unique_filename: true
    });

    console.log('✅ Cloudinary upload successful:', uploadResult.secure_url);

    // Delete local temporary file
    await fs.unlink(req.file.path).catch(err => 
      console.error('Failed to delete temp file:', err)
    );

    // Store asset metadata in database
    const asset = await CloudinaryAsset.create([{
      title: title || req.file.originalname,
      description: description || '',
      cloudinaryPublicId: uploadResult.public_id,
      cloudinaryUrl: uploadResult.secure_url,
      resourceType: uploadResult.resource_type,
      format: uploadResult.format,
      fileSize: uploadResult.bytes,
      width: uploadResult.width,
      height: uploadResult.height,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      uploadedBy: req.user.id,
      course: courseId || null,
      section: sectionId || null,
      group: groupId || null,
      content: contentId || null
    }], { session });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({
      success: true,
      message: 'File uploaded to Cloudinary successfully',
      data: {
        asset: asset[0],
        url: uploadResult.secure_url,
        publicId: uploadResult.public_id
      }
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    console.error('❌ Cloudinary upload error:', error);

    // Clean up temp file if it exists
    if (req.file && req.file.path) {
      await fs.unlink(req.file.path).catch(console.error);
    }

    res.status(500).json({
      success: false,
      message: 'Failed to upload file to Cloudinary',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Upload failed'
    });
  }
};

/**
 * Delete file from Cloudinary
 * @route DELETE /api/upload/cloudinary/:assetId
 * @access Private (Instructor/Admin - owner or admin only)
 */
exports.deleteFromCloudinary = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { assetId } = req.params;

    const asset = await CloudinaryAsset.findById(assetId).session(session);

    if (!asset) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    // Check authorization: owner or admin
    if (asset.uploadedBy.toString() !== req.user.id && req.user.role !== 'admin') {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this asset'
      });
    }

    console.log('🗑️ Deleting from Cloudinary:', asset.cloudinaryPublicId);

    // Delete from Cloudinary
    const deleteResult = await cloudinary.uploader.destroy(
      asset.cloudinaryPublicId,
      { resource_type: asset.resourceType }
    );

    if (deleteResult.result !== 'ok' && deleteResult.result !== 'not found') {
      console.error('Cloudinary delete warning:', deleteResult);
    }

    // Delete from database
    await CloudinaryAsset.findByIdAndDelete(assetId).session(session);

    await session.commitTransaction();
    session.endSession();

    res.json({
      success: true,
      message: 'Asset deleted successfully from Cloudinary and database'
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    console.error('❌ Delete from Cloudinary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete asset',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Delete failed'
    });
  }
};

/**
 * Get all Cloudinary assets (with filters)
 * @route GET /api/upload/cloudinary
 * @access Private (Instructor/Admin)
 */
exports.getCloudinaryAssets = async (req, res) => {
  try {
    const { courseId, sectionId, uploadedBy } = req.query;
    const query = {};

    // If instructor, show only their uploads
    if (req.user.role === 'instructor') {
      query.uploadedBy = req.user.id;
    }

    // Apply filters
    if (courseId) query.course = courseId;
    if (sectionId) query.section = sectionId;
    if (uploadedBy && req.user.role === 'admin') query.uploadedBy = uploadedBy;

    const assets = await CloudinaryAsset.find(query)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .sort({ uploadedAt: -1 });

    res.json({
      success: true,
      count: assets.length,
      data: assets
    });
  } catch (error) {
    console.error('Get Cloudinary assets error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch assets'
    });
  }
};

/**
 * Get single Cloudinary asset by ID
 * @route GET /api/upload/cloudinary/:assetId
 * @access Private
 */
exports.getCloudinaryAsset = async (req, res) => {
  try {
    const { assetId } = req.params;

    const asset = await CloudinaryAsset.findById(assetId)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('section', 'name');

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    res.json({
      success: true,
      data: asset
    });
  } catch (error) {
    console.error('Get Cloudinary asset error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch asset'
    });
  }
};
