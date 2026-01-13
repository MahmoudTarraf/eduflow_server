const Content = require('../models/Content');
const Section = require('../models/Section');
const Group = require('../models/Group');
const StudentProgress = require('../models/StudentProgress');
const SectionPayment = require('../models/SectionPayment');
const Enrollment = require('../models/Enrollment');
const StudentContentGrade = require('../models/StudentContentGrade');
const DeleteRequest = require('../models/DeleteRequest');
const TelegramFile = require('../models/TelegramFile');
const YouTubeVideo = require('../models/YouTubeVideo');
const CloudinaryAsset = require('../models/CloudinaryAsset');
const fs = require('fs').promises;
const path = require('path');
const { sendNewContentEmail, sendAssignmentGradedEmail } = require('../utils/emailNotifications');
const { awardPointsInternal, awardOnceForActivityInternal } = require('./gamification');
const CourseGrade = require('../models/CourseGrade');
const { calculateCourseGrade } = require('../services/gradingService');
const { streamTelegramFile } = require('../services/telegramFileService');
const { getVideoProvider, getFileProvider } = require('../services/storage');
const uploadService = require('../services/uploadService');
const { extractYouTubeVideoId, normalizeYouTubeUrl } = require('../utils/youtubeHelper');
const { notifyAdminsAboutUploadIssue } = require('../utils/uploadIssueNotifier');

const stripYouTubeFieldsFromContent = (docOrObj) => {
  if (!docOrObj) return docOrObj;
  const obj = typeof docOrObj.toObject === 'function' ? docOrObj.toObject() : { ...docOrObj };
  if (obj.video && typeof obj.video === 'object') {
    delete obj.video.youtubeUrl;
    if (obj.video.storageType === 'youtube') {
      obj.video.storageType = 'hosted';
    }
  }
  return obj;
};

exports.assignHostedVideoUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const { youtubeUrl, youtubeVideoId } = req.body;

    const content = await Content.findById(id);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'lecture' && content.type !== 'project') {
      return res.status(400).json({
        success: false,
        message: 'Hosted video assignment is only supported for video content'
      });
    }

    const trimmedUrl = typeof youtubeUrl === 'string' ? youtubeUrl.trim() : '';
    const extractedFromUrl = trimmedUrl ? extractYouTubeVideoId(trimmedUrl) : null;
    const urlLooksLikeId = trimmedUrl && /^[a-zA-Z0-9_-]{10,}$/.test(trimmedUrl) ? trimmedUrl : null;

    const incomingId =
      (typeof youtubeVideoId === 'string' && youtubeVideoId.trim()) ||
      extractedFromUrl ||
      urlLooksLikeId ||
      null;

    if (!incomingId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid hosted video URL or video ID'
      });
    }

    const normalizedUrl = normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${incomingId}`);
    if (!normalizedUrl) {
      return res.status(400).json({
        success: false,
        message: 'Invalid hosted video URL or video ID'
      });
    }

    const existingVideoRecord = await YouTubeVideo.findOne({ youtubeVideoId: incomingId }).select('status content');
    if (existingVideoRecord?.status === 'physically_deleted') {
      return res.status(400).json({
        success: false,
        message: 'Cannot assign a physically deleted video'
      });
    }

    if (existingVideoRecord?.content && String(existingVideoRecord.content) !== String(content._id)) {
      return res.status(400).json({
        success: false,
        message: 'This hosted video is already assigned to another content item'
      });
    }

    const previousYouTubeVideoId = content?.video?.youtubeVideoId || null;

    content.video = {
      ...(content.video && typeof content.video === 'object' ? content.video : {}),
      storageType: 'youtube',
      youtubeVideoId: incomingId,
      youtubeUrl: normalizedUrl,
      uploadedAt: new Date(),
      uploadedBy: req.user?._id || req.user?.id
    };

    await content.save();

    await YouTubeVideo.findOneAndUpdate(
      { youtubeVideoId: incomingId },
      {
        $setOnInsert: {
          title: content.title || 'Hosted video',
          description: content.description || '',
          youtubeVideoId: incomingId,
          youtubeUrl: normalizedUrl,
          privacyStatus: 'unlisted',
          originalFilename: 'assigned-url',
          uploadedAt: new Date(),
          fileSize: null
        },
        $set: {
          course: content.course || null,
          section: content.section || null,
          group: content.group || null,
          content: content._id,
          status: 'active',
          statusChangedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    if (previousYouTubeVideoId && previousYouTubeVideoId !== incomingId) {
      const otherRefs = await Content.countDocuments({
        _id: { $ne: content._id },
        deletionStatus: { $ne: 'deleted' },
        'video.youtubeVideoId': previousYouTubeVideoId
      });

      if (otherRefs === 0) {
        await YouTubeVideo.findOneAndUpdate(
          { youtubeVideoId: previousYouTubeVideoId, status: { $ne: 'physically_deleted' } },
          { status: 'superseded', statusChangedAt: new Date() },
          { new: true }
        );
      } else {
        await YouTubeVideo.findOneAndUpdate(
          { youtubeVideoId: previousYouTubeVideoId, status: 'pending_deletion' },
          { status: 'active', statusChangedAt: new Date() },
          { new: true }
        );
      }
    }

    return res.json({
      success: true,
      message: 'Hosted video updated successfully',
      data: content
    });
  } catch (error) {
    console.error('assignHostedVideoUrl error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update hosted video'
    });
  }
};

// @desc    Get all content for a section
// @route   GET /api/content/section/:sectionId
// @access  Private
exports.getContentBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;

    // Base query
    let query = { section: sectionId, isPublished: true, deletionStatus: { $ne: 'deleted' } };

    // Fetch content list first; we will filter archived items per-student conditions below
    let content = await Content.find(query)
      .populate('createdBy', 'name email')
      .sort('order type');

    // If student, include their progress/grades for each item
    if (req.user.role === 'student') {
      const progressDocs = await StudentProgress.find({
        student: req.user.id,
        section: sectionId
      }).select('content item');

      const progressedIds = new Set(
        progressDocs
          .map(p => (p.content || p.item))
          .filter(Boolean)
          .map(id => id.toString())
      );

      // Include progress/grade fields in response
      const contentWithProgress = await Promise.all(
        content.map(async (item) => {
          const progress = await StudentProgress.findOne({
            student: req.user.id,
            content: item._id
          });

          // Get grade data for all content types
          const gradeData = await StudentContentGrade.findOne({
            student: req.user.id,
            content: item._id
          });

          // Determine status and completion based on content type
          let status = 'not_submitted';
          let gradePercent = 0;
          let completed = false;
          let instructorFeedback = null;
          let reupload = {
            requested: false,
            status: 'none',
            used: false,
            regradeUsed: false,
            reason: null,
            canRequest: false,
            initialGradePercent: null,
            initialGradedAt: null,
            initialFeedback: null,
            regradeAt: null
          };

          if (gradeData) {
            status = gradeData.status;
            gradePercent = gradeData.gradePercent || 0;
            instructorFeedback = gradeData.instructorFeedback;

            reupload.requested = !!gradeData.reuploadRequested;
            reupload.status = gradeData.reuploadStatus || 'none';
            reupload.used = !!gradeData.reuploadUsed;
            reupload.regradeUsed = !!gradeData.regradeUsed;
            reupload.reason = gradeData.reuploadReason || null;
            reupload.initialGradePercent = gradeData.initialGradePercent != null ? gradeData.initialGradePercent : null;
            reupload.initialGradedAt = gradeData.initialGradedAt || null;
            reupload.initialFeedback = gradeData.initialFeedback || null;
            reupload.regradeAt = gradeData.regradeAt || null;
            
            // Mark as completed if:
            // - Lecture/Project video: status is 'watched'
            // - Assignment: status is 'graded' or 'submitted_ungraded'
            if (item.type === 'lecture' || item.type === 'project') {
              completed = status === 'watched';
            } else if (item.type === 'assignment') {
              completed = status === 'graded' || status === 'submitted_ungraded';
            }
          } else if (progress) {
            // Fallback to StudentProgress if no grade data
            completed = progress.completed || false;
            if (item.type === 'assignment' || item.type === 'project') {
              status = progress.submitted ? 'submitted_ungraded' : 'not_submitted';
              gradePercent = progress.submitted ? 50 : 0;
            } else {
              status = completed ? 'watched' : 'not_watched';
              gradePercent = completed ? 100 : 0;
            }
          }

          // Compute reupload eligibility on top of raw flags
          if (item.type === 'assignment' || item.type === 'project') {
            if (
              status === 'graded' &&
              !reupload.used &&
              !reupload.regradeUsed &&
              (reupload.status === 'none' || !reupload.status)
            ) {
              reupload.canRequest = true;
            }
          }

          return {
            ...item.toObject(),
            progress: {
              completed,
              status,
              gradePercent,
              instructorFeedback,
              viewedAt: progress?.viewedAt || gradeData?.updatedAt,
              submittedAt: gradeData?.submittedAt,
              reupload
            }
          };
        })
      );

      return res.json({
        success: true,
        count: content.length,
        data: contentWithProgress
      });
    }

    res.json({
      success: true,
      count: content.length,
      data: req.user.role === 'instructor' ? content.map(stripYouTubeFieldsFromContent) : content
    });
  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch content',
      error: error.message
    });
  }
};

// @desc    Get single content item
// @route   GET /api/content/:id
// @access  Private
exports.getContentById = async (req, res) => {
  try {
    const content = await Content.findById(req.params.id)
      .populate('section', 'name isFree')
      .populate('group', 'name')
      .populate('course', 'name')
      .populate('createdBy', 'name email');

    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user.role === 'student' && (!content.isPublished || content.deletionStatus === 'deleted')) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    // If student, check access and include progress
    if (req.user.role === 'student') {
      // Check section access
      const section = await Section.findById(content.section);
      if (!section.isFree) {
        const group = await Group.findById(content.group);
        const studentEnrollment = group.students.find(
          s => s.student.toString() === req.user.id
        );

        if (!studentEnrollment) {
          return res.status(403).json({
            success: false,
            message: 'Not enrolled in this group'
          });
        }

        const sectionPayment = studentEnrollment.sectionPayments.find(
          sp => sp.sectionId.toString() === section._id.toString() && sp.status === 'verified'
        );

        if (!sectionPayment) {
          return res.status(403).json({
            success: false,
            message: 'Section payment required',
            price: section.priceSYR
          });
        }
      }

      // Get progress
      const progress = await StudentProgress.findOne({
        student: req.user.id,
        content: content._id
      });

      return res.json({
        success: true,
        data: {
          ...content.toObject(),
          progress: progress || null
        }
      });
    }

    res.json({
      success: true,
      data: req.user.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch content',
      error: error.message
    });
  }
};

// @desc    Upload lecture video
// @route   POST /api/content/lecture
// @access  Private (Instructor/Admin)
exports.uploadLecture = async (req, res) => {
  try {
    const { title, description, sectionId, groupId, courseId, order, uploadSessionId } = req.body;
    const { type: providerType, service: videoService } = getVideoProvider();

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Video file is required'
      });
    }

    const allowedVideoMime = [
      'video/mp4',
      'video/webm',
      'video/x-matroska',
      'video/quicktime',
      'video/x-msvideo',
      'application/octet-stream'
    ];
    if (!allowedVideoMime.includes(req.file.mimetype)) {
      if (req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Invalid video format. Allowed: MP4, WEBM, MKV, MOV, AVI'
      });
    }

    if (!title || !sectionId || !groupId || !courseId) {
      return res.status(400).json({
        success: false,
        message: 'Title, section, group, and course are required'
      });
    }

    const shouldTrackHostedProgress = providerType === 'youtube' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      const { createJob, updateJob, attachJobRuntime } = require('../services/videoUploadJobs');
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: req.user?.id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
          return res.status(499).json({ success: false, message: 'Upload canceled' });
        }
        throw e;
      }
      updateJob(jobId, {
        status: 'uploading',
        percent: 0,
        bytesUploaded: 0,
        totalBytes
      });
      attachJobRuntime(jobId, {
        abortController,
        cleanup: async () => {
          if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
        }
      });

      // If the client canceled before we attached the abort controller, stop before starting the upstream upload.
      const { getJob } = require('../services/videoUploadJobs');
      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (req.file?.path) {
          await fs.unlink(req.file.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const videoData = await videoService.uploadLessonVideo(req.file, {
      userId: req.user.id,
      title,
      description,
      courseId,
      sectionId,
      groupId,
      privacyStatus: 'unlisted',
      onProgress: shouldTrackHostedProgress
        ? ({ uploadedBytes, totalBytes: tb, percent }) => {
            const { updateJob } = require('../services/videoUploadJobs');
            updateJob(jobId, {
              status: 'uploading',
              bytesUploaded: uploadedBytes,
              totalBytes: tb || totalBytes,
              percent
            });
          }
        : undefined,
      abortSignal: abortController?.signal
    });

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'processing',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });
    }

    const content = await Content.create({
      title,
      description: description || '',
      type: 'lecture',
      section: sectionId,
      group: groupId,
      course: courseId,
      video: videoData,
      videoPath: providerType === 'local' ? req.file.filename : null,
      videoFileName: providerType === 'local' ? req.file.originalname : null,
      videoDuration: 0,
      order: order || 0,
      createdBy: req.user.id
    });

    if (providerType === 'youtube' && videoData?.youtubeVideoId) {
      await YouTubeVideo.findOneAndUpdate(
        {
          youtubeVideoId: videoData.youtubeVideoId,
          $or: [{ content: null }, { content: { $exists: false } }]
        },
        {
          content: content._id,
          course: courseId,
          section: sectionId,
          group: groupId
        },
        { new: true }
      );
    }

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    await content.populate('createdBy', 'name email');

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    // Send email notification to enrolled students
    try {
      const Course = require('../models/Course');
      const User = require('../models/User');
      
      const course = await Course.findById(courseId);
      const enrollments = await Enrollment.find({ 
        course: courseId,
        status: { $in: ['enrolled', 'approved', 'completed'] }
      }).populate('student', 'name email');
      
      // Send emails to all enrolled students
      for (const enrollment of enrollments) {
        if (enrollment.student && enrollment.student.email) {
          sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            title,
            course.name
          ).catch(err => console.error('Email send error:', err));
        }
      }
    } catch (emailError) {
      console.error('Failed to send new content emails:', emailError);
    }

    res.status(201).json({
      success: true,
      message: 'Lecture uploaded successfully',
      data: req.user.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          const { updateJob } = require('../services/videoUploadJobs');
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }

      return res.status(499).json({
        success: false,
        message: 'Upload canceled'
      });
    }

    try {
      const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
      if (jobId) {
        const { updateJob, getJob } = require('../services/videoUploadJobs');
        const job = getJob(jobId);
        const isCanceled = job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled;
        if (!isCanceled) {
          updateJob(jobId, {
            status: 'failed',
            error: 'Upload failed'
          });
        }
      }
    } catch (_) {}

    if (error?.code === 'YT_QUOTA_EXCEEDED' && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'quota',
        context: 'lecture upload'
      });
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({
        success: false,
        message: 'Upload failed, please try again in a few hours'
      });
    }

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'auth',
        context: 'lecture upload'
      });
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({
        success: false,
        message: 'Upload failed, please contact admin'
      });
    }

    console.error('Upload lecture error:', error);
    // Delete uploaded file if database operation failed
    if (req.file) {
      if (req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
    }
    res.status(500).json({
      success: false,
      message: 'Failed to upload lecture'
    });
  }
};

// @desc    Upload assignment file
// @route   POST /api/content/assignment
// @access  Private (Instructor/Admin)
exports.uploadAssignment = async (req, res) => {
  try {
    const { title, description, sectionId, groupId, courseId, order, dueDate, maxScore, uploadSessionId } = req.body;
    const { type: fileProviderType, service: fileService } = getFileProvider();

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Assignment file is required'
      });
    }

    const allowedArchiveMimes = ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    const hasArchiveExtension = /(\.(rar|zip))$/i.test(req.file.originalname);
    const hasArchiveMime = allowedArchiveMimes.includes(req.file.mimetype);
    if (!hasArchiveExtension && !hasArchiveMime) {
      if (req.file.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Assignments must be uploaded as .rar or .zip archives'
      });
    }

    if (!title || !sectionId || !groupId || !courseId) {
      return res.status(400).json({
        success: false,
        message: 'Title, section, group, and course are required'
      });
    }

    const shouldTrackHostedProgress = fileProviderType === 'telegram' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      const { createJob, updateJob, attachJobRuntime, getJob } = require('../services/videoUploadJobs');
      jobId = String(uploadSessionId);

      try {
        createJob({ id: jobId, ownerId: req.user?.id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
          return res.status(499).json({ success: false, message: 'Upload canceled' });
        }
        throw e;
      }

      updateJob(jobId, {
        status: 'uploading',
        percent: 0,
        bytesUploaded: 0,
        totalBytes
      });

      attachJobRuntime(jobId, {
        abortController,
        cleanup: async () => {
          if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
        }
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (req.file?.path) {
          await fs.unlink(req.file.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const fileData = await fileService.uploadLessonFile(req.file, {
      userId: req.user.id,
      onProgress: shouldTrackHostedProgress
        ? ({ uploadedBytes, totalBytes: tb, percent }) => {
            const { updateJob } = require('../services/videoUploadJobs');
            updateJob(jobId, {
              status: 'uploading',
              bytesUploaded: uploadedBytes,
              totalBytes: tb || totalBytes,
              percent
            });
          }
        : undefined,
      abortSignal: abortController?.signal
    });

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'processing',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });
    }

    const content = await Content.create({
      title,
      description: description || '',
      type: 'assignment',
      section: sectionId,
      group: groupId,
      course: courseId,
      file: fileData,
      filePath: fileProviderType === 'local' ? req.file.filename : null,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      maxScore: maxScore || 100,
      dueDate: dueDate ? new Date(dueDate) : null,
      order: order || 0,
      createdBy: req.user.id
    });

    if (fileProviderType === 'telegram' && fileData?.telegramFileId) {
      try {
        await TelegramFile.create({
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
          course: courseId,
          group: groupId,
          section: sectionId,
          content: content._id,
          contentType: 'assignment'
        });
      } catch (e) {
        console.error('[TelegramFileAudit] Failed to create TelegramFile record (assignment upload):', e.message);
      }
    }

    await content.populate('createdBy', 'name email');

    // Send email notification to enrolled students
    try {
      const Course = require('../models/Course');
      const course = await Course.findById(courseId);
      const enrollments = await Enrollment.find({ 
        course: courseId,
        status: { $in: ['enrolled', 'approved', 'completed'] }
      }).populate('student', 'name email');
      
      for (const enrollment of enrollments) {
        if (enrollment.student && enrollment.student.email) {
          await sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            title,
            course.name
          ).catch(err => console.error('Email send error:', err));
        }
      }
    } catch (emailError) {
      console.error('Failed to send new content emails:', emailError);
    }

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    res.status(201).json({
      success: true,
      message: 'Assignment uploaded successfully',
      data: req.user.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          const { updateJob } = require('../services/videoUploadJobs');
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }

      return res.status(499).json({
        success: false,
        message: 'Upload canceled'
      });
    }

    try {
      const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
      if (jobId) {
        const { updateJob, getJob } = require('../services/videoUploadJobs');
        const job = getJob(jobId);
        const isCanceled = job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled;
        if (!isCanceled) {
          updateJob(jobId, {
            status: 'failed',
            error: 'Upload failed'
          });
        }
      }
    } catch (_) {}

    console.error('Upload assignment error:', error);
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({
      success: false,
      message: 'Failed to upload assignment'
    });
  }
};

// @desc    Upload project (video + starter file)
// @route   POST /api/content/project
// @access  Private (Instructor/Admin)
exports.uploadProject = async (req, res) => {
  try {
    const { title, description, sectionId, groupId, courseId, order, maxScore, dueDate, uploadSessionId } = req.body;
    const { type: videoProviderType, service: videoService } = getVideoProvider();
    const { type: fileProviderType, service: fileService } = getFileProvider();

    if (!req.files || !req.files.video || !req.files.file) {
      return res.status(400).json({
        success: false,
        message: 'Both video and starter file are required'
      });
    }

    const videoFile = req.files.video[0];
    const starterFile = req.files.file[0];

    const allowedVideoMime = ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'application/octet-stream'];
    if (!allowedVideoMime.includes(videoFile.mimetype)) {
      if (videoFile.path) {
        await fs.unlink(videoFile.path).catch(() => {});
      }
      if (starterFile.path) {
        await fs.unlink(starterFile.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Project video must be MP4, WEBM, MKV, MOV, or AVI'
      });
    }

    const allowedArchiveMimes = ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    const isArchive = (/\.(rar|zip)$/i.test(starterFile.originalname)) && allowedArchiveMimes.includes(starterFile.mimetype);
    if (!isArchive) {
      if (videoFile.path) {
        await fs.unlink(videoFile.path).catch(() => {});
      }
      if (starterFile.path) {
        await fs.unlink(starterFile.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Project starter file must be a .rar or .zip archive'
      });
    }

    if (!title || !sectionId || !groupId || !courseId) {
      return res.status(400).json({
        success: false,
        message: 'Title, section, group, and course are required'
      });
    }

    const shouldTrackVideoHostedProgress = videoProviderType === 'youtube';
    const shouldTrackFileHostedProgress = fileProviderType === 'telegram';
    const shouldTrackHostedProgress = Boolean(uploadSessionId) && (shouldTrackVideoHostedProgress || shouldTrackFileHostedProgress);

    const videoBytes = typeof videoFile?.size === 'number' ? videoFile.size : 0;
    const starterBytes = typeof starterFile?.size === 'number' ? starterFile.size : 0;
    const totalBytes =
      (shouldTrackVideoHostedProgress ? videoBytes : 0) +
      (shouldTrackFileHostedProgress ? starterBytes : 0) ||
      null;

    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    const toPercent = (bytes, total) => {
      if (!total || total <= 0) return 0;
      const pct = Math.round((bytes * 100) / total);
      return Math.max(0, Math.min(100, pct));
    };

    const updateHostedProgress = (bytesUploaded) => {
      if (!shouldTrackHostedProgress) return;
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'uploading',
        bytesUploaded,
        totalBytes,
        percent: toPercent(bytesUploaded, totalBytes)
      });
    };

    if (shouldTrackHostedProgress) {
      const { createJob, updateJob, attachJobRuntime, getJob } = require('../services/videoUploadJobs');
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: req.user?.id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (videoFile?.path) {
            await fs.unlink(videoFile.path).catch(() => {});
          }
          if (starterFile?.path) {
            await fs.unlink(starterFile.path).catch(() => {});
          }
          return res.status(499).json({ success: false, message: 'Upload canceled' });
        }
        throw e;
      }

      updateJob(jobId, {
        status: 'uploading',
        percent: 0,
        bytesUploaded: 0,
        totalBytes
      });

      attachJobRuntime(jobId, {
        abortController,
        cleanup: async () => {
          if (videoFile?.path) {
            await fs.unlink(videoFile.path).catch(() => {});
          }
          if (starterFile?.path) {
            await fs.unlink(starterFile.path).catch(() => {});
          }
        }
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (videoFile?.path) {
          await fs.unlink(videoFile.path).catch(() => {});
        }
        if (starterFile?.path) {
          await fs.unlink(starterFile.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const videoData = await videoService.uploadLessonVideo(videoFile, {
      userId: req.user.id,
      title,
      description,
      courseId,
      sectionId,
      groupId,
      privacyStatus: 'unlisted',
      onProgress: shouldTrackHostedProgress && shouldTrackVideoHostedProgress
        ? ({ uploadedBytes }) => {
            const bytesUploaded = Math.min(videoBytes, typeof uploadedBytes === 'number' ? uploadedBytes : 0);
            updateHostedProgress(bytesUploaded);
          }
        : undefined,
      abortSignal: abortController?.signal
    });

    if (shouldTrackHostedProgress && shouldTrackVideoHostedProgress) {
      updateHostedProgress(videoBytes);
    }

    const starterData = await fileService.uploadLessonFile(starterFile, {
      userId: req.user.id,
      onProgress: shouldTrackHostedProgress && shouldTrackFileHostedProgress
        ? ({ uploadedBytes }) => {
            const base = shouldTrackVideoHostedProgress ? videoBytes : 0;
            const fileUploaded = Math.min(starterBytes, typeof uploadedBytes === 'number' ? uploadedBytes : 0);
            updateHostedProgress(base + fileUploaded);
          }
        : undefined,
      abortSignal: abortController?.signal
    });

    if (shouldTrackHostedProgress) {
      if (shouldTrackFileHostedProgress) {
        const base = shouldTrackVideoHostedProgress ? videoBytes : 0;
        updateHostedProgress(base + starterBytes);
      }

      const { updateJob, getJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'processing',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const content = await Content.create({
      title,
      description: description || '',
      type: 'project',
      section: sectionId,
      group: groupId,
      course: courseId,
      video: videoData,
      file: starterData,
      videoPath: videoProviderType === 'local' ? videoFile.filename : null,
      videoFileName: videoProviderType === 'local' ? videoFile.originalname : null,
      starterFilePath: fileProviderType === 'local' ? starterFile.filename : null,
      starterFileName: fileProviderType === 'local' ? starterFile.originalname : null,
      fileSize: starterFile.size,
      maxScore: maxScore || 100,
      dueDate: dueDate ? new Date(dueDate) : null,
      order: order || 0,
      createdBy: req.user.id
    });

    if (fileProviderType === 'telegram' && starterData?.telegramFileId) {
      try {
        await TelegramFile.create({
          fileName: starterData.originalName || starterFile.originalname,
          fileSize: typeof starterData.size === 'number' ? starterData.size : starterFile.size,
          mimeType: starterData.mimeType || starterFile.mimetype,
          telegramFileId: starterData.telegramFileId,
          telegramMessageId: starterData.telegramMessageId,
          telegramChatId: starterData.telegramChatId,
          status: 'active',
          statusChangedAt: new Date(),
          uploadedAt: starterData.uploadedAt || new Date(),
          uploadedBy: req.user.id,
          course: courseId,
          group: groupId,
          section: sectionId,
          content: content._id,
          contentType: 'project'
        });
      } catch (e) {
        console.error('[TelegramFileAudit] Failed to create TelegramFile record (project upload):', e.message);
      }
    }

    if (videoProviderType === 'youtube' && videoData?.youtubeVideoId) {
      await YouTubeVideo.findOneAndUpdate(
        {
          youtubeVideoId: videoData.youtubeVideoId,
          $or: [{ content: null }, { content: { $exists: false } }]
        },
        {
          content: content._id,
          course: courseId,
          section: sectionId,
          group: groupId
        },
        { new: true }
      );
    }

    await content.populate('createdBy', 'name email');

    // Send email notification to enrolled students
    try {
      const Course = require('../models/Course');
      const course = await Course.findById(courseId);
      const enrollments = await Enrollment.find({ 
        course: courseId,
        status: { $in: ['enrolled', 'approved', 'completed'] }
      }).populate('student', 'name email');
      
      for (const enrollment of enrollments) {
        if (enrollment.student && enrollment.student.email) {
          await sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            title,
            course.name
          ).catch(err => console.error('Email send error:', err));
        }
      }
    } catch (emailError) {
      console.error('Failed to send new content emails:', emailError);
    }

    if (shouldTrackHostedProgress) {
      try {
        const { updateJob } = require('../services/videoUploadJobs');
        updateJob(jobId, {
          status: 'completed',
          percent: 100,
          contentId: content._id
        });
      } catch (_) {}
    }

    res.status(201).json({
      success: true,
      message: 'Project uploaded successfully',
      data: req.user.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          const { updateJob } = require('../services/videoUploadJobs');
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      if (req.files) {
        if (req.files.video && req.files.video[0]?.path) {
          await fs.unlink(req.files.video[0].path).catch(() => {});
        }
        if (req.files.file && req.files.file[0]?.path) {
          await fs.unlink(req.files.file[0].path).catch(() => {});
        }
      }

      return res.status(499).json({
        success: false,
        message: 'Upload canceled'
      });
    }

    try {
      const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
      if (jobId) {
        const { updateJob, getJob } = require('../services/videoUploadJobs');
        const job = getJob(jobId);
        const isCanceled = job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled;
        if (!isCanceled) {
          updateJob(jobId, {
            status: 'failed',
            error: 'Upload failed'
          });
        }
      }
    } catch (_) {}

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      console.error('Upload project blocked (platform YouTube token issue):', {
        code: error.code,
        message: error.message,
        cause: error.cause
      });
      // Clean up uploaded files
      if (req.files) {
        if (req.files.video && req.files.video[0]?.path) {
          await fs.unlink(req.files.video[0].path).catch(console.error);
        }
        if (req.files.file && req.files.file[0]?.path) {
          await fs.unlink(req.files.file[0].path).catch(console.error);
        }
      }
      return res.status(500).json({
        success: false,
        message: 'Video uploads are temporarily disabled. Contact support.'
      });
    }

    console.error('Upload project error:', error);
    // Clean up uploaded files
    if (req.files) {
      if (req.files.video && req.files.video[0]?.path) {
        await fs.unlink(req.files.video[0].path).catch(console.error);
      }
      if (req.files.file && req.files.file[0]?.path) {
        await fs.unlink(req.files.file[0].path).catch(console.error);
      }
    }
    res.status(500).json({
      success: false,
      message: 'Upload failed. Please try again.'
    });
  }
};

// @desc    Update content
// @route   PUT /api/content/:id
// @access  Private (Instructor/Admin)
exports.updateContent = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, order, isPublished, maxScore, dueDate } = req.body;

    const content = await Content.findById(id);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    // Update fields
    if (title !== undefined) content.title = title;
    if (description !== undefined) content.description = description;
    if (order !== undefined) content.order = order;
    if (isPublished !== undefined) content.isPublished = isPublished;
    if (maxScore !== undefined) content.maxScore = maxScore;
    if (dueDate !== undefined) content.dueDate = dueDate ? new Date(dueDate) : null;

    // Handle file replacement if new file uploaded
    if (req.file) {
      if (content.type === 'lecture') {
        const { type: providerType, service: videoService } = getVideoProvider();
        const allowedVideoMime = ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'application/octet-stream'];
        if (!allowedVideoMime.includes(req.file.mimetype)) {
          if (req.file.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            message: 'Invalid video format. Allowed: MP4, WEBM, MKV, MOV, AVI'
          });
        }

        const previousYouTubeVideoId = content?.video?.youtubeVideoId || null;

        if (providerType === 'local' && content.videoPath) {
          const oldPath = path.join(__dirname, '../uploads/videos', content.videoPath);
          await fs.unlink(oldPath).catch(console.error);
        }

        const videoData = await videoService.uploadLessonVideo(req.file, {
          userId: req.user.id,
          title,
          description,
          courseId: content.course,
          sectionId: content.section,
          groupId: content.group,
          privacyStatus: 'unlisted',
          contentId: content._id
        });

        content.video = videoData;
        content.videoPath = providerType === 'local' ? req.file.filename : null;
        content.videoFileName = providerType === 'local' ? req.file.originalname : null;

        if (
          providerType === 'youtube' &&
          previousYouTubeVideoId &&
          videoData?.youtubeVideoId &&
          previousYouTubeVideoId !== videoData.youtubeVideoId
        ) {
          await YouTubeVideo.findOneAndUpdate(
            { youtubeVideoId: previousYouTubeVideoId },
            {
              status: 'superseded',
              statusChangedAt: new Date()
            },
            { new: true }
          );
        }
      } else if (content.type === 'assignment') {
        const { type: fileProviderType, service: fileService } = getFileProvider();
        const previousTelegramFileId = content?.file?.telegramFileId || null;
        const allowedArchiveMimes = ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
        const hasArchiveExtension = /\.(rar|zip)$/i.test(req.file.originalname);
        const hasArchiveMime = allowedArchiveMimes.includes(req.file.mimetype);
        
        if (!hasArchiveExtension && !hasArchiveMime) {
          if (req.file.path) {
            await fs.unlink(req.file.path).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            message: 'Assignments must be uploaded as .rar or .zip archives. Please ensure the file has a .rar or .zip extension.'
          });
        }

        if (fileProviderType === 'local' && content.filePath) {
          const oldPath = path.join(__dirname, '../uploads/files', content.filePath);
          await fs.unlink(oldPath).catch(console.error);
        }

        const fileData = await fileService.uploadLessonFile(req.file, {
          userId: req.user.id
        });

        content.file = fileData;
        content.filePath = fileProviderType === 'local' ? req.file.filename : null;
        content.fileName = req.file.originalname;
        content.fileSize = req.file.size;

        if (fileProviderType === 'telegram' && fileData?.telegramFileId) {
          try {
            const previousRecord = previousTelegramFileId
              ? await TelegramFile.findOne({
                  content: content._id,
                  status: 'active',
                  contentType: 'assignment',
                  telegramFileId: previousTelegramFileId
                }).sort({ createdAt: -1 })
              : await TelegramFile.findOne({
                  content: content._id,
                  status: 'active',
                  contentType: 'assignment'
                }).sort({ createdAt: -1 });

            const newRecord = await TelegramFile.create({
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
              contentType: 'assignment',
              replaces: previousRecord?._id || null
            });

            if (previousRecord) {
              previousRecord.status = 'changed';
              previousRecord.statusChangedAt = new Date();
              previousRecord.replacedBy = newRecord._id;
              await previousRecord.save();
            }
          } catch (e) {
            console.error('[TelegramFileAudit] Failed to update TelegramFile records (assignment update):', e.message);
          }
        }
      }
    }

    if (content.type === 'project' && req.files) {
      const { type: videoProviderType, service: videoService } = getVideoProvider();
      const { type: fileProviderType, service: fileService } = getFileProvider();

      if (req.files.video && req.files.video[0]) {
        const projectVideoFile = req.files.video[0];
        const allowedVideoMime = ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'application/octet-stream'];
        if (!allowedVideoMime.includes(projectVideoFile.mimetype)) {
          if (projectVideoFile.path) {
            await fs.unlink(projectVideoFile.path).catch(() => {});
          }
          if (req.files.file && req.files.file[0]?.path) {
            await fs.unlink(req.files.file[0].path).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            message: 'Invalid video format. Allowed: MP4, WEBM, MKV, MOV, AVI'
          });
        }

        const previousYouTubeVideoId = content?.video?.youtubeVideoId || null;
        if (videoProviderType === 'local' && content.videoPath) {
          const oldPath = path.join(__dirname, '../uploads/videos', content.videoPath);
          await fs.unlink(oldPath).catch(() => {});
        }

        const videoData = await videoService.uploadLessonVideo(projectVideoFile, {
          userId: req.user.id,
          title: title || content.title,
          description: description || content.description,
          courseId: content.course,
          sectionId: content.section,
          groupId: content.group,
          privacyStatus: 'unlisted',
          contentId: content._id
        });

        content.video = videoData;
        content.videoPath = videoProviderType === 'local' ? projectVideoFile.filename : null;
        content.videoFileName = videoProviderType === 'local' ? projectVideoFile.originalname : null;

        if (
          videoProviderType === 'youtube' &&
          previousYouTubeVideoId &&
          videoData?.youtubeVideoId &&
          previousYouTubeVideoId !== videoData.youtubeVideoId
        ) {
          await YouTubeVideo.findOneAndUpdate(
            { youtubeVideoId: previousYouTubeVideoId },
            { status: 'superseded', statusChangedAt: new Date() },
            { new: true }
          );
        }
      }

      if (req.files.file && req.files.file[0]) {
        const starterFile = req.files.file[0];
        const previousTelegramFileId = content?.file?.telegramFileId || null;
        const allowedArchiveMimes = ['application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
        const hasArchiveExtension = /\.(rar|zip)$/i.test(starterFile.originalname);
        const hasArchiveMime = allowedArchiveMimes.includes(starterFile.mimetype);

        if (!hasArchiveExtension && !hasArchiveMime) {
          if (starterFile.path) {
            await fs.unlink(starterFile.path).catch(() => {});
          }
          if (req.files.video && req.files.video[0]?.path) {
            await fs.unlink(req.files.video[0].path).catch(() => {});
          }
          return res.status(400).json({
            success: false,
            message: 'Project starter file must be a .rar or .zip archive'
          });
        }

        if (fileProviderType === 'local' && content.starterFilePath) {
          const oldPath = path.join(__dirname, '../uploads/files', content.starterFilePath);
          await fs.unlink(oldPath).catch(() => {});
        }

        const fileData = await fileService.uploadLessonFile(starterFile, {
          userId: req.user.id
        });

        content.file = fileData;
        content.starterFilePath = fileProviderType === 'local' ? starterFile.filename : null;
        content.starterFileName = fileProviderType === 'local' ? starterFile.originalname : null;
        content.fileSize = starterFile.size;

        if (fileProviderType === 'telegram' && fileData?.telegramFileId) {
          try {
            const previousRecord = previousTelegramFileId
              ? await TelegramFile.findOne({
                  content: content._id,
                  status: 'active',
                  contentType: 'project',
                  telegramFileId: previousTelegramFileId
                }).sort({ createdAt: -1 })
              : await TelegramFile.findOne({
                  content: content._id,
                  status: 'active',
                  contentType: 'project'
                }).sort({ createdAt: -1 });

            const newRecord = await TelegramFile.create({
              fileName: fileData.originalName || starterFile.originalname,
              fileSize: typeof fileData.size === 'number' ? fileData.size : starterFile.size,
              mimeType: fileData.mimeType || starterFile.mimetype,
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
              contentType: 'project',
              replaces: previousRecord?._id || null
            });

            if (previousRecord) {
              previousRecord.status = 'changed';
              previousRecord.statusChangedAt = new Date();
              previousRecord.replacedBy = newRecord._id;
              await previousRecord.save();
            }
          } catch (e) {
            console.error('[TelegramFileAudit] Failed to update TelegramFile records (project update):', e.message);
          }
        }
      }
    }

    await content.save();
    await content.populate('createdBy', 'name email');

    res.json({
      success: true,
      message: 'Content updated successfully',
      data: req.user.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      console.error('Update content blocked (platform YouTube token issue):', {
        code: error.code,
        message: error.message,
        cause: error.cause
      });
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(console.error);
      }
      return res.status(500).json({
        success: false,
        message: 'Video uploads are temporarily disabled. Contact support.'
      });
    }

    console.error('Update content error:', error);
    if (req.file) {
      if (req.file.path) {
        await fs.unlink(req.file.path).catch(console.error);
      }
    }
    res.status(500).json({
      success: false,
      message: 'Failed to update content',
      error: error.message
    });
  }
};

// @desc    Delete content
// @route   DELETE /api/content/:id
// @access  Private (Instructor/Admin)
exports.deleteContent = async (req, res) => {
  try {
    const id = req.params.id || req.params.contentId;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Content id is required'
      });
    }

    const content = await Content.findById(id);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    // Soft-delete only: hide from students; retain audit records and related progress/grades.
    // Platform must never delete YouTube videos automatically.
    if (content.deletionStatus === 'deleted') {
      return res.json({
        success: true,
        message: 'Content deleted successfully'
      });
    }

    const youtubeVideoId = content?.video?.youtubeVideoId;
    if (youtubeVideoId) {
      const otherRefs = await Content.countDocuments({
        _id: { $ne: content._id },
        deletionStatus: { $ne: 'deleted' },
        isLatestVersion: true,
        'video.storageType': 'youtube',
        'video.youtubeVideoId': youtubeVideoId
      });

      if (otherRefs === 0) {
        await YouTubeVideo.deleteOne({ youtubeVideoId });
      } else {
        await YouTubeVideo.findOneAndUpdate(
          { youtubeVideoId, status: 'pending_deletion' },
          { status: 'active', statusChangedAt: new Date() },
          { new: true }
        );
      }
    }

    try {
      await TelegramFile.updateMany(
        { content: id, status: 'active' },
        {
          status: 'soft_deleted',
          statusChangedAt: new Date(),
          softDeletedAt: new Date(),
          softDeletedBy: req.user._id || req.user.id
        }
      );
    } catch (e) {
      console.error('[TelegramFileAudit] Failed to soft-delete TelegramFile records (content delete):', e.message);
    }

    await Content.findByIdAndUpdate(
      id,
      {
        isPublished: false,
        deletionStatus: 'deleted',
        deletedAt: new Date(),
        deletedBy: req.user._id || req.user.id
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Content deleted successfully'
    });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete content',
      error: error.message
    });
  }
};

// @desc    Mark content as completed (for students)
// @route   POST /api/content/:id/complete
// @access  Private (Student)
exports.markAsCompleted = async (req, res) => {
  try {
    const { id } = req.params;
    const studentId = req.user.id;

    const content = await Content.findById(id);

    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    // Find or create progress record
    let progress = await StudentProgress.findOne({
      student: studentId,
      content: id
    });

    if (!progress) {
      progress = await StudentProgress.create({
        student: studentId,
        course: content.course,
        group: content.group,
        section: content.section,
        item: id,
        content: id,
        type: content.type,
        contentType: content.type,
        completed: true,
        completedAt: new Date(),
        viewedAt: new Date()
      });
    } else {
      progress.completed = true;
      progress.completedAt = new Date();
      if (!progress.viewedAt) progress.viewedAt = new Date();
      await progress.save();
    }

    // CRITICAL: Also update StudentContentGrade for lectures to mark as watched with 100%
    let gamification = null;
    if (content.type === 'lecture') {
      let grade = await StudentContentGrade.findOne({
        student: studentId,
        content: id
      });

      const wasWatched = grade?.status === 'watched';

      if (!grade) {
        grade = await StudentContentGrade.create({
          student: studentId,
          content: id,
          course: content.course,
          section: content.section,
          status: 'watched',
          gradePercent: 100,
          updatedAt: new Date()
        });
      } else if (grade.status !== 'watched') {
        grade.status = 'watched';
        grade.gradePercent = 100;
        grade.updatedAt = new Date();
        await grade.save();
      }

      if (!wasWatched) {
        try {
          gamification = await awardOnceForActivityInternal({
            studentId,
            activityType: 'videoWatch',
            contentId: id,
            contentModel: 'Content',
            contentTitle: content.title,
            courseId: content.course,
            metadata: { reason: 'manualComplete' }
          });
        } catch (e) {
          gamification = { success: false, pointsAwarded: 0 };
        }
      } else {
        gamification = { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null };
      }

      try {
        const prev = await CourseGrade.findOne({ student: studentId, course: content.course });
        await calculateCourseGrade(studentId, content.course);
        const now = await CourseGrade.findOne({ student: studentId, course: content.course });
        if (!prev?.isComplete && now?.isComplete) {
          const courseAward = await awardPointsInternal(studentId, 'course');
          if (courseAward?.success) {
            gamification = gamification || {};
            gamification.courseAward = courseAward;
          }
        }
      } catch (_) {}
    }

    res.json({
      success: true,
      message: 'Content marked as completed',
      data: progress,
      gamification: gamification || { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null }
    });
  } catch (error) {
    console.error('Mark as completed error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark as completed',
      error: error.message
    });
  }
};

// @desc    Mark video as watched (100% completion)
// @route   POST /api/content/:id/watched
// @access  Private (Student)
exports.markVideoWatched = async (req, res) => {
  try {
    const { id } = req.params;
    const { watchedDuration, totalDuration } = req.body;
    const studentId = req.user.id;

    const content = await Content.findById(id);

    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'lecture' && content.type !== 'project') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for video lectures'
      });
    }

    // Update StudentProgress for backward compatibility
    let progress = await StudentProgress.findOne({
      student: studentId,
      content: id
    });

    if (!progress) {
      progress = await StudentProgress.create({
        student: studentId,
        course: content.course,
        group: content.group,
        section: content.section,
        item: id,
        content: id,
        type: content.type,
        contentType: content.type,
        completed: true,
        completedAt: new Date(),
        viewedAt: new Date(),
        watchTime: watchedDuration || totalDuration || 0,
        lastPosition: totalDuration || 0
      });
    } else {
      progress.completed = true;
      progress.completedAt = new Date();
      if (!progress.viewedAt) progress.viewedAt = new Date();
      if (watchedDuration) progress.watchTime = watchedDuration;
      if (totalDuration) progress.lastPosition = totalDuration;
      await progress.save();
    }

    // CRITICAL: Also update StudentContentGrade for grading system
    let grade = await StudentContentGrade.findOne({
      student: studentId,
      content: id
    });

    let wasWatched = false;
    if (grade) {
      wasWatched = grade.status === 'watched';
    }

    if (!grade) {
      grade = await StudentContentGrade.create({
        student: studentId,
        content: id,
        course: content.course,
        section: content.section,
        status: 'watched',
        gradePercent: 100,
        watchedDuration: watchedDuration || totalDuration || 0,
        updatedAt: new Date()
      });
    } else {
      grade.status = 'watched';
      grade.gradePercent = 100;
      grade.watchedDuration = watchedDuration || totalDuration || 0;
      grade.updatedAt = new Date();
      await grade.save();
    }

    let gamification = null;
    if (!wasWatched) {
      try {
        gamification = await awardOnceForActivityInternal({
          studentId,
          activityType: 'videoWatch',
          contentId: id,
          contentModel: 'Content',
          contentTitle: content.title,
          courseId: content.course,
          metadata: { watchedDuration: watchedDuration || totalDuration || 0, totalDuration: totalDuration || 0 }
        });
      } catch (e) {
        gamification = { success: false, pointsAwarded: 0 };
      }
    } else {
      gamification = { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null };
    }

    try {
      const prev = await CourseGrade.findOne({ student: studentId, course: content.course });
      await calculateCourseGrade(studentId, content.course);
      const now = await CourseGrade.findOne({ student: studentId, course: content.course });
      if (!prev?.isComplete && now?.isComplete) {
        const courseAward = await awardPointsInternal(studentId, 'course');
        if (courseAward?.success) {
          gamification = gamification || {};
          gamification.courseAward = courseAward;
        }
      }
    } catch (_) {}

    res.json({
      success: true,
      message: 'Video marked as watched',
      data: progress,
      gamification: gamification || { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null }
    });
  } catch (error) {
    console.error('Mark video as watched error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark video as watched',
      error: error.message
    });
  }
};

// @desc    Update video watch progress
// @route   POST /api/content/:id/progress
// @access  Private (Student)
exports.updateWatchProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const { watchTime, lastPosition } = req.body;
    const studentId = req.user.id;

    const content = await Content.findById(id);

    if (!content || content.type !== 'lecture') {
      return res.status(404).json({
        success: false,
        message: 'Lecture not found'
      });
    }

    let progress = await StudentProgress.findOne({
      student: studentId,
      content: id
    });

    if (!progress) {
      progress = await StudentProgress.create({
        student: studentId,
        course: content.course,
        group: content.group,
        section: content.section,
        item: id,
        content: id,
        type: 'lecture',
        contentType: 'lecture',
        watchTime: watchTime || 0,
        lastPosition: lastPosition || 0,
        viewedAt: new Date()
      });
    } else {
      if (watchTime !== undefined) progress.watchTime = watchTime;
      if (lastPosition !== undefined) progress.lastPosition = lastPosition;
      if (!progress.viewedAt) progress.viewedAt = new Date();
      await progress.save();
    }

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Update watch progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update progress',
      error: error.message
    });
  }
};

// @desc    Download content file (assignment or project)
// @route   GET /api/content/:id/download
// @access  Private (Student)
exports.downloadContentFile = async (req, res) => {
  try {
    console.log('[DownloadFile] Request received for content:', req.params.id);
    
    const content = await Content.findById(req.params.id);
    
    if (!content) {
      console.error('[DownloadFile] Content not found:', req.params.id);
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role !== 'admin' && content.deletionStatus === 'deleted') {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role === 'student' && !content.isPublished) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    console.log('[DownloadFile] Content details:', {
      contentId: content._id,
      type: content.type,
      title: content.title,
      hasFile: Boolean(content.file),
      storageType: content.file?.storageType,
      cloudinaryUrl: content.file?.cloudinaryUrl ? '***exists***' : null,
      filePath: content.filePath,
      fileName: content.fileName,
      starterFilePath: content.starterFilePath,
      fileObject: content.file,
      fileObjectPath: content.file?.path,
      fileObjectOriginalName: content.file?.originalName,
      __dirname: __dirname,
      resolvedBase: path.resolve(__dirname, '..')
    });

    // Check for Cloudinary storage first
    if (content.file?.storageType === 'cloudinary' && content.file?.cloudinaryUrl) {
      console.log('[DownloadFile] Redirecting to Cloudinary URL');
      // Redirect to Cloudinary URL - browser will handle download
      return res.redirect(content.file.cloudinaryUrl);
    }

    if (content.file?.storageType === 'telegram' && content.file?.telegramFileId) {
      const downloadName =
        content.file.telegramFileName ||
        content.file.originalName ||
        content.fileName ||
        content.title + '.rar';

      console.log('[DownloadFile] Streaming from Telegram', {
        contentId: content._id,
        telegramFileId: content.file.telegramFileId,
        downloadName
      });

      return streamTelegramFile(content.file.telegramFileId, res, {
        asAttachment: true,
        filename: downloadName
      });
    }

    // Fallback to local file download
    // Determine file path
    let filePath = null;
    let fileName = null;

    if (content.type === 'assignment') {
      // Priority 1: Use new file.path structure (absolute path from multer)
      if (content.file && content.file.path) {
        filePath = path.isAbsolute(content.file.path) 
          ? content.file.path 
          : path.resolve(__dirname, '..', 'uploads', 'files', content.file.path);
        fileName = content.file.originalName || content.title + '.rar';
        console.log('[DownloadFile] Using file.path:', { filePath, fileName });
      } 
      // Priority 2: Legacy filePath (filename only, needs resolution)
      else if (content.filePath) {
        // filePath is usually just the filename (e.g., "1761811378665__Youtube.rar")
        const possiblePaths = [
          path.resolve(__dirname, '..', 'uploads', 'files', content.filePath),
          path.resolve(__dirname, '..', content.filePath),
          content.filePath // In case it's absolute
        ];
        
        for (const testPath of possiblePaths) {
          if (fs.existsSync(testPath)) {
            filePath = testPath;
            console.log('[DownloadFile] Found file at:', testPath);
            break;
          }
        }
        fileName = content.fileName || content.title + '.rar';
      }
    } else if (content.type === 'project') {
      // Priority 1: Use new file.path structure for starter file
      if (content.file && content.file.path) {
        filePath = path.isAbsolute(content.file.path) 
          ? content.file.path 
          : path.resolve(__dirname, '..', 'uploads', 'files', content.file.path);
        fileName = content.file.originalName || content.title + '_starter.rar';
        console.log('[DownloadFile] Using file.path:', { filePath, fileName });
      } 
      // Priority 2: Legacy starterFilePath
      else if (content.starterFilePath) {
        const possiblePaths = [
          path.resolve(__dirname, '..', 'uploads', 'files', content.starterFilePath),
          path.resolve(__dirname, '..', content.starterFilePath),
          content.starterFilePath
        ];
        
        for (const testPath of possiblePaths) {
          if (fs.existsSync(testPath)) {
            filePath = testPath;
            console.log('[DownloadFile] Found file at:', testPath);
            break;
          }
        }
        fileName = content.starterFileName || content.title + '_starter.rar';
      }
    }

    if (!filePath) {
      console.error('[DownloadFile] No file path found for content:', {
        contentId: content._id,
        type: content.type,
        file: content.file,
        filePath: content.filePath,
        starterFilePath: content.starterFilePath
      });
      return res.status(404).json({
        success: false,
        message: 'File not found for this content. The instructor may not have uploaded a file yet.'
      });
    }

    // Final check if file exists
    try {
      await fs.access(filePath);
    } catch (err) {
      console.error('[DownloadFile] File access error:', {
        filePath,
        error: err.message,
        contentId: content._id,
        __dirname: path.resolve(__dirname, '..')
      });
      return res.status(404).json({
        success: false,
        message: 'File not available on server. Please contact instructor.'
      });
    }

    console.log('[DownloadFile] Sending file:', { filePath, fileName });

    // Get file stats for Content-Length header
    const fileStats = await fs.stat(filePath);
    console.log('[DownloadFile] File size:', fileStats.size, 'bytes');

    // Use Express's built-in download method (more reliable than streaming)
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('[DownloadFile] Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error downloading file'
          });
        }
      } else {
        console.log('[DownloadFile] File sent successfully');
      }
    });
  } catch (error) {
    console.error('[DownloadFile] Download file error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to download file'
      });
    }
  }
};

// @desc    Submit student assignment/project
// @route   POST /api/contents/:id/submission
// @access  Private (Student)
exports.submitStudentAssignment = async (req, res) => {
  try {
    const content = await Content.findById(req.params.id);
    
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'assignment' && content.type !== 'project') {
      return res.status(400).json({
        success: false,
        message: 'Only assignments and projects can be submitted'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please upload a file'
      });
    }

    // Create or update grade record with submitted status and 50% initial grade
    let grade = await StudentContentGrade.findOne({
      student: req.user.id,
      content: content._id
    });

    if (grade) {
      grade.status = 'submitted_ungraded'; // Use consistent status
      grade.submittedAt = new Date();
      grade.gradePercent = 50; // Initial 50% grade on submission
      grade.submissionFile = {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        path: req.file.path,
        size: req.file.size
      };
      await grade.save();
    } else {
      grade = await StudentContentGrade.create({
        student: req.user.id,
        content: content._id,
        course: content.course,
        section: content.section,
        status: 'submitted_ungraded', // Use consistent status
        gradePercent: 50, // Initial 50% grade on submission
        submittedAt: new Date(),
        submissionFile: {
          originalName: req.file.originalname,
          storedName: req.file.filename,
          path: req.file.path,
          size: req.file.size
        }
      });
    }

    // Update or create student progress
    let progress = await StudentProgress.findOne({
      student: req.user.id,
      content: content._id
    });

    if (progress) {
      progress.submitted = true;
      progress.submittedAt = new Date();
      progress.completed = false; // Not completed until fully graded
      await progress.save();
    } else {
      progress = await StudentProgress.create({
        student: req.user.id,
        item: content._id,
        content: content._id,
        course: content.course,
        group: content.group,
        section: content.section,
        type: content.type,
        contentType: content.type,
        submitted: true,
        submittedAt: new Date(),
        completed: false
      });
    }

    // Gamification: award points for assignment/project submission and optionally course completion
    let assignmentAward = null;
    try {
      const actionType = content.type === 'project' ? 'project' : 'assignment';
      assignmentAward = await awardPointsInternal(req.user.id, actionType);
    } catch (e) {}

    let courseAward = null;
    try {
      const prev = await CourseGrade.findOne({ student: req.user.id, course: content.course });
      await calculateCourseGrade(req.user.id, content.course);
      const now = await CourseGrade.findOne({ student: req.user.id, course: content.course });
      if (!prev?.isComplete && now?.isComplete) {
        courseAward = await awardPointsInternal(req.user.id, 'course');
      }
    } catch (e) {}

    const gamification = {};

    if (assignmentAward && assignmentAward.success) {
      Object.assign(gamification, assignmentAward);
      gamification.assignmentAward = assignmentAward;
    }

    if (courseAward && courseAward.success) {
      gamification.courseAward = courseAward;
    }

    res.json({
      success: true,
      message: 'Assignment submitted successfully. Awaiting instructor review.',
      data: {
        grade,
        progress
      },
      gamification
    });
  } catch (error) {
    console.error('Submit assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit assignment',
      error: error.message
    });
  }
};
