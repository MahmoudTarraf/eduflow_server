const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  recordPayment,
  verifyPayment,
  getGroupPayments,
  checkSectionAccess
} = require('../controllers/paymentManagement');

// Payment routes
router.post('/payments/record', protect, recordPayment);
router.put('/payments/:paymentId/verify', protect, authorize('instructor', 'admin'), verifyPayment);

// Group payments
router.get('/groups/:groupId/payments', protect, authorize('instructor', 'admin'), getGroupPayments);

// Section access check
router.get('/sections/:sectionId/access', protect, checkSectionAccess);

module.exports = router;
