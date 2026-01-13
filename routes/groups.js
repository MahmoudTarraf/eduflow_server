const express = require('express');
const { body } = require('express-validator');
const {
  getGroups,
  getGroup,
  getGroupEnrollmentInfo,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupStudents,
  approveStudent,
  rejectStudent,
  addGroupContent,
  deleteGroupContent,
  enrollInGroup,
  removeStudent,
  confirmPayment,
  getPendingPayments,
  paySectionPayment
} = require('../controllers/groups');
const { protect, authorize, requireApprovedInstructor, requireStudentNotRestricted, requireInstructorNotRestricted } = require('../middleware/auth');
const { upload, handleMulterError } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');

const router = express.Router();

// @desc    Get all groups
// @route   GET /api/groups
// @access  Private (Admin/Instructor)
router.get('/', protect, authorize('admin', 'instructor'), getGroups);

// @desc    Get all pending payments
// @route   GET /api/groups/pending-payments
// @access  Private (Admin/Instructor)
// IMPORTANT: This must come BEFORE /:id route to avoid casting "pending-payments" as ObjectId
router.get('/pending-payments', protect, authorize('admin', 'instructor'), getPendingPayments);

// @desc    Get group enrollment info (public)
// @route   GET /api/groups/:id/enrollment-info
// @access  Public
router.get('/:id/enrollment-info', getGroupEnrollmentInfo);

// @desc    Get single group
// @route   GET /api/groups/:id
// @access  Private (Admin/Instructor)
router.get('/:id', protect, authorize('admin', 'instructor'), getGroup);

// @desc    Create group
// @route   POST /api/groups
// @access  Private (Admin/Instructor)
router.post('/', protect, authorize('admin', 'instructor'), requireApprovedInstructor, requireInstructorNotRestricted('manageGroupsSections'), [
  body('name').trim().isLength({ min: 2 }).withMessage('Group name must be at least 2 characters'),
  body('course').notEmpty().withMessage('Course is required'),
  body('level').isIn(['beginner', 'intermediate', 'advanced', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']).withMessage('Invalid level'),
  body('maxStudents').isInt({ min: 1 }).withMessage('Max students must be at least 1'),
  body('startDate').isISO8601().withMessage('Valid start date is required'),
  body('endDate').isISO8601().withMessage('Valid end date is required'),
  // instructor is optional; when instructor creates, it is taken from token
  body('instructor').optional()
], createGroup);

// @desc    Update group
// @route   PUT /api/groups/:id
// @access  Private (Admin/Instructor - own groups only)
router.put('/:id', protect, authorize('admin', 'instructor'), requireInstructorNotRestricted('manageGroupsSections'), updateGroup);

// @desc    Delete group
// @route   DELETE /api/groups/:id
// @access  Private (Admin only)
router.delete('/:id', protect, authorize('admin'), deleteGroup);

// @desc    Add content to group
// @route   POST /api/groups/:id/content
// @access  Private (Admin/Instructor)
router.post(
  '/:id/content',
  protect,
  authorize('admin', 'instructor'),
  requireApprovedInstructor,
  requireInstructorNotRestricted('manageGroupsSections'),
  upload.single('file'), // Handle file upload
  handleMulterError,
  scanFile,
  [
    body('type').isIn(['video', 'assignment', 'project']).withMessage('Invalid content type'),
    body('title').trim().isLength({ min: 2 }).withMessage('Title is required'),
    body('url').optional().isString(),
    body('priceFlag').optional().isIn(['free', 'paid']),
    body('price').optional().isFloat({ min: 0 })
  ],
  addGroupContent
);

// @desc    Delete content from group
// @route   DELETE /api/groups/:id/content/:contentId
// @access  Private (Admin only)
router.delete(
  '/:id/content/:contentId',
  protect,
  authorize('admin'),
  deleteGroupContent
);

// @desc    Enroll student to group
// @route   POST /api/groups/:id/enroll
// @access  Private (Student)
router.post('/:id/enroll', protect, authorize('student'), requireStudentNotRestricted('enrollNewCourses'), [
  body('paymentMethod').optional().isString().withMessage('Invalid payment method'),
  body('receiptUrl').optional().isString()
], enrollInGroup);

// @desc    Confirm payment for student
// @route   POST /api/groups/:id/confirmPayment
// @access  Private (Admin/Instructor)
router.post(
  '/:id/confirmPayment',
  protect,
  authorize('admin', 'instructor'),
  requireApprovedInstructor,
  [
    body('studentId').notEmpty().withMessage('Student ID is required'),
    body('action').isIn(['verify', 'reject']).withMessage('Action must be verify or reject'),
    body('month').optional().isString(),
    body('type').optional().isString(),
    body('sectionId').optional().isString()
  ],
  confirmPayment
);

// @desc    Submit section payment
// @route   POST /api/groups/:id/paySection
// @access  Private (Student)
router.post(
  '/:id/paySection',
  protect,
  authorize('student'),
  [
    body('sectionId').notEmpty().withMessage('Section ID is required'),
    body('paymentMethod').isString().withMessage('Invalid payment method'),
    body('receiptUrl').notEmpty().withMessage('Receipt URL is required')
  ],
  paySectionPayment
);

// @desc    Remove student from group
// @route   DELETE /api/groups/:id/students/:studentId
// @access  Private (Admin/Instructor)
router.delete(
  '/:id/students/:studentId',
  protect,
  authorize('admin', 'instructor'),
  requireApprovedInstructor,
  requireInstructorNotRestricted('removeStudents'),
  removeStudent
);

// @desc    Get group students
// @route   GET /api/groups/:id/students
// @access  Private (Admin/Instructor)
router.get('/:id/students', protect, authorize('admin', 'instructor'), getGroupStudents);

// @desc    Approve student enrollment
// @route   PUT /api/groups/:id/students/:studentId/approve
// @access  Private (Admin)
router.put('/:id/students/:studentId/approve', protect, authorize('admin'), approveStudent);

// @desc    Reject student enrollment
// @route   PUT /api/groups/:id/students/:studentId/reject
// @access  Private (Admin)
router.put('/:id/students/:studentId/reject', protect, authorize('admin'), rejectStudent);

module.exports = router;
