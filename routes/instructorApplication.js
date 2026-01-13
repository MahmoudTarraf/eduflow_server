const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { protect, authorize } = require('../middleware/auth');
const scanFile = require('../middleware/scanFile');
const {
  registerInstructor,
  verifyInstructorEmail,
  resendInstructorOTP,
  generateAgreement,
  saveIntroVideo,
  getPendingApplications,
  approveApplication,
  rejectApplication,
  deleteIncompleteApplication,
  uploadIntroVideo
} = require('../controllers/instructorApplication');

// Configure multer for video uploads
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/instructor-videos');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `instructor_intro_${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const toBytes = (mb, fallback) => {
  const n = parseInt(mb, 10);
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return v * 1024 * 1024;
};
const INTRO_MAX_VIDEO_BYTES = toBytes(process.env.MAX_VIDEO_SIZE_MB, 500);

const videoUpload = multer({
  storage: videoStorage,
  limits: { fileSize: INTRO_MAX_VIDEO_BYTES },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, AVI, and WEBM allowed.'));
    }
  }
});

// Public routes
router.post('/register-instructor', registerInstructor);
router.post('/verify-instructor-email', verifyInstructorEmail);
router.post('/resend-instructor-otp', resendInstructorOTP);
router.delete('/instructor-application', deleteIncompleteApplication);

// Instructor application routes (public during registration)
router.post('/instructor/generate-agreement', generateAgreement);
router.post('/instructor/save-intro-video', saveIntroVideo);
router.post('/instructor/upload-intro-video', videoUpload.single('video'), scanFile, uploadIntroVideo);

// Admin routes
router.get('/admin/instructor-applications', protect, authorize('admin'), getPendingApplications);
router.put('/admin/instructor-applications/:id/approve', protect, authorize('admin'), approveApplication);
router.put('/admin/instructor-applications/:id/reject', protect, authorize('admin'), rejectApplication);

module.exports = router;
