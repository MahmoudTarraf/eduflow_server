const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const {
  getProgressBySection,
  getProgressByGroup,
  getAllStudentsProgressBySection,
  getAllStudentsProgressByGroup,
  getStudentDetailedProgress
} = require('../controllers/progress');

// Protected routes
router.use(protect);

// Student routes
router.get('/section/:sectionId', authorize('student'), requireStudentNotRestricted('continueCourses'), getProgressBySection);
router.get('/group/:groupId', authorize('student'), requireStudentNotRestricted('continueCourses'), getProgressByGroup);

// Instructor/Admin routes
router.get('/section/:sectionId/all', authorize('instructor', 'admin'), getAllStudentsProgressBySection);
router.get('/group/:groupId/all', authorize('instructor', 'admin'), getAllStudentsProgressByGroup);
router.get('/student/:studentId/group/:groupId', authorize('instructor', 'admin'), getStudentDetailedProgress);

module.exports = router;
