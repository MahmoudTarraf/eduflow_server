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
const scanFile = require('../middleware/scanFile');
const { uploadLectureVideo, handleDynamicUploadError } = require('../middleware/uploadDynamic');

// Public route for getting agreement text
router.get('/agreement-text', getAgreementText);

// Instructor routes — uses uploadDynamic (memoryStorage when USE_YOUTUBE=true, USE_LOCAL_STORAGE=false)
router.post('/submit-agreement', protect, authorize('instructor'), uploadLectureVideo.single('video'), scanFile, submitAgreement, handleDynamicUploadError);
router.put('/reupload-intro-video', protect, authorize('instructor'), uploadLectureVideo.single('video'), scanFile, reuploadIntroVideo, handleDynamicUploadError);

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
