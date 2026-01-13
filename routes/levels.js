const express = require('express');
const router = express.Router();
const {
  getLevels,
  getLevel,
  createLevel,
  updateLevel,
  deleteLevel,
  getLevelStats,
  getAllLevelsAdmin
} = require('../controllers/levels');

const { protect, authorize } = require('../middleware/auth');

// Public routes
router.get('/', getLevels);

// Admin routes (must be before /:id to avoid conflicts)
router.get('/admin/all', protect, authorize('admin'), getAllLevelsAdmin);
router.get('/:id/stats', protect, authorize('admin'), getLevelStats);

// Public single level route
router.get('/:id', getLevel);

// Admin and Instructor routes
router.post('/', protect, authorize('admin', 'instructor'), createLevel);
router.put('/:id', protect, authorize('admin'), updateLevel);
router.delete('/:id', protect, authorize('admin'), deleteLevel);

module.exports = router;
