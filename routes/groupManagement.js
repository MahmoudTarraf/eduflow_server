const express = require('express');
const router = express.Router();
const { protect, authorize, requireInstructorNotRestricted } = require('../middleware/auth');
const {
  getGroupsByCourse,
  createGroup,
  updateGroup,
  deleteGroup,
  archiveGroup
} = require('../controllers/groupManagement');
const { requestGroupDelete } = require('../controllers/deleteRequests');

// Course-level routes
router.get('/courses/:courseId/groups', protect, getGroupsByCourse); // Allow all authenticated users to view groups
router.post('/courses/:courseId/groups', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), createGroup);

// Group-level routes
router.put('/groups/:groupId', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), updateGroup);
router.patch('/groups/:groupId/archive', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), archiveGroup);
router.delete('/groups/:groupId', protect, authorize('admin'), deleteGroup);
router.post('/groups/:groupId/request-delete', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('manageGroupsSections'), requestGroupDelete);

module.exports = router;
