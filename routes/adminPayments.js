const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getPendingPayments,
  approvePayment,
  rejectPayment,
  getAdminEarnings,
  getStudentPaymentHistory
} = require('../controllers/adminPayments');

// Admin routes
router.get('/student-payments', protect, authorize('admin'), getPendingPayments);
router.post('/student-payments/:id/approve', protect, authorize('admin'), approvePayment);
router.post('/student-payments/:id/reject', protect, authorize('admin'), rejectPayment);
router.get('/my-earnings', protect, authorize('admin'), getAdminEarnings);

// Student route
router.get('/student/payment-history', protect, authorize('student'), getStudentPaymentHistory);

module.exports = router;
