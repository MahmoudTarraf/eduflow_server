const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getDeleteRequests,
  updateDeleteRequest
} = require('../controllers/deleteRequests');

// Admin view of all delete requests
// @route   GET /api/delete-requests
// @access  Private (Admin)
router.get('/delete-requests', protect, authorize('admin'), getDeleteRequests);

// Admin approve/reject a delete request
// @route   PATCH /api/delete-requests/:id
// @access  Private (Admin)
router.patch('/delete-requests/:id', protect, authorize('admin'), updateDeleteRequest);

module.exports = router;
