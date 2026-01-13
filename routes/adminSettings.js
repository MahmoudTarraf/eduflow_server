const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getSettings,
  updateSettings,
  getPaymentReceivers,
  updatePaymentReceivers,
  getPublicSettings,
  resetIntroVideosCounter,
  markRejectedAgreementsAsRead
} = require('../controllers/adminSettings');

// @desc    Get public settings (currency, passing grade)
// @route   GET /api/admin/settings/public
// @access  Public
router.get('/public', getPublicSettings);

// @desc    Get payment receivers (public for payment page)
// @route   GET /api/admin/settings/payment-receivers
// @access  Public
router.get('/payment-receivers', getPaymentReceivers);

// @desc    Get admin settings
// @route   GET /api/admin/settings
// @access  Private (Admin)
router.get('/', protect, authorize('admin'), getSettings);

// @desc    Update admin settings
// @route   PUT /api/admin/settings
// @route   POST /api/admin/settings
// @access  Private (Admin)
router.put('/', protect, authorize('admin'), updateSettings);
router.post('/', protect, authorize('admin'), updateSettings);

// @desc    Update payment receivers
// @route   PUT /api/admin/settings/payment-receivers
// @access  Private (Admin)
router.put('/payment-receivers', protect, authorize('admin'), updatePaymentReceivers);

// @desc    Reset intro video upload counters for all instructors
// @route   POST /api/admin/settings/reset-intro-videos-counter
// @access  Private (Admin)
router.post('/reset-intro-videos-counter', protect, authorize('admin'), resetIntroVideosCounter);

// @desc    Mark rejected earnings agreements as read
// @route   POST /api/admin/settings/rejected-agreements/mark-read
// @access  Private (Admin)
router.post('/rejected-agreements/mark-read', protect, authorize('admin'), markRejectedAgreementsAsRead);

module.exports = router;
