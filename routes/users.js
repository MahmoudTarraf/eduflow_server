const express = require('express');
const { body } = require('express-validator');
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getStudents,
  getInstructors,
  getPendingInstructors,
  approveInstructor,
  rejectInstructor,
  toggleInstructorTrust,
  getUserEnrollments,
  sendMessageToUser,
  getAdmin,
  getProfile,
  updateProfile,
  deleteAccount,
  getPendingRegistrations,
  deletePendingRegistration,
  banUser,
  unbanUser,
  suspendUser,
  unsuspendUser,
  requestEmailChange,
  verifyEmailChange,
  resetChangeLimits
} = require('../controllers/users');
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const { uploadAvatar, handleMulterError } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');

const router = express.Router();

// @desc    Search users
// @route   GET /api/users/search
// @access  Private
router.get('/search', protect, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ success: true, users: [] });
    }

    const User = require('../models/User');
    const users = await User.find({
      _id: { $ne: req.user.id }, // Exclude self
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } }
      ]
    }).select('name email avatar role').limit(20);

    res.json({ success: true, users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Admin)
router.get('/', protect, authorize('admin'), getUsers);

// @desc    Get students
// @route   GET /api/users/students
// @access  Private (Admin)
router.get('/students', protect, authorize('admin'), getStudents);

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', protect, getProfile);

// @desc    Update current user profile
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', protect, requireStudentNotRestricted('changeProfile'), uploadAvatar.single('avatar'), handleMulterError, scanFile, [
  body('phone').optional().trim()
    .matches(/^09\d{8}$/)
    .withMessage('Phone number must be 10 digits starting with 09'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('Country cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('Country can only contain letters and spaces'),
  body('city').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('City cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('City can only contain letters and spaces'),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('School cannot exceed 20 characters').matches(/^[\p{L}\s]+$/u).withMessage('School can only contain letters and spaces')
], updateProfile);

// @desc    Request email change (one-time, sends verification code to new email)
// @route   POST /api/users/change-email/request
// @access  Private
router.post('/change-email/request', protect, requireStudentNotRestricted('changeProfile'), requestEmailChange);

// @desc    Verify email change using verification code
// @route   POST /api/users/change-email/verify
// @access  Private
router.post('/change-email/verify', protect, requireStudentNotRestricted('changeProfile'), verifyEmailChange);

// @desc    Delete current user account
// @route   DELETE /api/users/account
// @access  Private
router.delete('/account', protect, requireStudentNotRestricted('changeSettings'), deleteAccount);

// @desc    Get admin contact
// @route   GET /api/users/admin
// @access  Private (Student)
router.get('/admin', protect, authorize('student', 'instructor'), getAdmin);

// @desc    Get instructors
// @route   GET /api/users/instructors
// @access  Private (Admin)
router.get('/instructors', protect, authorize('admin'), getInstructors);

// @desc    Get pending instructors
// @route   GET /api/users/instructors/pending
// @access  Private (Admin)
router.get('/instructors/pending', protect, authorize('admin'), getPendingInstructors);

// @desc    Get pending registrations
// @route   GET /api/users/pending-registrations
// @access  Private (Admin)
router.get('/pending-registrations', protect, authorize('admin'), getPendingRegistrations);

// @desc    Delete pending registration
// @route   DELETE /api/users/pending-registrations/:id
// @access  Private (Admin)
router.delete('/pending-registrations/:id', protect, authorize('admin'), deletePendingRegistration);

// @desc    Approve instructor
// @route   PUT /api/users/instructors/:id/approve
// @access  Private (Admin)
router.put('/instructors/:id/approve', protect, authorize('admin'), approveInstructor);

// @desc    Reject instructor
// @route   PUT /api/users/instructors/:id/reject
// @access  Private (Admin)
router.put('/instructors/:id/reject', protect, authorize('admin'), rejectInstructor);

// @desc    Toggle instructor trust status (auto-approve courses)
// @route   PUT /api/users/instructor/:id/trust
// @access  Private (Admin)
router.put('/instructor/:id/trust', protect, authorize('admin'), toggleInstructorTrust);

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (Admin)
router.get('/:id', protect, authorize('admin'), getUser);

// @desc    Get user enrollments
// @route   GET /api/users/:id/enrollments
// @access  Private (Admin)
router.get('/:id/enrollments', protect, authorize('admin'), getUserEnrollments);

// @desc    Create user
// @route   POST /api/users
// @access  Private (Admin)
router.post('/', protect, authorize('admin'), [
  body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['student', 'instructor', 'admin']).withMessage('Invalid role')
], createUser);

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Admin)
router.put('/:id', protect, authorize('admin'), updateUser);

// @desc    Reset email/phone change limits
// @route   PUT /api/users/:id/reset-change-limits
// @access  Private (Admin)
router.put('/:id/reset-change-limits', protect, authorize('admin'), resetChangeLimits);

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Admin)
router.delete('/:id', protect, authorize('admin'), deleteUser);

// @desc    Send message to user
// @route   POST /api/users/:id/message
// @access  Private (Admin)
router.post('/:id/message', protect, authorize('admin'), [
  body('subject').trim().isLength({ min: 2 }).withMessage('Subject must be at least 2 characters'),
  body('content').trim().isLength({ min: 10 }).withMessage('Content must be at least 10 characters')
], sendMessageToUser);

// @desc    Ban user account
// @route   PUT /api/users/:id/ban
// @access  Private (Admin)
router.put('/:id/ban', protect, authorize('admin'), [
  body('reason').trim().isLength({ min: 5 }).withMessage('Ban reason must be at least 5 characters')
], banUser);

// @desc    Unban user account
// @route   PUT /api/users/:id/unban
// @access  Private (Admin)
router.put('/:id/unban', protect, authorize('admin'), unbanUser);

// @desc    Suspend user account
// @route   PUT /api/users/:id/suspend
// @access  Private (Admin)
router.put('/:id/suspend', protect, authorize('admin'), [
  body('reason').trim().isLength({ min: 5 }).withMessage('Suspension reason must be at least 5 characters')
], suspendUser);

// @desc    Unsuspend user account
// @route   PUT /api/users/:id/unsuspend
// @access  Private (Admin)
router.put('/:id/unsuspend', protect, authorize('admin'), unsuspendUser);

module.exports = router;
