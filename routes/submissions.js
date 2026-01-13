const express = require('express');
const { body } = require('express-validator');
const {
  getSubmissions,
  getSubmission,
  createSubmission,
  updateSubmission,
  gradeSubmission,
  deleteSubmission
} = require('../controllers/submissions');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @desc    Get submissions
// @route   GET /api/submissions
// @access  Private
router.get('/', protect, getSubmissions);

// @desc    Get single submission
// @route   GET /api/submissions/:id
// @access  Private
router.get('/:id', protect, getSubmission);

// @desc    Create submission
// @route   POST /api/submissions
// @access  Private (Student)
router.post('/', protect, authorize('student'), [
  body('course').notEmpty().withMessage('Course is required'),
  body('group').notEmpty().withMessage('Group is required'),
  body('type').isIn(['assignment', 'project']).withMessage('Invalid submission type'),
  body('assignment').optional().notEmpty().withMessage('Assignment is required for assignment submissions'),
  body('project').optional().notEmpty().withMessage('Project is required for project submissions')
], createSubmission);

// @desc    Update submission
// @route   PUT /api/submissions/:id
// @access  Private (Student)
router.put('/:id', protect, authorize('student'), updateSubmission);

// @desc    Grade submission
// @route   PUT /api/submissions/:id/grade
// @access  Private (Instructor/Admin)
router.put('/:id/grade', protect, authorize('instructor', 'admin'), [
  body('score').isFloat({ min: 0, max: 100 }).withMessage('Score must be between 0 and 100'),
  body('feedback').optional().trim()
], gradeSubmission);

// @desc    Delete submission
// @route   DELETE /api/submissions/:id
// @access  Private (Student)
router.delete('/:id', protect, authorize('student'), deleteSubmission);

module.exports = router;
