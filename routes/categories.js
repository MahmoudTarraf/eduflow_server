const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategoryStats,
  getAllCategoriesAdmin
} = require('../controllers/categories');

const { protect, authorize } = require('../middleware/auth');

// Public routes
router.get('/', getCategories);

// Admin routes (must be before /:id to avoid conflicts)
router.get('/admin/all', protect, authorize('admin'), getAllCategoriesAdmin);
router.get('/:id/stats', protect, authorize('admin'), getCategoryStats);

// Public single category route
router.get('/:id', getCategory);

// Admin and Instructor routes
router.post('/', protect, authorize('admin', 'instructor'), createCategory);
router.put('/:id', protect, authorize('admin'), updateCategory);
router.delete('/:id', protect, authorize('admin'), deleteCategory);

module.exports = router;
