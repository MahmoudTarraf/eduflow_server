const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { uploadFile } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  getCloudinaryAssets,
  getCloudinaryAsset
} = require('../controllers/cloudinaryUpload');

// All routes require authentication and instructor/admin role
router.use(protect);
router.use(authorize('instructor', 'admin'));

// @route   POST /api/upload/cloudinary
// @desc    Upload file to Cloudinary
// @access  Private (Instructor/Admin)
router.post('/', uploadFile.single('file'), scanFile, uploadToCloudinary);

// @route   GET /api/upload/cloudinary
// @desc    Get all Cloudinary assets (with filters)
// @access  Private (Instructor/Admin)
router.get('/', getCloudinaryAssets);

// @route   GET /api/upload/cloudinary/:assetId
// @desc    Get single Cloudinary asset
// @access  Private
router.get('/:assetId', getCloudinaryAsset);

// @route   DELETE /api/upload/cloudinary/:assetId
// @desc    Delete file from Cloudinary
// @access  Private (Instructor/Admin - owner or admin only)
router.delete('/:assetId', deleteFromCloudinary);

module.exports = router;
