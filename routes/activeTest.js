const express = require('express');
const router = express.Router();
const {
  createTest,
  getTestsBySection,
  getTest,
  updateTest,
  deleteTest,
  startTest,
  submitTest,
  getTestAttempts,
  getSingleAttempt,
  getTestStatistics,
  resetStudentAttempts
} = require('../controllers/activeTest');
const { protect, authorize, requireInstructorNotRestricted, requireStudentNotRestricted } = require('../middleware/auth');

// Instructor routes
router.post('/', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageActiveTests'), createTest);
router.put('/:id', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageActiveTests'), updateTest);
router.delete('/:id', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageActiveTests'), deleteTest);
router.get('/:id/statistics', protect, authorize('instructor', 'admin'), getTestStatistics);
router.delete('/:id/attempts/:studentId', protect, authorize('instructor', 'admin'), resetStudentAttempts);

// Student routes
router.post('/:testId/start', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), startTest);
router.post('/:testId/submit', protect, authorize('student'), requireStudentNotRestricted('continueCourses'), submitTest);

// Both instructor and student routes
router.get('/section/:sectionId', protect, getTestsBySection);
router.get('/attempts/:attemptId', protect, getSingleAttempt);
router.get('/:id', protect, getTest);
router.get('/:id/attempts', protect, getTestAttempts);

module.exports = router;
