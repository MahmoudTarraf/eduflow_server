const express = require('express');
const { body, query } = require('express-validator');
const {
  register,
  login,
  getMe,
  updateProfile,
  updatePassword,
  forgotPassword,
  verifyOTP,
  resetPassword,
  resendResetOTP,
  verifyEmail,
  resendVerification,
  checkEmailDomain
} = require('../controllers/auth');
const { protect, requireStudentNotRestricted } = require('../middleware/auth');
const twoFactor = require('../controllers/twoFactor');
const cookieParser = require('cookie-parser');

const router = express.Router();

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', [
  body('name').notEmpty().withMessage('Name is required').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('password')
    .isStrongPassword({
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1
    })
    .withMessage('Password must be at least 8 characters and include uppercase, lowercase, number, and symbol'),
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('Country cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('Country can only contain letters and spaces'),
  body('city').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('City cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('City can only contain letters and spaces'),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('School cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('School can only contain letters and spaces'),
  body('role').optional().isIn(['student', 'instructor']).withMessage('Invalid role')
], register);

// @desc    Check if an email domain is disposable/temporary
// @route   GET /api/auth/check-email-domain?email=...
// @access  Public
router.get('/check-email-domain', [
  query('email').isEmail().withMessage('Please enter a valid email')
], checkEmailDomain);

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
router.post('/login', [
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('password').notEmpty().withMessage('Password is required')
], login);

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', protect, getMe);

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
router.put('/profile', protect, requireStudentNotRestricted('changeProfile'), [
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .notEmpty().withMessage('Phone number cannot be empty')
    .matches(/^09\d{8}$/).withMessage('Phone number must start with 09 and be exactly 10 digits'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('Country cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('Country can only contain letters and spaces'),
  body('city').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('City cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('City can only contain letters and spaces'),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('School cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('School can only contain letters and spaces')
], updateProfile);

// @desc    Update password
// @route   PUT /api/auth/password
// @access  Private
router.put('/password', protect, requireStudentNotRestricted('changeSettings'), [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isStrongPassword({
      minLength: 8,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1
    })
    .withMessage('New password must be at least 8 characters and include uppercase, lowercase, number, and symbol')
], updatePassword);

// @desc    Forgot password - Send OTP
// @route   POST /api/auth/forgot-password
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().withMessage('Please enter a valid email')
], forgotPassword);

// @desc    Verify OTP
// @route   POST /api/auth/verify-otp
// @access  Public
router.post('/verify-otp', [
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('otp').notEmpty().withMessage('OTP is required').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], verifyOTP);

// @desc    Reset password with OTP
// @route   POST /api/auth/reset-password
// @access  Public
router.post('/reset-password', [
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('otp').notEmpty().withMessage('OTP is required').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], resetPassword);

// @desc    Resend OTP for password reset
// @route   POST /api/auth/resend-reset-otp
// @access  Public
router.post('/resend-reset-otp', [
  body('email').isEmail().withMessage('Please enter a valid email')
], resendResetOTP);

// @desc    Verify email
// @route   GET /api/auth/verify-email/:token
// @access  Public
router.get('/verify-email/:token', verifyEmail);

// @desc    Resend verification email
// @route   POST /api/auth/resend-verification
// @access  Public
router.post('/resend-verification', [
  body('email').isEmail().withMessage('Please enter a valid email')
], resendVerification);

// 2FA routes (admin/instructor only)
router.post('/2fa/setup', protect, twoFactor.setup);
router.post('/2fa/verify-setup', protect, twoFactor.verifySetup);
router.post('/2fa/disable', protect, twoFactor.disable);
router.get('/2fa/devices', protect, twoFactor.listTrustedDevices);
router.delete('/2fa/devices/:id', protect, twoFactor.revokeTrustedDevice);

// Login 2FA completion
router.post('/login-2fa', twoFactor.login2FA);

module.exports = router;
