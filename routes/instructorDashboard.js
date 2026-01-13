const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getPendingSummary } = require('../controllers/instructorDashboard');

// @desc    Get instructor pending actions summary
// @route   GET /api/instructor/pending-summary
// @access  Private (Instructor)
router.get('/pending-summary', protect, authorize('instructor'), getPendingSummary);

module.exports = router;
