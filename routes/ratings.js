const express = require('express');
const { body } = require('express-validator');
const {
  getFeaturedRatings,
  getFeaturedRatingsAdmin,
  updateRatingHomepageVisibility,
  getCourseRatings,
  createRating,
  updateRating,
  deleteRating,
  markHelpful,
  canRateCourse,
  recalculateAllRatings
} = require('../controllers/ratings');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @desc    Get featured ratings for homepage
// @route   GET /api/ratings/featured
// @access  Public
router.get('/featured', getFeaturedRatings);

// @desc    Get featured ratings for homepage (admin view with visibility flags)
// @route   GET /api/ratings/featured-admin
// @access  Private (Admin)
router.get('/featured-admin', protect, authorize('admin'), getFeaturedRatingsAdmin);

// @desc    Get ratings for a course
// @route   GET /api/ratings/course/:courseId
// @access  Public
router.get('/course/:courseId', getCourseRatings);

// @desc    Check if student can rate course
// @route   GET /api/ratings/can-rate/:courseId
// @access  Private (Student)
router.get('/can-rate/:courseId', protect, authorize('student'), canRateCourse);

// @desc    Create rating for a course
// @route   POST /api/ratings
// @access  Private (Student)
router.post('/', protect, authorize('student'), [
  body('course').notEmpty().withMessage('Course ID is required'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 1000 }).withMessage('Review cannot exceed 1000 characters')
], createRating);

// @desc    Update rating
// @route   PUT /api/ratings/:id
// @access  Private (Student - own rating only)
router.put('/:id', protect, authorize('student'), [
  body('rating').optional().isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 1000 }).withMessage('Review cannot exceed 1000 characters')
], updateRating);

// @desc    Delete rating
// @route   DELETE /api/ratings/:id
// @access  Private (Student - own rating only, Admin)
router.delete('/:id', protect, authorize('student', 'admin'), deleteRating);

// @desc    Update homepage visibility for a rating
// @route   PATCH /api/ratings/:id/homepage-visibility
// @access  Private (Admin)
router.patch('/:id/homepage-visibility', protect, authorize('admin'), updateRatingHomepageVisibility);

// @desc    Mark rating as helpful
// @route   POST /api/ratings/:id/helpful
// @access  Private
router.post('/:id/helpful', protect, markHelpful);

// @desc    Recalculate all course ratings (Admin utility)
// @route   POST /api/ratings/recalculate
// @access  Private (Admin)
router.post('/recalculate', protect, authorize('admin'), recalculateAllRatings);

module.exports = router;
