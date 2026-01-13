const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllAgreements,
  getMyAgreement,
  updateGlobalSettings,
  createCustomAgreement,
  approveAgreement,
  rejectAgreement,
  getAgreementStats,
  resendAgreement,
  deleteAgreement,
  deleteAllAgreements
} = require('../controllers/instructorEarningsAgreements');

// Instructor routes
router.get('/my-agreement', protect, authorize('instructor'), getMyAgreement);
router.put('/:agreementId/approve', protect, authorize('instructor'), approveAgreement);
router.put('/:agreementId/reject', protect, authorize('instructor'), rejectAgreement);

// Admin routes
router.get('/', protect, authorize('admin'), getAllAgreements);
router.get('/stats', protect, authorize('admin'), getAgreementStats);
router.post('/update-global-settings', protect, authorize('admin'), updateGlobalSettings);
router.post('/create-custom', protect, authorize('admin'), createCustomAgreement);
router.post('/:agreementId/resend', protect, authorize('admin'), resendAgreement);

// Admin delete routes (IMPORTANT: /all route must be before /:id to avoid conflicts)
router.delete('/all', protect, authorize('admin'), deleteAllAgreements);
router.delete('/:id', protect, authorize('admin'), deleteAgreement);

module.exports = router;
