const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAgreementText,
  submitAgreement,
  getAllSignupAgreements,
  getPendingAgreements,
  approveAgreement,
  rejectAgreement,
  getInstructorVideo,
  getInstructorVideoInfo,
  reuploadIntroVideo,
  adminResetIntroVideo,
  adminResetAllIntroVideos
} = require('../controllers/instructorAgreement');
const multer = require('multer');
const path = require('path');
const scanFile = require('../middleware/scanFile');

// Configure multer for video uploads
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/temp'));
  },
  filename: (req, file, cb) => {
    cb(null, `video_${Date.now()}${path.extname(file.originalname)}`);
  }
});

const videoUpload = multer({
  storage: videoStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, AVI, and WEBM allowed.'));
    }
  }
});

// Public route for getting agreement text
router.get('/agreement-text', getAgreementText);

// Instructor routes
router.post('/submit-agreement', protect, authorize('instructor'), videoUpload.single('video'), scanFile, submitAgreement);
router.put('/reupload-intro-video', protect, authorize('instructor'), videoUpload.single('video'), scanFile, reuploadIntroVideo);

// Admin routes
router.get('/admin/all', protect, authorize('admin'), getAllSignupAgreements);
router.get('/admin/pending', protect, authorize('admin'), getPendingAgreements);
router.put('/admin/:id/approve', protect, authorize('admin'), approveAgreement);
router.put('/admin/:id/reject', protect, authorize('admin'), rejectAgreement);
router.put('/admin/:id/reset-intro-video', protect, authorize('admin'), adminResetIntroVideo);
router.put('/admin/reset-intro-video-attempts', protect, authorize('admin'), adminResetAllIntroVideos);

// Video routes
router.get('/:id/intro-video', getInstructorVideo);
router.get('/:id/video-info', getInstructorVideoInfo);

module.exports = router;
