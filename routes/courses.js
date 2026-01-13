const express = require('express');
const { body } = require('express-validator');
const {
  getCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  archiveCourse,
  enrollInCourse,
  getEnrolledCourses,
  getCourseProgress,
  updateProgress,
  searchCourses,
  getInstructorCourses,
  getCourseSummary,
  getCourseGradebook,
  getPendingCourses,
  approveCourse,
  rejectCourse,
  confirmCostChangeAuto,
  cancelCostChange,
  getPendingCostChange,
  requestDiscount,
  approveDiscount,
  rejectDiscount,
  disableDiscount,
  getPendingDiscounts,
  getAllDiscounts,
  deleteDiscount,
  getAllCoursesAdmin,
  reassignCourseInstructor
} = require('../controllers/courses');
const { requestCourseDelete } = require('../controllers/deleteRequests');
const { protect, authorize, checkEnrollment, requireApprovedInstructor, checkSuspension, optionalProtect, requireStudentNotRestricted, requireInstructorNotRestricted } = require('../middleware/auth');

const router = express.Router();

// @desc    Get pending courses (Admin)
// @route   GET /api/courses/pending
// @access  Private (Admin)
router.get('/pending', protect, authorize('admin'), getPendingCourses);

// @desc    Get instructor's courses
// @route   GET /api/courses/my-courses
// @access  Private (Instructor)
router.get('/my-courses', protect, authorize('instructor', 'admin'), getInstructorCourses);

// @desc    Get all courses
// @route   GET /api/courses
// @access  Public
router.get('/', getCourses);

// @desc    Get all courses for admin (including archived)
// @route   GET /api/courses/all
// @access  Private (Admin)
router.get('/all', protect, authorize('admin'), getAllCoursesAdmin);

// @desc    Reassign course owner (Admin)
// @route   PUT /api/courses/:id/reassign-instructor
// @access  Private (Admin)
router.put('/:id/reassign-instructor', protect, authorize('admin'), reassignCourseInstructor);

// @desc    Search courses
// @route   GET /api/courses/search
// @access  Public
router.get('/search', searchCourses);

// @desc    Get enrolled courses
// @route   GET /api/courses/enrolled
// @access  Private (Student)
router.get('/enrolled', protect, authorize('student'), requireStudentNotRestricted('accessCoursePages'), getEnrolledCourses);

// @desc    Get course summary
// @route   GET /api/courses/:id/summary
// @access  Private (Student)
router.get('/:id/summary', protect, authorize('student'), requireStudentNotRestricted('accessCoursePages'), getCourseSummary);

// @desc    Get course gradebook
// @route   GET /api/courses/:id/grades
// @access  Private (Instructor/Admin)
router.get('/:id/grades', protect, authorize('instructor', 'admin'), getCourseGradebook);

// @desc    Get single course
// @route   GET /api/courses/:id
// @access  Public (auth optional to allow archived visibility rules)
router.get('/:id', optionalProtect, requireStudentNotRestricted('accessCoursePages'), getCourse);

// @desc    Create course
// @route   POST /api/courses
// @access  Private (Admin/Instructor)
router.post('/', protect, authorize('admin', 'instructor'), requireApprovedInstructor, requireInstructorNotRestricted('createEditDeleteCourses'), [
  body('name').trim().isLength({ min: 2 }).withMessage('Course name must be at least 2 characters'),
  body('description').trim().isLength({ min: 10 }).withMessage('Description must be at least 10 characters'),
  body('category').custom(async (value) => {
    const Category = require('../models/Category');
    const category = await Category.findOne({ slug: value });
    if (!category) {
      throw new Error('Invalid category - category does not exist');
    }
    return true;
  }),
  body('level').isString().trim().isLength({ min: 1 }).withMessage('Invalid level'),
  body('duration').isInt({ min: 1 }).withMessage('Duration must be at least 1 week'),
  body('cost').isFloat({ min: 0 }).withMessage('Cost cannot be negative')
], createCourse);

// @desc    Update course
// @route   PUT /api/courses/:id
// @access  Private (Admin/Instructor)
router.put('/:id', protect, authorize('admin', 'instructor'), requireApprovedInstructor, requireInstructorNotRestricted('createEditDeleteCourses'), updateCourse);

// @desc    Archive or unarchive course
// @route   PATCH /api/courses/:id/archive
// @access  Private (Admin/Instructor - own courses only)
router.patch('/:id/archive', protect, authorize('admin', 'instructor'), requireInstructorNotRestricted('createEditDeleteCourses'), archiveCourse);

// @desc    Request delete course (instructor -> admin approval)
// @route   POST /api/courses/:id/request-delete
// @access  Private (Instructor/Admin)
router.post('/:id/request-delete', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('createEditDeleteCourses'), requestCourseDelete);

// @desc    Delete course
// @route   DELETE /api/courses/:id
// @access  Private (Admin only)
router.delete('/:id', protect, authorize('admin'), deleteCourse);

// @desc    Enroll in course
// @route   POST /api/courses/:id/enroll
// @access  Private (Student)
router.post('/:id/enroll', protect, authorize('student'), requireStudentNotRestricted('enrollNewCourses'), [
  body('group').notEmpty().withMessage('Group selection is required')
], enrollInCourse);

// @desc    Get course progress
// @route   GET /api/courses/:id/progress
// @access  Private (Student)
router.get('/:id/progress', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), checkEnrollment, getCourseProgress);

// @desc    Update course progress
// @route   PUT /api/courses/:id/progress
// @access  Private (Student)
router.put('/:id/progress', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), checkEnrollment, updateProgress);

// @desc    Approve course (Admin)
// @route   PUT /api/courses/:id/approve
// @access  Private (Admin)
router.put('/:id/approve', protect, authorize('admin'), approveCourse);

// @desc    Reject course (Admin)
// @route   PUT /api/courses/:id/reject
// @access  Private (Admin)
router.put('/:id/reject', protect, authorize('admin'), rejectCourse);

// @desc    Get pending cost change
// @route   GET /api/courses/cost-change/:pendingChangeId
// @access  Private (Instructor/Admin)
router.get('/cost-change/:pendingChangeId', protect, authorize('instructor', 'admin'), getPendingCostChange);

// @desc    Confirm cost change with auto-adjust
// @route   POST /api/courses/cost-change/:pendingChangeId/confirm-auto
// @access  Private (Instructor)
router.post('/cost-change/:pendingChangeId/confirm-auto', protect, authorize('instructor'), confirmCostChangeAuto);

// @desc    Cancel cost change
// @route   POST /api/courses/cost-change/:pendingChangeId/cancel
// @access  Private (Instructor)
router.post('/cost-change/:pendingChangeId/cancel', protect, authorize('instructor'), cancelCostChange);

// Discount Routes

// @desc    Get pending discount requests (Admin)
// @route   GET /api/courses/discounts/pending
// @access  Private (Admin)
router.get('/discounts/pending', protect, authorize('admin'), getPendingDiscounts);

// @desc    Get all discounts (Admin)
// @route   GET /api/courses/discounts/all
// @access  Private (Admin)
router.get('/discounts/all', protect, authorize('admin'), getAllDiscounts);

// @desc    Request course discount
// @route   POST /api/courses/:id/discount/request
// @access  Private (Instructor)
router.post('/:id/discount/request', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('createDisableDiscounts'), requestDiscount);

// @desc    Approve course discount (Admin)
// @route   PUT /api/courses/:id/discount/approve
// @access  Private (Admin)
router.put('/:id/discount/approve', protect, authorize('admin'), approveDiscount);

// @desc    Reject course discount (Admin)
// @route   PUT /api/courses/:id/discount/reject
// @access  Private (Admin)
router.put('/:id/discount/reject', protect, authorize('admin'), rejectDiscount);

// @desc    Disable course discount (Instructor)
// @route   PUT /api/courses/:id/discount/disable
// @access  Private (Instructor)
router.put('/:id/discount/disable', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('createDisableDiscounts'), disableDiscount);

// @desc    Delete discount completely (Admin)
// @route   DELETE /api/courses/:id/discount
// @access  Private (Admin)
router.delete('/:id/discount', protect, authorize('admin'), deleteDiscount);

module.exports = router;
