const express = require('express');
const router = express.Router();
const { protect, authorize, requireInstructorNotRestricted } = require('../middleware/auth');
const {
  createPayoutRequest,
  getMyPayoutRequests,
  cancelPayoutRequest,
  getAllPayoutRequests,
  approvePayoutRequest,
  rejectPayoutRequest,
  getInstructorSettings,
  reRequestPayout
} = require('../controllers/instructorPayouts');
const multer = require('multer');
const path = require('path');
const scanFile = require('../middleware/scanFile');

// Configure multer for proof uploads (admin only)
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/temp'));
  },
  filename: (req, file, cb) => {
    cb(null, `proof_${Date.now()}${path.extname(file.originalname)}`);
  }
});

const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf', 'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar'];
    const allowedExtensions = /\.(jpg|jpeg|png|pdf|rar)$/i;
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, PDF, and RAR files allowed.'));
    }
  }
});

// Instructor routes
router.use(protect);
router.get('/settings', authorize('instructor'), getInstructorSettings);
router.post('/create', authorize('instructor'), requireInstructorNotRestricted('requestPayout'), createPayoutRequest);
router.get('/my-requests', authorize('instructor'), requireInstructorNotRestricted('requestPayout'), getMyPayoutRequests);
router.put('/:id/cancel', authorize('instructor'), requireInstructorNotRestricted('requestPayout'), cancelPayoutRequest);
router.put('/:id/re-request', authorize('instructor'), requireInstructorNotRestricted('requestPayout'), reRequestPayout);

// Admin routes
router.get('/admin/all', authorize('admin'), getAllPayoutRequests);
router.put('/admin/:id/approve', authorize('admin'), proofUpload.single('proof'), scanFile, approvePayoutRequest);
router.put('/admin/:id/reject', authorize('admin'), rejectPayoutRequest);

module.exports = router;
