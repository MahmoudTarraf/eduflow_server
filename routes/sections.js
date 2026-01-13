const express = require('express');
const router = express.Router();
const { protect, authorize, requireInstructorNotRestricted, requireStudentNotRestricted } = require('../middleware/auth');
const {
  getSectionsByGroup,
  getSectionById,
  createSection,
  updateSection,
  deleteSection,
  checkSectionAccess
} = require('../controllers/sections');
const { requestSectionDelete } = require('../controllers/deleteRequests');

// Public routes (none)

// Protected routes - All users
router.use(protect);

// Get sections by group
router.get('/group/:groupId', requireStudentNotRestricted('accessCoursePages'), getSectionsByGroup);

// Get single section
router.get('/:id', requireStudentNotRestricted('accessCoursePages'), getSectionById);

// Check section access (students)
router.get('/:id/access', authorize('student'), requireStudentNotRestricted('accessCoursePages'), checkSectionAccess);

// Instructor/Admin only routes
router.post('/', authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), createSection);
router.put('/:id', authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), updateSection);

// Request delete section (instructor or admin)
router.post('/:id/request-delete', authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), requestSectionDelete);

// Delete section (admin only - permanent)
router.delete('/:id', authorize('admin'), deleteSection);

module.exports = router;
