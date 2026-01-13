const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted, requireInstructorNotRestricted } = require('../middleware/auth');
const { uploadAssignment, handleMulterError } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');
const {
  recordWatched,
  submitAssignment,
  gradeContent,
  getSectionGrade,
  getCourseGrade,
  getContentSubmissions,
  downloadSubmission,
  requestReupload,
  approveReupload,
  rejectReupload,
  getPendingReuploadRequests
} = require('../controllers/grading');

// @desc    Record video watched
// @route   POST /api/contents/:contentId/watched
// @access  Private (Student)
router.post('/contents/:contentId/watched', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), recordWatched);

// @desc    Submit assignment (.rar file)
// @route   POST /api/contents/:contentId/submission
// @access  Private (Student)
router.post(
  '/contents/:contentId/submission',
  protect,
  authorize('student'),
  requireStudentNotRestricted('continueCourses'),
  uploadAssignment.single('assignment'),
  handleMulterError,
  scanFile,
  submitAssignment
);

// @desc    Request reupload for assignment/project
// @route   POST /api/contents/:contentId/reupload/request
// @access  Private (Student)
router.post('/contents/:contentId/reupload/request', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), requestReupload);

// @desc    Approve reupload request
// @route   POST /api/contents/:contentId/reupload/approve
// @access  Private (Instructor/Admin)
router.post('/contents/:contentId/reupload/approve', protect, authorize('instructor', 'admin'), approveReupload);

// @desc    Reject reupload request
// @route   POST /api/contents/:contentId/reupload/reject
// @access  Private (Instructor/Admin)
router.post('/contents/:contentId/reupload/reject', protect, authorize('instructor', 'admin'), rejectReupload);

// @desc    Grade assignment/project (instructor/admin)
// @route   POST /api/contents/:contentId/grade
// @access  Private (Instructor/Admin)
router.post('/contents/:contentId/grade', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('gradeAssignments'), gradeContent);

// @desc    Get submissions for a content item
// @route   GET /api/contents/:contentId/submissions
// @access  Private (Instructor/Admin)
router.get('/contents/:contentId/submissions', protect, authorize('instructor', 'admin'), getContentSubmissions);

// @desc    Get section grade for a student
// @route   GET /api/students/:studentId/sections/:sectionId/grade
// @access  Private
router.get('/students/:studentId/sections/:sectionId/grade', protect, getSectionGrade);

// @desc    Get pending submissions for instructor
// @route   GET /api/grading/pending
// @access  Private (Instructor/Admin)
router.get('/grading/pending', protect, authorize('instructor', 'admin'), async (req, res) => {
  try {
    let courseQuery = {};
    
    // If instructor, only get their courses
    if (req.user.role === 'instructor') {
      courseQuery.instructor = req.user.id;
    }
    
    // Get courses for this user
    const Course = require('../models/Course');
    const courses = await Course.find(courseQuery);
    const courseIds = courses.map(course => course._id);
    
    // Get pending assignments (submitted but not graded)
    const StudentContentGrade = require('../models/StudentContentGrade');
    const pendingGrades = await StudentContentGrade.find({
      course: { $in: courseIds },
      status: { $in: ['submitted_pending_grading', 'submitted_ungraded'] },
      content: { $exists: true }
    })
    .populate('student', 'name email')
    .populate('content', 'title type')
    .populate('course', 'name')
    .sort({ submittedAt: -1 });
    
    res.json({
      success: true,
      count: pendingGrades.length,
      pendingGrades
    });
  } catch (error) {
    console.error('Get pending grades error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @desc    Get pending reupload requests for instructor/admin
// @route   GET /api/grading/reuploads/pending
// @access  Private (Instructor/Admin)
router.get('/grading/reuploads/pending', protect, authorize('instructor', 'admin'), getPendingReuploadRequests);

// @desc    Get course grade for a student
// @route   GET /api/students/:studentId/courses/:courseId/grade
// @access  Private
router.get('/students/:studentId/courses/:courseId/grade', protect, getCourseGrade);

// @desc    Download student submission
// @route   GET /api/grading/submissions/:gradeId/download
// @access  Private (Instructor/Admin)
router.get('/grading/submissions/:gradeId/download', protect, authorize('instructor', 'admin'), downloadSubmission);

module.exports = router;
