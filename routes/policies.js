const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getPoliciesAdmin,
  updatePolicy,
  getPolicyPublic
} = require('../controllers/policies');

// Public route to fetch policy content by type
router.get('/public/:type', getPolicyPublic);

// Admin routes
router.get('/', protect, authorize('admin'), getPoliciesAdmin);
router.put('/:type', protect, authorize('admin'), updatePolicy);

module.exports = router;
