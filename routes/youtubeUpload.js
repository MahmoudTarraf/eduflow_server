const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { uploadLectureVideo, handleDynamicUploadError } = require('../middleware/uploadDynamic');
const scanFile = require('../middleware/scanFile');
const {
  initiateYouTubeAuth,
  handleYouTubeCallback,
  getYouTubeStatus,
  getYouTubeAdminSummary,
  uploadToYouTube,
  updateYouTubeVideo,
  deleteFromYouTube,
  getYouTubeVideos,
  getYouTubeVideo,
  updateYouTubeVideoStatus,
  deleteYouTubeVideoRecord,
  disconnectYouTube
} = require('../controllers/youtubeUpload');

// @route   GET /api/youtube/auth
// @desc    Initiate YouTube OAuth flow
// @access  Private (Admin)
router.get('/auth', protect, authorize('admin'), initiateYouTubeAuth);

// @route   GET /api/youtube/callback
// @desc    Handle YouTube OAuth callback
// @access  Public (OAuth callback)
router.get('/callback', handleYouTubeCallback);

// @route   GET /api/youtube/status
// @desc    Check YouTube connection status
// @access  Private (Instructor/Admin)
router.get('/status', protect, authorize('admin'), getYouTubeStatus);

// @route   GET /api/youtube/admin/summary
// @desc    Admin-only YouTube configuration summary (connection + quota + overview)
// @access  Private (Admin)
router.get('/admin/summary', protect, authorize('admin'), getYouTubeAdminSummary);

// @route   DELETE /api/youtube/disconnect
// @desc    Disconnect YouTube account
// @access  Private (Admin) — platform token only
router.delete('/disconnect', protect, authorize('admin'), disconnectYouTube);

// @route   POST /api/youtube/upload
// @desc    Upload video to YouTube
// @access  Private (Instructor/Admin)
router.post(
  '/upload',
  protect,
  authorize('admin'),
  uploadLectureVideo.single('video'),
  scanFile,
  uploadToYouTube,
  handleDynamicUploadError
);

// @route   GET /api/youtube/videos
// @desc    Get all YouTube videos (with filters)
// @access  Private (Instructor/Admin)
router.get('/videos', protect, authorize('admin'), getYouTubeVideos);

// @route   GET /api/youtube/:videoRecordId
// @desc    Get single YouTube video
// @access  Private
router.get('/:videoRecordId', protect, authorize('admin'), getYouTubeVideo);

// @route   PUT /api/youtube/:videoRecordId
// @desc    Update YouTube video metadata
// @access  Private (Instructor/Admin - owner or admin only)
router.put('/:videoRecordId', protect, authorize('admin'), updateYouTubeVideo);

router.put('/:videoRecordId/status', protect, authorize('admin'), updateYouTubeVideoStatus);

// @route   DELETE /api/youtube/:videoRecordId
// @desc    Delete video from YouTube
// @access  Private (Instructor/Admin - owner or admin only)
router.delete('/:videoRecordId', protect, authorize('admin'), deleteFromYouTube);

// @route   DELETE /api/youtube/:videoRecordId/record
// @desc    Delete YouTube video record from platform DB only
// @access  Private (Admin)
router.delete('/:videoRecordId/record', protect, authorize('admin'), deleteYouTubeVideoRecord);

module.exports = router;
