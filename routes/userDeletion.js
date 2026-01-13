const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  deleteStudent,
  deleteInstructor,
  getDeletionPreview
} = require('../controllers/userDeletion');

// All routes are admin only
router.use(protect);
router.use(authorize('admin'));

// Get deletion preview
router.get('/:userId/deletion-preview', getDeletionPreview);

// Delete student
router.delete('/student/:userId', deleteStudent);

// Delete instructor (with optional deleteCourses parameter)
router.delete('/instructor/:userId', deleteInstructor);

module.exports = router;
