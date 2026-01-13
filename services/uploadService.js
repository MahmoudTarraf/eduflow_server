const cloudinary = require('../config/cloudinary');
const fs = require('fs').promises;
const path = require('path');
const { PassThrough } = require('stream');
const nodeFs = require('fs');
const CloudinaryAsset = require('../models/CloudinaryAsset');
const YouTubeVideo = require('../models/YouTubeVideo');
const { setCredentials, getYouTubeService } = require('../config/youtube');
const { ensureValidYouTubeToken } = require('./youtubeTokenService');

/**
 * Hybrid Upload Service
 * Switches between local and cloud storage based on environment
 */

const USE_CLOUD_STORAGE = process.env.USE_CLOUD_STORAGE === 'true';
const USE_YOUTUBE_FOR_VIDEOS = process.env.USE_YOUTUBE_FOR_VIDEOS === 'true';

/**
 * Upload file (non-video) - uses Cloudinary in production, local in development
 */
async function uploadFile(file, metadata, userId, session = null) {
  if (USE_CLOUD_STORAGE) {
    console.log('☁️ Using Cloudinary for file upload');
    return await uploadFileToCloudinary(file, metadata, userId, session);
  } else {
    console.log('💾 Using local storage for file upload');
    return await uploadFileLocally(file, metadata);
  }
}

/**
 * Upload video - uses YouTube in production, local in development
 */
async function uploadVideo(file, metadata, userId, session = null) {
  if (USE_YOUTUBE_FOR_VIDEOS) {
    console.log('🎥 Using YouTube for video upload');
    return await uploadVideoToYouTube(file, metadata, userId, session);
  } else {
    console.log('💾 Using local storage for video upload');
    return await uploadVideoLocally(file, metadata);
  }
}

/**
 * Delete file - from Cloudinary or local storage
 */
async function deleteFile(fileData, session = null) {
  if (fileData.cloudinaryPublicId) {
    console.log('☁️ Deleting from Cloudinary');
    return await deleteFileFromCloudinary(fileData, session);
  } else if (fileData.localPath) {
    console.log('💾 Deleting from local storage');
    return await deleteFileLocally(fileData.localPath);
  }
  return { success: true, message: 'No file to delete' };
}

/**
 * Delete video - from YouTube or local storage
 */
async function deleteVideo(videoData, session = null) {
  if (videoData.youtubeVideoId) {
    console.log('🎥 Deleting from YouTube');
    return await deleteVideoFromYouTube(videoData, session);
  } else if (videoData.localPath) {
    console.log('💾 Deleting from local storage');
    return await deleteFileLocally(videoData.localPath);
  }
  return { success: true, message: 'No video to delete' };
}

// ========== Cloudinary Implementation ==========

async function uploadFileToCloudinary(file, metadata, userId, session) {
  try {
    const uploadResult = await cloudinary.uploader.upload(file.path, {
      resource_type: 'auto',
      folder: `eduflow/${metadata.courseId || 'general'}`,
      public_id: `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '')}`,
      use_filename: true,
      unique_filename: true
    });

    // Delete local temp file
    if (file.path) {
      await fs.unlink(file.path).catch(console.error);
    }

    // Store in database
    const asset = await CloudinaryAsset.create([{
      title: metadata.title || file.originalname,
      description: metadata.description || '',
      cloudinaryPublicId: uploadResult.public_id,
      cloudinaryUrl: uploadResult.secure_url,
      resourceType: uploadResult.resource_type,
      format: uploadResult.format,
      fileSize: uploadResult.bytes,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
      uploadedBy: null,
      course: metadata.courseId || null,
      section: metadata.sectionId || null,
      group: metadata.groupId || null,
      content: metadata.contentId || null
    }], { session });

    return {
      success: true,
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      assetId: asset[0]._id,
      storedName: uploadResult.public_id,
      storage: 'cloudinary'
    };
  } catch (error) {
    // Clean up temp file on error
    if (file && file.path) {
      await fs.unlink(file.path).catch(console.error);
    }
    throw error;
  }
}

async function deleteFileFromCloudinary(fileData, session) {
  await cloudinary.uploader.destroy(fileData.cloudinaryPublicId, {
    resource_type: fileData.resourceType || 'auto'
  });

  if (fileData._id) {
    await CloudinaryAsset.findByIdAndDelete(fileData._id).session(session);
  }

  return { success: true };
}

// ========== YouTube Implementation ==========

async function uploadVideoToYouTube(file, metadata, userId, session) {
  try {
    const tokenDoc = await ensureValidYouTubeToken();
    
    setCredentials({
      access_token: tokenDoc.accessToken,
      refresh_token: tokenDoc.refreshToken
    });

    const youtube = getYouTubeService();

    const uploadResponse = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: metadata.title || file.originalname,
          description: metadata.description || '',
          categoryId: '27' // Education
        },
        status: {
          privacyStatus: metadata.privacyStatus || 'unlisted',
          embeddable: true,
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: file.buffer
          ? (() => {
              const stream = new PassThrough();
              stream.end(file.buffer);
              return stream;
            })()
          : nodeFs.createReadStream(file.path)
      }
    });

    const videoId = uploadResponse.data.id;
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Delete local temp file
    if (file.path) {
      await fs.unlink(file.path).catch(console.error);
    }

    // Store in database
    const video = await YouTubeVideo.create([{
      title: metadata.title || file.originalname,
      description: metadata.description || '',
      youtubeVideoId: videoId,
      youtubeUrl,
      privacyStatus: metadata.privacyStatus || 'unlisted',
      uploadedBy: null,
      course: metadata.courseId || null,
      section: metadata.sectionId || null,
      group: metadata.groupId || null,
      content: metadata.contentId || null,
      originalFilename: file.originalname,
      fileSize: file.size
    }], { session });

    return {
      success: true,
      url: youtubeUrl,
      videoId: videoId,
      videoRecordId: video[0]._id,
      storedName: videoId,
      storage: 'youtube'
    };
  } catch (error) {
    // Clean up temp file on error
    if (file && file.path) {
      await fs.unlink(file.path).catch(console.error);
    }
    throw error;
  }
}

async function deleteVideoFromYouTube(videoData, session) {
  // IMPORTANT: Platform must never delete YouTube videos automatically.
  // Physical deletion is an explicit admin-only action.
  const recordId = videoData._id;
  const youtubeVideoId = videoData.youtubeVideoId;

  if (recordId) {
    await YouTubeVideo.findByIdAndUpdate(
      recordId,
      {
        status: 'orphaned',
        statusChangedAt: new Date()
      },
      { new: true }
    ).session(session);
    return { success: true, message: 'Video marked orphaned (no YouTube deletion performed)' };
  }

  if (youtubeVideoId) {
    await YouTubeVideo.findOneAndUpdate(
      { youtubeVideoId },
      {
        status: 'orphaned',
        statusChangedAt: new Date()
      },
      { new: true }
    ).session(session);
  }

  return { success: true, message: 'No YouTube deletion performed' };
}

// ========== Local Storage Implementation ==========

async function uploadFileLocally(file, metadata) {
  // File is already stored by multer
  return {
    success: true,
    url: `/uploads/files/${file.filename}`,
    localPath: file.path,
    storedName: file.filename,
    storage: 'local'
  };
}

async function uploadVideoLocally(file, metadata) {
  // Video is already stored by multer
  return {
    success: true,
    url: `/uploads/videos/${file.filename}`,
    localPath: file.path,
    storedName: file.filename,
    storage: 'local'
  };
}

async function deleteFileLocally(filePath) {
  try {
    await fs.unlink(filePath);
    return { success: true };
  } catch (error) {
    console.error('Local file deletion error:', error);
    return { success: false, error: error.message };
  }
}

// ========== Export ==========

module.exports = {
  uploadFile,
  uploadVideo,
  deleteFile,
  deleteVideo,
  USE_CLOUD_STORAGE,
  USE_YOUTUBE_FOR_VIDEOS
};
