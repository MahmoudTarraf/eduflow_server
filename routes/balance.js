const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const {
  lockBalance,
  releaseLockedBalance,
  confirmBalanceDeduction,
  getBalanceInfo
} = require('../controllers/balanceController');

// @desc    Lock balance temporarily during payment processing
// @route   POST /api/payments/lock-balance
// @access  Private (Student)
router.post('/lock-balance', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), lockBalance);

// @desc    Release locked balance if payment fails
// @route   POST /api/payments/release-balance
// @access  Private (Student)
router.post('/release-balance', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), releaseLockedBalance);

// @desc    Confirm balance deduction after successful payment
// @route   POST /api/payments/confirm-balance-deduction
// @access  Private (Admin)
router.post('/confirm-balance-deduction', protect, authorize('admin'), confirmBalanceDeduction);

// @desc    Get student's current balance information
// @route   GET /api/payments/balance-info
// @access  Private (Student)
router.get('/balance-info', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), getBalanceInfo);

module.exports = router;
