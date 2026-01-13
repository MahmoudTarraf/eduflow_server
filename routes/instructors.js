const express = require('express');
const {
  getPublicInstructors,
  getInstructorProfile
} = require('../controllers/instructors');

const router = express.Router();

// @desc    Get all approved instructors (public)
// @route   GET /api/instructors/public
// @access  Public
router.get('/public', getPublicInstructors);

// @desc    Get instructor profile (public)
// @route   GET /api/instructors/:id
// @access  Public
router.get('/:id', getInstructorProfile);

module.exports = router;
