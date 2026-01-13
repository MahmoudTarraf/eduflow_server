const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const {
  markCompleted,
  updateWatchProgress,
  getStudentProgressForSection,
  getStudentProgressForGroup,
  getAllStudentsProgress
} = require('../controllers/progressManagement');

// Student progress routes
router.post('/progress/markCompleted', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), markCompleted);
router.post('/progress/updateWatch', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), updateWatchProgress);

// Get progress routes
router.get('/progress/student/:studentId/section/:sectionId', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), getStudentProgressForSection);
router.get('/progress/student/:studentId/group/:groupId', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), getStudentProgressForGroup);

// Instructor/Admin view all students
router.get('/groups/:groupId/students/progress', protect, authorize('instructor', 'admin'), getAllStudentsProgress);

module.exports = router;
