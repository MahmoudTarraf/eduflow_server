const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { getFileProvider } = require('../services/storage');
const TelegramFile = require('../models/TelegramFile');
const StudentContentGrade = require('../models/StudentContentGrade');
const { streamTelegramFile } = require('../services/telegramFileService');
const { protect, protectAllowQuery, authorize, requireInstructorNotRestricted } = require('../middleware/auth');
const { uploadLectureVideo, uploadAssignmentFile, uploadProjectFiles, uploadSolutionFile, handleDynamicUploadError } = require('../middleware/uploadDynamic');
const scanFile = require('../middleware/scanFile');
const {
  getContentBySection,
  uploadLecture,
  uploadAssignment,
  uploadProject,
  streamVideo,
  downloadFile,
  updateContent,
  reorderContent,
  deleteContent
} = require('../controllers/contentManagement');

// Get content for a section
router.get('/sections/:sectionId/content', protect, getContentBySection);

// Upload routes with dynamic file handling
router.post(
  '/sections/:sectionId/content/uploadLecture',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteLectures'),
  uploadLectureVideo.single('video'),
  scanFile,
  uploadLecture,
  handleDynamicUploadError
);

router.post(
  '/sections/:sectionId/content/uploadAssignment',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  uploadAssignmentFile.single('file'),
  scanFile,
  uploadAssignment,
  handleDynamicUploadError
);

router.post(
  '/sections/:sectionId/content/uploadProject',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  uploadProjectFiles.fields([
    { name: 'video', maxCount: 1 },
    { name: 'file', maxCount: 1 }
  ]),
  scanFile,
  uploadProject,
  handleDynamicUploadError
);

// Stream and download routes
router.get('/content/:contentId/stream', protectAllowQuery, streamVideo);
router.get('/content/:contentId/download', protectAllowQuery, downloadFile);

// Update content with file upload support
router.put(
  '/content/:contentId',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteLectures'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  async (req, res, next) => {
    try {
      // Get content type from database to determine which middleware to use
      const Content = require('../models/Content');
      const content = await Content.findById(req.params.contentId);
      if (!content) {
        return res.status(404).json({ success: false, message: 'Content not found' });
      }
      
      // Choose the appropriate middleware based on content type
      let middleware;
      if (content.type === 'lecture') {
        middleware = uploadLectureVideo.single('video');
      } else if (content.type === 'assignment') {
        middleware = uploadAssignmentFile.single('file');
      } else if (content.type === 'project') {
        middleware = uploadProjectFiles.fields([
          { name: 'video', maxCount: 1 },
          { name: 'file', maxCount: 1 }
        ]);
      } else {
        return res.status(400).json({ success: false, message: 'Unknown content type' });
      }
      
      middleware(req, res, next);
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Error processing update', error: error.message });
    }
  },
  scanFile,
  updateContent,
  handleDynamicUploadError
);

// Reorder content
router.put(
  '/sections/:sectionId/content/reorder',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteLectures'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  reorderContent
);

// Delete content (permanent, admin only).
router.delete('/content/:contentId', protect, authorize('admin'), deleteContent);

// Upload solution file for assignment/project
router.post(
  '/content/:contentId/uploadSolution',
  protect,
  authorize('instructor', 'admin'),
  requireInstructorNotRestricted('createEditDeleteAssignments'),
  uploadSolutionFile.single('solution'),
  scanFile,
  async (req, res) => {
    try {
      const Content = require('../models/Content');
      const content = await Content.findById(req.params.contentId);
      
      if (!content) {
        return res.status(404).json({ success: false, message: 'Content not found' });
      }
      
      if (content.type !== 'assignment' && content.type !== 'project') {
        return res.status(400).json({ success: false, message: 'Solutions can only be uploaded for assignments and projects' });
      }
      
      // Check if user is authorized (content creator or admin)
      if (content.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
        return res.status(403).json({ 
          success: false, 
          message: 'Not authorized to upload solution for this content' 
        });
      }
      
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No solution file provided' });
      }

      const oldSolution = content.solution && typeof content.solution === 'object' ? content.solution : null;
      const oldTelegramFileId = oldSolution?.telegramFileId;

      let oldTelegramAudit = null;
      if (oldTelegramFileId) {
        oldTelegramAudit = await TelegramFile.findOne({
          content: content._id,
          contentType: 'solution',
          status: 'active',
          telegramFileId: oldTelegramFileId
        }).sort({ createdAt: -1 });
      }

      const resolveLocalSolutionPath = (value) => {
        if (!value) return null;
        if (path.isAbsolute(value)) return value;

        const resolvedFromRoot = path.resolve(__dirname, '..', value);
        if (fs.existsSync(resolvedFromRoot)) return resolvedFromRoot;
        return path.join(__dirname, '..', 'uploads', 'files', value);
      };

      const oldLocalPathCandidate = oldSolution?.localPath || oldSolution?.path;
      if (oldSolution && oldSolution.storageType === 'local' && oldLocalPathCandidate) {
        const oldLocalAbs = resolveLocalSolutionPath(oldLocalPathCandidate);
        try {
          if (oldLocalAbs && fs.existsSync(oldLocalAbs)) {
            fs.unlinkSync(oldLocalAbs);
          }
        } catch (_) {}
      }

      const { type: fileProviderType, service: fileService } = getFileProvider();
      const fileData = await fileService.uploadLessonFile(req.file, {
        userId: req.user.id
      });

      content.solution = fileData;
      content.solution.uploadedAt = content.solution.uploadedAt || new Date();
      content.solution.uploadedBy = content.solution.uploadedBy || req.user._id;
      await content.save();

      let newTelegramAudit = null;
      if (fileProviderType === 'telegram' && fileData?.telegramFileId) {
        try {
          newTelegramAudit = await TelegramFile.create({
            fileName: fileData.originalName || req.file.originalname,
            fileSize: typeof fileData.size === 'number' ? fileData.size : req.file.size,
            mimeType: fileData.mimeType || req.file.mimetype,
            telegramFileId: fileData.telegramFileId,
            telegramMessageId: fileData.telegramMessageId,
            telegramChatId: fileData.telegramChatId,
            status: 'active',
            statusChangedAt: new Date(),
            uploadedAt: fileData.uploadedAt || new Date(),
            uploadedBy: req.user.id,
            course: content.course,
            group: content.group,
            section: content.section,
            content: content._id,
            contentType: 'solution',
            replaces: oldTelegramAudit?._id || null
          });
        } catch (e) {
          console.error('[TelegramFileAudit] Failed to create TelegramFile record (solution upload):', e.message);
        }
      }

      if (oldTelegramAudit) {
        try {
          oldTelegramAudit.status = 'changed';
          oldTelegramAudit.statusChangedAt = new Date();
          if (newTelegramAudit?._id) {
            oldTelegramAudit.replacedBy = newTelegramAudit._id;
          }
          await oldTelegramAudit.save();
        } catch (e) {
          console.error('[TelegramFileAudit] Failed to mark TelegramFile as changed (solution replace):', e.message);
        }
      }

      res.json({
        success: true,
        message: 'Solution uploaded successfully',
        data: { solution: content.solution }
      });
    } catch (error) {
      console.error('Error uploading solution:', error);
      try {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (_) {}
      res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
  },
  handleDynamicUploadError
);

// Download solution file (only for graded students)
router.get('/content/:contentId/downloadSolution', protect, async (req, res) => {
  try {
    const Content = require('../models/Content');
    const Progress = require('../models/Progress');
    
    const content = await Content.findById(req.params.contentId);
    
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    const hasTelegramSolution = Boolean(content.solution?.telegramFileId);
    const hasLocalSolution = Boolean(content.solution?.localPath || content.solution?.path);

    if (!content.solution || (!hasTelegramSolution && !hasLocalSolution)) {
      return res.status(404).json({ success: false, message: 'No solution available for this content' });
    }

    if (req.user?.role !== 'admin' && content.deletionStatus === 'deleted') {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }

    if (req.user?.role === 'student' && !content.isPublished) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }
    
    // Instructors and admins can always download
    // Students: Allow if enrolled in the course (via enrollment or group)
    if (req.user.role === 'student') {
      const Enrollment = require('../models/Enrollment');
      const Group = require('../models/Group');
      
      // Check if student is enrolled directly in the course
      const enrollment = await Enrollment.findOne({
        student: req.user.id,
        course: content.course
      });
      
      // Or check if student is enrolled in a group for this course
      const groupEnrollment = await Group.findOne({
        course: content.course,
        'students.student': req.user.id,
        'students.status': 'enrolled'
      });
      
      if (!enrollment && !groupEnrollment) {
        return res.status(403).json({ 
          success: false, 
          message: 'You must be enrolled in this course to access solutions' 
        });
      }
      
      const grade = await StudentContentGrade.findOne({
        student: req.user.id,
        content: content._id
      }).select('status');

      if (!grade || grade.status !== 'graded') {
        return res.status(403).json({
          success: false,
          message: 'Solution is available after your submission has been graded'
        });
      }
    }
    
    if (content.solution?.telegramFileId) {
      const fileName =
        content.solution.telegramFileName ||
        content.solution.originalName ||
        content.solution.storedName ||
        `${content.title}_solution.rar`;
      return streamTelegramFile(content.solution.telegramFileId, res, {
        asAttachment: true,
        filename: fileName
      });
    }

    const resolveLocalSolutionPath = (value) => {
      if (!value) return null;
      if (path.isAbsolute(value)) return value;

      const resolvedFromRoot = path.resolve(__dirname, '..', value);
      if (fs.existsSync(resolvedFromRoot)) return resolvedFromRoot;
      return path.join(__dirname, '..', 'uploads', 'files', value);
    };

    const filePath = resolveLocalSolutionPath(content.solution.localPath || content.solution.path);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Solution file not found on server' });
    }

    const downloadName =
      content.solution.originalName ||
      content.solution.storedName ||
      `${content.title}_solution.rar`;

    res.download(filePath, downloadName, (err) => {
      if (err) {
        console.error('Error downloading solution:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Error downloading solution' });
        }
      }
    });
  } catch (error) {
    console.error('Error downloading solution:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

module.exports = router;
