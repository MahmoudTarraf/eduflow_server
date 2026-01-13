const Content = require('../models/Content');
const Section = require('../models/Section');
const StudentProgress = require('../models/StudentProgress');
const StudentContentGrade = require('../models/StudentContentGrade');
const DeleteRequest = require('../models/DeleteRequest');
const TelegramFile = require('../models/TelegramFile');
const YouTubeVideo = require('../models/YouTubeVideo');
const CloudinaryAsset = require('../models/CloudinaryAsset');
const fs = require('fs');
const path = require('path');
const { extractYouTubeVideoId, isValidYouTubeUrl, normalizeYouTubeUrl } = require('../utils/youtubeHelper');
const { streamTelegramFile } = require('../services/telegramFileService');
const { getVideoProvider, getFileProvider } = require('../services/storage');
const uploadService = require('../services/uploadService');
const { notifyAdminsAboutUploadIssue } = require('../utils/uploadIssueNotifier');
const {
  createJob,
  updateJob,
  getJob,
  attachJobRuntime
} = require('../services/videoUploadJobs');

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

// @desc    Get all content for a section
// @route   GET /api/sections/:sectionId/content
// @access  Private
exports.getContentBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;

    const query = { section: sectionId };
    const includeDeleted = req.user?.role === 'admin' && req.query?.includeDeleted === 'true';
    if (!includeDeleted) {
      query.deletionStatus = { $ne: 'deleted' };
    }

    const content = await Content.find(query)
      .populate('createdBy', 'name email')
      .sort({ type: 1, order: 1, createdAt: 1 });

    res.status(200).json({
      success: true,
      count: content.length,
      data: req.user?.role === 'instructor' ? content.map(stripYouTubeFieldsFromContent) : content
    });
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch content',
      error: error.message
    });
  }
};

// @desc    Upload lecture video
// @route   POST /api/sections/:sectionId/content/uploadLecture
// @access  Private (Instructor/Admin)
exports.uploadLecture = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { courseId, groupId } = req.params;
    const { 
      title, 
      description, 
      order, 
      materials,
      uploadSessionId
    } = req.body;

    const { type: providerType, service: videoService } = getVideoProvider();

    console.log('[ContentUpload] Lecture upload request received', {
      sectionId,
      courseId,
      groupId,
      title,
      providerType,
      hasFile: Boolean(req.file),
      hasMaterials: Boolean(materials),
      fileField: req.file?.fieldname,
      originalName: req.file?.originalname,
      storedName: req.file?.filename,
      tempPath: req.file?.path,
      size: req.file?.size,
      mimeType: req.file?.mimetype,
      userId: req.user?._id
    });

    const section = await Section.findById(sectionId).populate('course');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    // Parse materials if provided
    let parsedMaterials = [];
    if (materials) {
      parsedMaterials = typeof materials === 'string' ? JSON.parse(materials) : materials;
    }

    let videoData;
    const shouldTrackHostedProgress = providerType === 'youtube' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: req.user?._id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (req.file?.path) {
            await fs.promises.unlink(req.file.path).catch(() => {});
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
            await fs.promises.unlink(req.file.path).catch(() => {});
          }
        }
      });

      // If the client canceled very quickly, stop before starting the upstream upload.
      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (req.file?.path) {
          await fs.promises.unlink(req.file.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    if (providerType === 'youtube') {
      // Silent background upload to YouTube using the selected file
      if (!req.file) {
        console.warn('[ContentUpload] Lecture upload missing video file (YouTube mode)', { sectionId, providerType });
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
      const allowedVideoExtensions = /\.(mp4|webm|mkv|mov|avi|mpeg|mpg)$/i;

      if (!allowedVideoMime.includes(req.file.mimetype) && !allowedVideoExtensions.test(req.file.originalname || '')) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({
          success: false,
          message: 'Invalid video format. Allowed: MP4, WEBM, MKV, MOV, AVI'
        });
      }

      videoData = await videoService.uploadLessonVideo(req.file, {
        userId: req.user._id,
        title,
        description,
        courseId: section.course._id,
        sectionId,
        groupId: section.group,
        contentId: null,
        privacyStatus: 'unlisted',
        onProgress: shouldTrackHostedProgress
          ? ({ uploadedBytes, totalBytes: tb, percent }) => {
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
        updateJob(jobId, {
          status: 'processing',
          percent: 100,
          bytesUploaded: totalBytes,
          totalBytes
        });
      }
    } else {
      // Local provider: require a video file
      if (!req.file) {
        console.warn('[ContentUpload] Lecture upload missing video file', { sectionId, providerType });
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
      const allowedVideoExtensions = /\.(mp4|webm|mkv|mov|avi|mpeg|mpg)$/i;

      if (!allowedVideoMime.includes(req.file.mimetype) && !allowedVideoExtensions.test(req.file.originalname || '')) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({
          success: false,
          message: 'Invalid video format. Allowed: MP4, WEBM, MKV, MOV, AVI'
        });
      }

      videoData = await videoService.uploadLessonVideo(req.file, {
        userId: req.user._id
      });
    }

    const content = await Content.create({
      title,
      description: description || '',
      type: 'lecture',
      section: sectionId,
      group: section.group,
      course: section.course._id,
      video: videoData,
      // Legacy fields for backward compatibility (local mode only)
      videoPath: providerType === 'local' ? req.file?.filename : null,
      videoFileName: providerType === 'local' ? req.file?.originalname : null,
      materials: Array.isArray(parsedMaterials) ? parsedMaterials : [],
      order: order || 0,
      createdBy: req.user._id
    });

    if (providerType === 'youtube' && videoData?.youtubeVideoId) {
      await YouTubeVideo.findOneAndUpdate(
        {
          youtubeVideoId: videoData.youtubeVideoId,
          $or: [{ content: null }, { content: { $exists: false } }]
        },
        {
          content: content._id,
          course: section.course._id,
          section: sectionId,
          group: section.group
        },
        { new: true }
      );
    }

    if (shouldTrackHostedProgress) {
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    console.log('[ContentUpload] Lecture content created', {
      contentId: content._id,
      sectionId,
      providerType,
      storedName: req.file?.filename,
      path: req.file?.path
    });

    // Send email notification to enrolled students
    try {
      const { sendNewContentEmail } = require('../utils/emailNotifications');
      const Enrollment = require('../models/Enrollment');
      const User = require('../models/User');
      
      const enrollments = await Enrollment.find({ 
        course: section.course._id,
        status: 'enrolled'
      }).populate('student', 'email name');
      
      // Send emails in background
      enrollments.forEach(enrollment => {
        if (enrollment.student) {
          sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            content.title,
            section.course.name
          ).catch(err => console.error('Error sending content email:', err));
        }
      });
    } catch (emailError) {
      console.error('Error sending lecture upload emails:', emailError);
    }

    res.status(201).json({
      success: true,
      message: 'Lecture uploaded successfully',
      data: req.user?.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          updateJob(jobId, {
            status: 'canceled',
            error: null
          });
        }
      } catch (_) {}

      if (req.file?.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }

      return res.status(499).json({
        success: false,
        message: 'Upload canceled'
      });
    }

    try {
      const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
      if (jobId) {
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
        uploaderId: req.user?._id,
        uploaderName: req.user?.name,
        issueType: 'quota',
        context: 'lecture upload'
      });
      if (req.file?.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({
        success: false,
        message: 'Upload failed, please try again in a few hours'
      });
    }

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?._id,
        uploaderName: req.user?.name,
        issueType: 'auth',
        context: 'lecture upload'
      });
      if (req.file?.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({
        success: false,
        message: 'Upload failed, please contact admin'
      });
    }

    console.error('Error uploading lecture:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload lecture'
    });
  }
};

// @desc    Upload assignment file
// @route   POST /api/sections/:sectionId/content/uploadAssignment
// @access  Private (Instructor/Admin)
exports.uploadAssignment = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { 
      title, 
      description, 
      maxScore, 
      dueDate, 
      order, 
      materials,
      uploadSessionId
    } = req.body;

    const { type: fileProviderType, service: fileService } = getFileProvider();

    console.log('[ContentUpload] Assignment upload request received', {
      sectionId,
      title,
      fileProviderType,
      hasFile: Boolean(req.file),
      hasMaterials: Boolean(materials),
      originalName: req.file?.originalname,
      storedName: req.file?.filename,
      tempPath: req.file?.path,
      size: req.file?.size,
      mimeType: req.file?.mimetype,
      userId: req.user?._id
    });

    if (!req.file) {
      console.warn('[ContentUpload] Assignment upload missing file', { sectionId });
      return res.status(400).json({
        success: false,
        message: 'Assignment file is required'
      });
    }
    
    const section = await Section.findById(sectionId).populate('course');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    // Parse materials if provided
    let parsedMaterials = [];
    if (materials) {
      parsedMaterials = typeof materials === 'string' ? JSON.parse(materials) : materials;
    }

    // For now we keep the archive requirement for assignments to preserve existing behavior
    const allowedArchiveMimes = [
      'application/x-rar-compressed',
      'application/vnd.rar',
      'application/x-rar',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    const hasArchiveExtension = /(\.rar|\.zip)$/i.test(req.file.originalname);
    const hasArchiveMime = allowedArchiveMimes.includes(req.file.mimetype);
    if (!hasArchiveExtension && !hasArchiveMime) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        success: false,
        message: 'Assignments must be uploaded as .rar or .zip archives'
      });
    }

    const shouldTrackHostedProgress = fileProviderType === 'telegram' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: req.user?._id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (req.file?.path) {
            await fs.promises.unlink(req.file.path).catch(() => {});
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
            await fs.promises.unlink(req.file.path).catch(() => {});
          }
        }
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (req.file?.path) {
          await fs.promises.unlink(req.file.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const fileData = await fileService.uploadLessonFile(req.file, {
      userId: req.user._id,
      onProgress: shouldTrackHostedProgress
        ? ({ uploadedBytes, totalBytes: tb, percent }) => {
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
      group: section.group,
      course: section.course._id,
      file: fileData,
      // Legacy fields for backward compatibility (local mode only)
      filePath: fileProviderType === 'local' ? req.file.filename : null,
      fileName: req.file.originalname,
      materials: Array.isArray(parsedMaterials) ? parsedMaterials : [],
      maxScore: maxScore || 100,
      dueDate: dueDate || null,
      order: order || 0,
      createdBy: req.user._id
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
          uploadedBy: req.user._id,
          course: section.course._id,
          group: section.group,
          section: sectionId,
          content: content._id,
          contentType: 'assignment'
        });
      } catch (e) {
        console.error('[TelegramFileAudit] Failed to create TelegramFile record (assignment upload):', e.message);
      }
    }

    console.log('[ContentUpload] Assignment content created', {
      contentId: content._id,
      sectionId,
      fileProviderType,
      storedName: req.file.filename,
      path: req.file.path
    });

    // Send email notification to enrolled students
    try {
      const { sendNewContentEmail } = require('../utils/emailNotifications');
      const Enrollment = require('../models/Enrollment');
      
      const enrollments = await Enrollment.find({ 
        course: section.course._id,
        status: 'enrolled'
      }).populate('student', 'email name');
      
      // Send emails in background
      enrollments.forEach(enrollment => {
        if (enrollment.student) {
          sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            content.title,
            section.course.name
          ).catch(err => console.error('Error sending content email:', err));
        }
      });
    } catch (emailError) {
      console.error('Error sending assignment upload emails:', emailError);
    }

    if (shouldTrackHostedProgress) {
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    res.status(201).json({
      success: true,
      message: 'Assignment uploaded successfully',
      data: content
    });
  } catch (error) {
    console.error('Error uploading assignment:', error);

    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      // Clean up uploaded file if it exists (disk storage)
      if (req.file?.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }

      return res.status(499).json({
        success: false,
        message: 'Upload canceled'
      });
    }

    try {
      const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
      if (jobId) {
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

    // Clean up uploaded file if it exists (disk storage)
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }

    res.status(500).json({
      success: false,
      message: 'Failed to upload assignment'
    });
  }
};

// @desc    Upload project (video + starter file)
// @route   POST /api/sections/:sectionId/content/uploadProject
// @access  Private (Instructor/Admin)
exports.uploadProject = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { title, description, maxScore, dueDate, order, materials, uploadSessionId } = req.body;
    const { type: videoProviderType, service: videoService } = getVideoProvider();
    const { type: fileProviderType, service: fileService } = getFileProvider();
    console.log('[ContentUpload] Project upload request received', {
      sectionId,
      title,
      hasVideo: Boolean(req.files?.video?.length),
      hasStarter: Boolean(req.files?.file?.length),
      hasMaterials: Boolean(materials),
      videoOriginal: req.files?.video?.[0]?.originalname,
      videoStored: req.files?.video?.[0]?.filename,
      videoPath: req.files?.video?.[0]?.path,
      starterOriginal: req.files?.file?.[0]?.originalname,
      starterStored: req.files?.file?.[0]?.filename,
      starterPath: req.files?.file?.[0]?.path,
      userId: req.user?._id
    });

    if (!req.files || !req.files.video || !req.files.file) {
      console.warn('[ContentUpload] Project upload missing files', {
        sectionId,
        hasVideo: Boolean(req.files?.video),
        hasStarter: Boolean(req.files?.file)
      });
      return res.status(400).json({
        success: false,
        message: 'Both video and starter file are required for project'
      });
    }
    
    const section = await Section.findById(sectionId).populate('course');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    const videoFile = req.files.video[0];
    const starterFile = req.files.file[0];

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
      updateJob(jobId, {
        status: 'uploading',
        bytesUploaded,
        totalBytes,
        percent: toPercent(bytesUploaded, totalBytes)
      });
    };

    if (shouldTrackHostedProgress) {
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: req.user?._id, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (videoFile?.path) {
            await fs.promises.unlink(videoFile.path).catch(() => {});
          }
          if (starterFile?.path) {
            await fs.promises.unlink(starterFile.path).catch(() => {});
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
            await fs.promises.unlink(videoFile.path).catch(() => {});
          }
          if (starterFile?.path) {
            await fs.promises.unlink(starterFile.path).catch(() => {});
          }
        }
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (videoFile?.path) {
          await fs.promises.unlink(videoFile.path).catch(() => {});
        }
        if (starterFile?.path) {
          await fs.promises.unlink(starterFile.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const allowedVideoMime = [
      'video/mp4',
      'video/webm',
      'video/x-matroska',
      'video/quicktime',
      'video/x-msvideo',
      'application/octet-stream'
    ];
    const allowedVideoExtensions = /\.(mp4|webm|mkv|mov|avi|mpeg|mpg)$/i;
    if (!allowedVideoMime.includes(videoFile.mimetype) && !allowedVideoExtensions.test(videoFile.originalname || '')) {
      if (videoFile.path) {
        await fs.promises.unlink(videoFile.path).catch(() => {});
      }
      if (starterFile.path) {
        await fs.promises.unlink(starterFile.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Project video must be MP4, WEBM, MKV, MOV, or AVI'
      });
    }

    const allowedArchiveMimes = [
      'application/x-rar-compressed',
      'application/vnd.rar',
      'application/x-rar',
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream'
    ];
    const hasArchiveExtension = /\.(rar|zip)$/i.test(starterFile.originalname);
    const hasArchiveMime = allowedArchiveMimes.includes(starterFile.mimetype);
    if (!hasArchiveExtension && !hasArchiveMime) {
      if (videoFile.path) {
        await fs.promises.unlink(videoFile.path).catch(() => {});
      }
      if (starterFile.path) {
        await fs.promises.unlink(starterFile.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Project starter file must be a .rar or .zip archive'
      });
    }
    
    // Parse materials if provided
    let parsedMaterials = [];
    if (materials) {
      parsedMaterials = typeof materials === 'string' ? JSON.parse(materials) : materials;
    }

    const videoData = await videoService.uploadLessonVideo(videoFile, {
      userId: req.user._id,
      title,
      description,
      courseId: section.course._id,
      sectionId,
      groupId: section.group,
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
      userId: req.user._id,
      onProgress: shouldTrackHostedProgress && shouldTrackFileHostedProgress
        ? ({ uploadedBytes }) => {
            const base = shouldTrackVideoHostedProgress ? videoBytes : 0;
            const fileUploaded = Math.min(starterBytes, typeof uploadedBytes === 'number' ? uploadedBytes : 0);
            updateHostedProgress(base + fileUploaded);
          }
        : undefined,
      abortSignal: abortController?.signal
    });

    if (shouldTrackHostedProgress && shouldTrackFileHostedProgress) {
      const base = shouldTrackVideoHostedProgress ? videoBytes : 0;
      updateHostedProgress(base + starterBytes);
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
      type: 'project',
      section: sectionId,
      group: section.group,
      course: section.course._id,
      video: videoData,
      file: starterData,
      videoPath: videoProviderType === 'local' ? videoFile.filename : null,
      videoFileName: videoProviderType === 'local' ? videoFile.originalname : null,
      starterFilePath: fileProviderType === 'local' ? starterFile.filename : null,
      starterFileName: fileProviderType === 'local' ? starterFile.originalname : null,
      materials: Array.isArray(parsedMaterials) ? parsedMaterials : [],
      maxScore: maxScore || 100,
      dueDate: dueDate || null,
      order: order || 0,
      createdBy: req.user._id
    });

    if (videoProviderType === 'youtube' && videoData?.youtubeVideoId) {
      await YouTubeVideo.findOneAndUpdate(
        {
          youtubeVideoId: videoData.youtubeVideoId,
          $or: [{ content: null }, { content: { $exists: false } }]
        },
        {
          content: content._id,
          course: section.course._id,
          section: sectionId,
          group: section.group
        },
        { new: true }
      );
    }

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
          uploadedBy: req.user._id,
          course: section.course._id,
          group: section.group,
          section: sectionId,
          content: content._id,
          contentType: 'project'
        });
      } catch (e) {
        console.error('[TelegramFileAudit] Failed to create TelegramFile record (project upload):', e.message);
      }
    }

    console.log('[ContentUpload] Project content created', {
      contentId: content._id,
      sectionId,
      videoStored: videoFile.filename,
      videoPath: videoFile.path,
      starterStored: starterFile.filename,
      starterPath: starterFile.path
    });

    // Send email notification to enrolled students
    try {
      const { sendNewContentEmail } = require('../utils/emailNotifications');
      const Enrollment = require('../models/Enrollment');
      
      const enrollments = await Enrollment.find({ 
        course: section.course._id,
        status: 'enrolled'
      }).populate('student', 'email name');
      
      // Send emails in background
      enrollments.forEach(enrollment => {
        if (enrollment.student) {
          sendNewContentEmail(
            enrollment.student.email,
            enrollment.student.name,
            content.title,
            section.course.name
          ).catch(err => console.error('Error sending content email:', err));
        }
      });
    } catch (emailError) {
      console.error('Error sending project upload emails:', emailError);
    }

    if (shouldTrackHostedProgress) {
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId: content._id
      });
    }

    res.status(201).json({
      success: true,
      message: 'Project uploaded successfully',
      data: content
    });
  } catch (error) {
    console.error('Error uploading project:', error);

    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      if (req.files) {
        if (req.files.video && req.files.video[0]?.path) {
          await fs.promises.unlink(req.files.video[0].path).catch(() => {});
        }
        if (req.files.file && req.files.file[0]?.path) {
          await fs.promises.unlink(req.files.file[0].path).catch(() => {});
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

    // Clean up uploaded files if they exist (disk storage)
    if (req.files) {
      if (req.files.video && req.files.video[0]?.path) {
        await fs.promises.unlink(req.files.video[0].path).catch(() => {});
      }
      if (req.files.file && req.files.file[0]?.path) {
        await fs.promises.unlink(req.files.file[0].path).catch(() => {});
      }
    }

    res.status(500).json({
      success: false,
      message: 'Upload failed. Please try again.'
    });
  }
};

// @desc    Stream video with range support
// @route   GET /api/content/:contentId/stream
// @access  Private
exports.streamVideo = async (req, res) => {
  try {
    const { contentId } = req.params;
    console.log('[ContentStream] Incoming stream request', {
      contentId,
      userId: req.user?.id,
      userRole: req.user?.role,
      rangeHeader: req.headers.range || null
    });

    const item = await Content.findById(contentId)
      .populate('course', 'instructor')
      .populate('section', 'group');
    if (!item) {
      console.warn('[ContentStream] Content not found', { contentId });
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role !== 'admin' && item.deletionStatus === 'deleted') {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role === 'student' && !item.isPublished) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    console.log('[ContentStream] Content document snapshot', {
      contentId,
      type: item.type,
      hasNewVideoMeta: Boolean(item.video?.path),
      newVideoPath: item.video?.path,
      newVideoMime: item.video?.mimeType,
      legacyVideoPath: item.videoPath,
      uploadsDir: path.join(__dirname, '..', 'uploads', 'videos')
    });

    if (item.type !== 'lecture' && item.type !== 'project') {
      console.warn('[ContentStream] Content is not streamable video', {
        contentId,
        contentType: item.type
      });
      return res.status(400).json({
        success: false,
        message: 'This content is not a video'
      });
    }

    if (req.user.role === 'student') {
      const Section = require('../models/Section');
      const Group = require('../models/Group');

      const section = await Section.findById(item.section);
      if (!section) {
        return res.status(404).json({
          success: false,
          message: 'Section not found'
        });
      }

      if (!section.isFree) {
        const group = await Group.findById(item.group || section.group).select('students');
        const enrolled = group?.students?.some(s => s.student.toString() === req.user.id);
        if (!enrolled) {
          return res.status(403).json({
            success: false,
            message: 'Not enrolled in this group'
          });
        }
      }
    } else if (req.user.role === 'instructor') {
      if (item.course?.instructor?.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this content'
        });
      }
    }

    // Get video path
    let filePath;
    let mimeType;

    if (item.video && item.video.path) {
      filePath = item.video.path;
      mimeType = item.video.mimeType || 'video/mp4';
      console.log('[ContentStream] Using new video metadata', {
        contentId,
        storedName: item.video.storedName,
        originalName: item.video.originalName,
        path: filePath,
        mimeType
      });
    } else if (item.videoPath) {
      filePath = path.join(__dirname, '..', 'uploads', 'videos', item.videoPath);
      mimeType = 'video/mp4';
      console.log('[ContentStream] Using legacy video path', {
        contentId,
        videoPath: item.videoPath,
        resolvedPath: filePath,
        mimeType
      });
    } else {
      console.error('[ContentStream] No video path available', { contentId });
      return res.status(404).json({
        success: false,
        message: 'Video file not found'
      });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error('[ContentStream] Video file missing on disk', {
        contentId,
        attemptedPath: filePath
      });
      return res.status(404).json({
        success: false,
        message: 'Video file not found on server'
      });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    console.log('[ContentStream] File located', {
      contentId,
      filePath,
      fileSize,
      mimeType,
      hasRange: Boolean(range)
    });

    const logResponseEnd = (eventName) => {
      console.log('[ContentStream] Response stream ended', {
        contentId,
        event: eventName,
        filePath
      });
    };

    res.once('finish', () => logResponseEnd('finish'));
    res.once('close', () => logResponseEnd('close'));

    // Set CORS headers for video streaming
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (!range) {
      // No range header, send entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
      console.log('[ContentStream] Streaming full video', {
        contentId,
        filePath,
        fileSize
      });
      const fullStream = fs.createReadStream(filePath);
      fullStream.on('open', () => {
        console.log('[ContentStream] Read stream opened', { contentId, filePath, mode: 'full' });
      });
      fullStream.on('end', () => {
        console.log('[ContentStream] Read stream ended', { contentId, filePath, mode: 'full' });
      });
      fullStream.on('error', (streamErr) => {
        console.error('[ContentStream] Read stream error', {
          contentId,
          filePath,
          mode: 'full',
          error: streamErr.message
        });
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Stream error' });
        } else {
          res.destroy(streamErr);
        }
      });
      fullStream.pipe(res);
    } else {
      // Range request for partial content
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;

      const file = fs.createReadStream(filePath, { start, end });

      file.on('open', () => {
        console.log('[ContentStream] Read stream opened', {
          contentId,
          filePath,
          mode: 'range',
          rangeStart: start,
          rangeEnd: end
        });
      });

      file.on('end', () => {
        console.log('[ContentStream] Read stream ended', {
          contentId,
          filePath,
          mode: 'range',
          rangeStart: start,
          rangeEnd: end
        });
      });

      file.on('error', (streamErr) => {
        console.error('[ContentStream] Read stream error', {
          contentId,
          filePath,
          mode: 'range',
          rangeStart: start,
          rangeEnd: end,
          error: streamErr.message
        });
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Stream error' });
        } else {
          res.destroy(streamErr);
        }
      });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=3600'
      });

      console.log('[ContentStream] Streaming ranged video chunk', {
        contentId,
        filePath,
        fileSize,
        rangeStart: start,
        rangeEnd: end,
        chunkSize
      });

      file.pipe(res);
    }
  } catch (error) {
    console.error('Error streaming video:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stream video',
      error: error.message
    });
  }
};

// @route   GET /api/content/:contentId/download
// @access  Private
exports.downloadFile = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { type } = req.query; // 'video', 'starter', or default to file
    
    const item = await Content.findById(contentId);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role !== 'admin' && item.deletionStatus === 'deleted') {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (req.user?.role === 'student' && !item.isPublished) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }
    
    if (item.file?.storageType === 'telegram' && item.file?.telegramFileId && type !== 'video') {
      const fileName =
        item.file.telegramFileName ||
        item.file.originalName ||
        item.file.storedName ||
        item.file.filename ||
        (type === 'starter' ? item.title + '_starter.rar' : item.title + '.rar');
      
      return streamTelegramFile(item.file.telegramFileId, res, {
        asAttachment: true,
        filename: fileName
      });
    }

    let filePath;
    let fileName;
    
    // Download video for projects
    if (type === 'video' && (item.type === 'project' || item.type === 'lecture')) {
      if (item.video && item.video.path) {
        filePath = item.video.path;
        fileName = item.video.originalName || item.video.storedName || item.video.filename || (item.title + '.mp4');
      } else if (item.videoPath) {
        filePath = path.join(__dirname, '..', 'uploads', 'videos', item.videoPath);
        fileName = item.videoFileName || (item.title + '.mp4');
      }
    }
    // Download starter file for projects
    else if (type === 'starter' && item.type === 'project') {
      if (item.file && item.file.path) {
        filePath = item.file.path;
        fileName = item.file.originalName || item.file.storedName || item.file.filename || (item.title + '_starter.rar');
      } else if (item.starterFilePath) {
        filePath = path.join(__dirname, '..', 'uploads', 'files', item.starterFilePath);
        fileName = item.starterFileName || (item.title + '_starter.rar');
      }
    }
    // Default: download assignment file or project file
    else {
      if (item.file && item.file.path) {
        filePath = item.file.path;
        fileName = item.file.originalName || item.file.storedName || item.file.filename || (item.title + '.rar');
      } else if (item.filePath) {
        filePath = path.join(__dirname, '..', 'uploads', 'files', item.filePath);
        fileName = item.fileName || (item.title + '.rar');
      }
    }
    
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'File not found on server. Path: ' + filePath
      });
    }
    
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Failed to download file'
          });
        }
      }
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to download file'
    });
  }
};

// @desc    Update content
// @route   PUT /api/content/:contentId
// @access  Private (Instructor/Admin)
exports.updateContent = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { title, description, maxScore, dueDate, order, materials } = req.body;
    
    console.log('[ContentUpdate] Update request received:', {
      contentId,
      hasFile: Boolean(req.file),
      hasFiles: Boolean(req.files),
      hasMaterials: Boolean(materials),
      fileField: req.file?.fieldname,
      fileName: req.file?.originalname,
      fileSize: req.file?.size,
      userId: req.user?._id
    });
    
    const content = await Content.findById(contentId).populate({ path: 'course', select: 'instructor' });
    if (!content) {
      console.warn('[ContentUpdate] Content not found:', contentId);
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }
    
    console.log('[ContentUpdate] Updating content:', {
      contentId,
      currentType: content.type,
      hasExistingVideo: Boolean(content.video?.path),
      hasExistingFile: Boolean(content.file?.path)
    });
    
    // Check permissions
    if (req.user.role !== 'admin' && content.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    // Update metadata
    if (title) content.title = title;
    if (description !== undefined) content.description = description;
    if (maxScore !== undefined) content.maxScore = maxScore;
    if (dueDate !== undefined) content.dueDate = dueDate;
    if (order !== undefined) content.order = order;
    
    // Update materials (links and resources)
    if (materials !== undefined) {
      // Parse materials if it's a JSON string
      const parsedMaterials = typeof materials === 'string' ? JSON.parse(materials) : materials;
      content.materials = Array.isArray(parsedMaterials) ? parsedMaterials : [];
    }
    
    // Handle file replacements
    if (req.file) {
      // Delete old file
      if (content.type === 'lecture' && content.video && content.video.path) {
        if (fs.existsSync(content.video.path)) fs.unlinkSync(content.video.path);
      } else if (content.file && content.file.path) {
        if (fs.existsSync(content.file.path)) fs.unlinkSync(content.file.path);
      }
      
      // Update with new file
      if (content.type === 'lecture') {
        content.video = {
          filename: req.file.filename,
          path: req.file.path,
          mimetype: req.file.mimetype,
          size: req.file.size
        };
      } else {
        content.file = {
          filename: req.file.filename,
          path: req.file.path,
          mimetype: req.file.mimetype,
          size: req.file.size
        };
      }
    }
    
    // Handle project files (video and file separately)
    if (req.files) {
      if (req.files.video && req.files.video[0]) {
        if (content.video && content.video.path && fs.existsSync(content.video.path)) {
          fs.unlinkSync(content.video.path);
        }
        content.video = {
          filename: req.files.video[0].filename,
          path: req.files.video[0].path,
          mimetype: req.files.video[0].mimetype,
          size: req.files.video[0].size
        };
      }
      if (req.files.file && req.files.file[0]) {
        if (content.file && content.file.path && fs.existsSync(content.file.path)) {
          fs.unlinkSync(content.file.path);
        }
        content.file = {
          filename: req.files.file[0].filename,
          path: req.files.file[0].path,
          mimetype: req.files.file[0].mimetype,
          size: req.files.file[0].size
        };
      }
    }
    
    await content.save();
    
    console.log('[ContentUpdate] Content updated successfully:', {
      contentId: content._id,
      type: content.type,
      hasVideo: Boolean(content.video?.path),
      hasFile: Boolean(content.file?.path)
    });
    
    res.status(200).json({
      success: true,
      message: 'Content updated successfully',
      data: req.user?.role === 'instructor' ? stripYouTubeFieldsFromContent(content) : content
    });
  } catch (error) {
    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      console.error('[ContentUpdate] Blocked (platform YouTube token issue):', {
        contentId: req.params.contentId,
        code: error.code,
        message: error.message,
        cause: error.cause
      });

      // Clean up uploaded files if update failed
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if (req.files) {
        if (req.files.video && req.files.video[0]?.path && fs.existsSync(req.files.video[0].path)) {
          fs.unlinkSync(req.files.video[0].path);
        }
        if (req.files.file && req.files.file[0]?.path && fs.existsSync(req.files.file[0].path)) {
          fs.unlinkSync(req.files.file[0].path);
        }
      }

      return res.status(500).json({
        success: false,
        message: 'Video uploads are temporarily disabled. Contact support.'
      });
    }

    console.error('[ContentUpdate] Error updating content:', {
      contentId: req.params.contentId,
      error: error.message,
      stack: error.stack
    });
    
    // Clean up uploaded files if update failed
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    if (req.files) {
      if (req.files.video && req.files.video[0]?.path && fs.existsSync(req.files.video[0].path)) {
        fs.unlinkSync(req.files.video[0].path);
      }
      if (req.files.file && req.files.file[0]?.path && fs.existsSync(req.files.file[0].path)) {
        fs.unlinkSync(req.files.file[0].path);
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to update content',
      error: error.message
    });
  }
};

// @desc    Reorder content
// @route   PUT /api/sections/:sectionId/content/reorder
// @access  Private (Instructor/Admin)
exports.reorderContent = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { contentIds, type } = req.body;
    
    if (!contentIds || !Array.isArray(contentIds)) {
      return res.status(400).json({
        success: false,
        message: 'Content IDs array is required'
      });
    }
    
    const section = await Section.findById(sectionId).populate('course');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    // Update order for each content item
    const updatePromises = contentIds.map((contentId, index) => {
      return Content.findByIdAndUpdate(contentId, { order: index + 1 }, { new: true });
    });
    
    await Promise.all(updatePromises);
    
    res.status(200).json({
      success: true,
      message: 'Content reordered successfully'
    });
  } catch (error) {
    console.error('Error reordering content:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reorder content',
      error: error.message
    });
  }
};

// (Content archiving has been removed; content is now either published or deleted by admins.)

// @desc    Delete content
// @route   DELETE /api/content/:contentId
// @access  Private (Instructor/Admin)
exports.deleteContent = async (req, res) => {
  try {
    const contentId = req.params.contentId || req.params.id;

    if (!contentId) {
      return res.status(400).json({
        success: false,
        message: 'Content id is required'
      });
    }
    
    const content = await Content.findById(contentId).populate({ path: 'course', select: 'instructor' });
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }
    
    // Permissions & progress rules (route already restricts to admin; keep extra guard for safety)
    if (req.user.role !== 'admin') {
      const userId = req.user._id || req.user.id;

      if (!content.course || content.course.instructor.toString() !== String(userId)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to delete this content'
        });
      }

      const hasProgress = await StudentProgress.exists({ $or: [{ item: contentId }, { content: contentId }] });
      if (hasProgress) {
        return res.status(400).json({
          success: false,
          message: 'This content has student progress and cannot be deleted.'
        });
      }
    }

    // Soft-delete only: remove from student visibility, retain all audit records.
    // Platform must never delete YouTube videos automatically.
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
        { content: contentId, status: 'active' },
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
      contentId,
      {
        isPublished: false,
        deletionStatus: 'deleted',
        deletedAt: new Date(),
        deletedBy: req.user._id || req.user.id
      },
      { new: true }
    );
    
    res.status(200).json({
      success: true,
      message: 'Content deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting content:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete content',
      error: error.message
    });
  }
};

module.exports = exports;
