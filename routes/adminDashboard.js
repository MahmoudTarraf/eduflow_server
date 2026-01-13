const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getPendingSummary } = require('../controllers/adminDashboard');

// @desc    Get admin pending actions summary
// @route   GET /api/admin/pending-summary
// @access  Private (Admin)
router.get('/pending-summary', protect, authorize('admin'), getPendingSummary);

module.exports = router;
