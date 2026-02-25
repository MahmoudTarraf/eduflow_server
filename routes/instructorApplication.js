const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const scanFile = require('../middleware/scanFile');
const { uploadLectureVideo, handleDynamicUploadError } = require('../middleware/uploadDynamic');
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

// Public routes
router.post('/register-instructor', registerInstructor);
router.post('/verify-instructor-email', verifyInstructorEmail);
router.post('/resend-instructor-otp', resendInstructorOTP);
router.delete('/instructor-application', deleteIncompleteApplication);

// Instructor application routes (public during registration)
router.post('/instructor/generate-agreement', generateAgreement);
router.post('/instructor/save-intro-video', saveIntroVideo);
// Uses uploadDynamic (memoryStorage when USE_YOUTUBE=true, USE_LOCAL_STORAGE=false)
router.post('/instructor/upload-intro-video', uploadLectureVideo.single('video'), scanFile, uploadIntroVideo, handleDynamicUploadError);

// Admin routes
router.get('/admin/instructor-applications', protect, authorize('admin'), getPendingApplications);
router.put('/admin/instructor-applications/:id/approve', protect, authorize('admin'), approveApplication);
router.put('/admin/instructor-applications/:id/reject', protect, authorize('admin'), rejectApplication);

module.exports = router;
