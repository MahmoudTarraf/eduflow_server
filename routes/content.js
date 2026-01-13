const express = require('express');
const router = express.Router();
const { protect, authorize, requireInstructorNotRestricted, requireStudentNotRestricted } = require('../middleware/auth');
const { uploadFile, handleMulterError } = require('../middleware/upload');
const { uploadLectureVideo, uploadProjectFiles } = require('../middleware/uploadDynamic');
const scanFile = require('../middleware/scanFile');
const {
  getContentBySection,
  getContentById,
  uploadLecture,
  uploadAssignment,
  uploadProject,
  updateContent,
  assignHostedVideoUrl,
  deleteContent,
  markAsCompleted,
  markVideoWatched,
  updateWatchProgress,
  downloadContentFile,
  submitStudentAssignment
} = require('../controllers/content');
const { requestContentDelete } = require('../controllers/deleteRequests');

// Protected routes - All users
router.use(protect);

// Get content by section
router.get('/section/:sectionId', getContentBySection);

// Get single content
router.get('/:id', getContentById);

// Student routes
router.post('/:id/complete', authorize('student'), requireStudentNotRestricted('continueCourses'), markAsCompleted);
router.post('/:id/watched', authorize('student'), requireStudentNotRestricted('continueCourses'), markVideoWatched);
router.post('/:id/progress', authorize('student'), requireStudentNotRestricted('continueCourses'), updateWatchProgress);
// Download route - accessible by students, instructors, and admins
router.get('/:id/download', authorize('student', 'instructor', 'admin'), downloadContentFile);
router.post(
  '/:id/submission',
  authorize('student'),
  requireStudentNotRestricted('continueCourses'),
  uploadFile.single('assignment'),
  handleMulterError,
  scanFile,
  submitStudentAssignment
);

// Instructor/Admin routes - Upload
router.post(
  '/lecture',
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteLectures'),
  uploadLectureVideo.single('video'),
  handleMulterError,
  scanFile,
  uploadLecture
);

router.post(
  '/assignment',
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  uploadFile.single('file'),
  handleMulterError,
  scanFile,
  uploadAssignment
);

router.post(
  '/project',
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  uploadProjectFiles.fields([
    { name: 'video', maxCount: 1 },
    { name: 'file', maxCount: 1 }
  ]),
  handleMulterError,
  scanFile,
  uploadProject
);

// Instructor/Admin routes - Update/Delete
router.put(
  '/:id',
  authorize('instructor', 'admin'),
  async (req, res, next) => {
    try {
      const Content = require('../models/Content');
      const content = await Content.findById(req.params.id).select('type');
      if (!content) {
        return res.status(404).json({ success: false, message: 'Content not found' });
      }

      // Use dynamic upload middlewares with correct field names and higher limits
      let middleware;
      if (content.type === 'lecture') {
        const { uploadLectureVideo } = require('../middleware/uploadDynamic');
        middleware = uploadLectureVideo.single('video');
      } else if (content.type === 'assignment') {
        const { uploadAssignmentFile } = require('../middleware/uploadDynamic');
        middleware = uploadAssignmentFile.single('file');
      } else if (content.type === 'project') {
        const { uploadProjectFiles } = require('../middleware/uploadDynamic');
        middleware = uploadProjectFiles.fields([
          { name: 'video', maxCount: 1 },
          { name: 'file', maxCount: 1 }
        ]);
      } else {
        return next();
      }
      return middleware(req, res, next);
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Error processing update', error: error.message });
    }
  },
  handleMulterError,
  scanFile,
  requireInstructorNotRestricted('createEditDeleteLectures'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  updateContent
);

router.put('/:id/assign-hosted-url', authorize('admin'), assignHostedVideoUrl);

// Request delete (instructor -> admin approval)
router.post('/:id/request-delete', authorize('instructor', 'admin'), requireInstructorNotRestricted('createEditDeleteLectures'), requireInstructorNotRestricted('createEditDeleteAssignments'), requestContentDelete);

// Actual delete (admin only)
router.delete('/:id', authorize('admin'), deleteContent);

module.exports = router;
