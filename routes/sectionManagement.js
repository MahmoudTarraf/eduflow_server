const express = require('express');
const router = express.Router();
const { protect, authorize, requireInstructorNotRestricted } = require('../middleware/auth');
const {
  getSectionsByGroup,
  createSection,
  updateSection,
  deleteSection
} = require('../controllers/sectionManagement');

// Group-level routes
router.get('/groups/:groupId/sections', protect, getSectionsByGroup);
router.post('/groups/:groupId/sections', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), createSection);

// Section-level routes
router.put('/sections/:sectionId', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), updateSection);
router.delete('/sections/:sectionId', protect, authorize('admin'), deleteSection);

module.exports = router;
