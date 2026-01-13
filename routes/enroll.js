const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const { uploadReceipt } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');
const {
  enrollStudent,
  submitSectionPayment,
  getPendingPayments,
  processPayment,
  getEnrolledCourse,
  removeStudentFromCourse
} = require('../controllers/enrollment');

// @desc    Enroll student in a course
// @route   POST /api/enroll
// @access  Private (Student)
router.post('/', protect, authorize('student'), requireStudentNotRestricted('enrollNewCourses'), enrollStudent);

// @desc    Submit payment for a section
// @route   POST /api/enroll/payments
// @access  Private (Student)
router.post(
  '/payments', 
  protect, 
  authorize('student'), 
  requireStudentNotRestricted('continueCourses'),
  uploadReceipt.single('receipt'),
  scanFile,
  submitSectionPayment
);

// @desc    Get pending payments
// @route   GET /api/enroll/payments
// @access  Private (Admin/Instructor)
router.get('/payments', protect, authorize('admin', 'instructor'), getPendingPayments);

// @desc    Process (approve/reject) a payment
// @route   PUT /api/enroll/payments/:id
// @access  Private (Admin/Instructor)
router.put('/payments/:id', protect, authorize('admin', 'instructor'), processPayment);

// @desc    Get enrolled course details
// @route   GET /api/enroll/:courseId
// @access  Private (Student)
router.get('/:courseId', protect, authorize('student'), getEnrolledCourse);

// @desc    Remove student from course
// @route   DELETE /api/enroll/remove
// @access  Private (Instructor/Admin)
router.delete('/remove', protect, authorize('instructor', 'admin'), removeStudentFromCourse);

module.exports = router;
