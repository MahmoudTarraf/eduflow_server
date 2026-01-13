const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs').promises;
const jwt = require('jsonwebtoken');
const InstructorAgreement = require('../models/InstructorAgreement');
const User = require('../models/User');
const PayoutAuditLog = require('../models/PayoutAuditLog');
const AdminSettings = require('../models/AdminSettings');
const { sendEmail } = require('../utils/sendEmail');
const { constructUploadPath, constructFileUrl } = require('../utils/urlHelper');
const { getVideoProvider } = require('../services/storage');
const { notifyAdminsAboutUploadIssue } = require('../utils/uploadIssueNotifier');

const formatIntroVideoTitle = (instructorName) => {
  const name = typeof instructorName === 'string' && instructorName.trim()
    ? instructorName.trim()
    : 'Instructor';
  const date = new Date().toISOString().slice(0, 10);
  return `${name} ${date} introduction video`;
};

// Agreement text template
const AGREEMENT_TEXT_V1 = `
INSTRUCTOR AGREEMENT - EduFlow Academy

1. PAYOUT STRUCTURE
   - You will receive {{PERCENTAGE}}% of all student payments for your courses
   - The platform retains {{ADMIN_PERCENTAGE}}% for operational costs, payment processing, and platform maintenance

2. PAYOUT RULES
   - Minimum payout amount: $10 USD (or equivalent in other currencies)
   - Payout requests are processed within 2-7 business days
   - All payouts require admin verification
   - You must provide valid receiver details for payouts

3. PAYMENT PROCESSING
   - Students pay directly to the platform
   - Your earnings are calculated and tracked automatically
   - You can request withdrawal when your balance reaches the minimum threshold
   - The admin reserves the right to verify all payment receipts and payout requests

By accepting this agreement, you acknowledge that you have read, understood, and agree to be bound by these terms.

Version: v1.0
Last Updated: {{DATE}}
`;

// @desc    Get agreement text
// @route   GET /api/instructor/agreement-text
// @access  Public (for instructors during signup)
exports.getAgreementText = async (req, res) => {
  try {
    // Get admin settings
    const settings = await AdminSettings.findById('admin_settings');
    
    console.log('[Agreement] Settings found:', !!settings);
    console.log('[Agreement] Agreement text exists:', !!settings?.agreementText);
    console.log('[Agreement] Instructor %:', settings?.instructorRevenuePercentage);
    console.log('[Agreement] Platform %:', settings?.platformRevenuePercentage);
    
    // Use custom agreement text if available, otherwise use template
    let agreementText;
    let instructorPercentage;
    let adminPercentage;
    
    if (settings && settings.agreementText) {
      // Use admin-configured agreement text
      agreementText = settings.agreementText;
      instructorPercentage = settings.instructorRevenuePercentage || 70;
      adminPercentage = settings.platformRevenuePercentage || 30;
      
      // Replace placeholders in the agreement text
      agreementText = agreementText
        .replace(/{instructorPercentage}/g, instructorPercentage)
        .replace(/{platformPercentage}/g, adminPercentage);
      
      console.log('[Agreement] Using admin settings agreement');
    } else {
      // Fall back to template
      instructorPercentage = 80;
      adminPercentage = 20;
      
      agreementText = AGREEMENT_TEXT_V1
        .replace('{{PERCENTAGE}}', instructorPercentage)
        .replace('{{ADMIN_PERCENTAGE}}', adminPercentage)
        .replace('{{DATE}}', new Date().toLocaleDateString());
      
      console.log('[Agreement] Using default template');
    }

    res.json({
      success: true,
      data: {
        text: agreementText,
        version: 'v1.0',
        instructorPercentage,
        adminPercentage
      }
    });
  } catch (error) {
    console.error('Get agreement text error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agreement text'
    });
  }
};

// @desc    Get all instructor signup agreements (admin)
// @route   GET /api/instructor/admin/all
// @access  Private (Admin)
exports.getAllSignupAgreements = async (req, res) => {
  try {
    const agreements = await InstructorAgreement.find({})
      .populate('instructor', 'name email status isDeleted agreementPdfUrl')
      .sort({ updatedAt: -1, createdAt: -1 });

    const data = (agreements || []).map((agreement) => {
      const obj = agreement.toObject();
      if (obj.instructor && obj.instructor.agreementPdfUrl) {
        obj.instructor.agreementPdfUrl = constructFileUrl(obj.instructor.agreementPdfUrl);
      }
      return obj;
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get all signup agreements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch signup agreements'
    });
  }
};

// @desc    Submit instructor agreement with video
// @route   POST /api/instructor/submit-agreement
// @access  Private (Instructor)
exports.submitAgreement = async (req, res) => {
  // Disable transactions for standalone MongoDB - they require a replica set
  const useTransaction = false;
  const session = null;

  try {
    const instructorId = req.user.id;
    const { agreedToTerms, agreementText, agreementVersion = 'v1.0', uploadSessionId } = req.body;

    const existing = await InstructorAgreement.findOne({ instructor: instructorId });
    if (existing && existing.status !== 'rejected') {
      return res.status(400).json({
        success: false,
        message: 'Agreement already submitted'
      });
    }

    if (!agreedToTerms) {
      return res.status(400).json({
        success: false,
        message: 'You must agree to the terms'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Introduction video is required'
      });
    }

    const { type: providerType, service: videoService } = getVideoProvider();
    const shouldTrackHostedProgress = providerType === 'youtube' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      const { createJob, updateJob, attachJobRuntime, getJob } = require('../services/videoUploadJobs');
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: instructorId, totalBytes, replaceIfExists: true });
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

    // Get percentage from admin settings
    const settings = await AdminSettings.findById('admin_settings');
    const instructorPercentage = settings?.instructorRevenuePercentage || 70;
    
    const instructor = await User.findById(instructorId);

    let introductionVideo;
    if (providerType === 'youtube') {
      const uploaded = await videoService.uploadLessonVideo(req.file, {
        userId: instructorId,
        title: formatIntroVideoTitle(instructor?.name),
        description: '',
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

      introductionVideo = {
        originalName: req.file.originalname,
        storageType: 'youtube',
        storedName: uploaded.youtubeVideoId,
        url: uploaded.youtubeUrl,
        youtubeVideoId: uploaded.youtubeVideoId,
        youtubeUrl: uploaded.youtubeUrl,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: uploaded.uploadedAt || new Date()
      };
    } else {
      const videoDir = path.join(__dirname, '../uploads/instructor-videos');
      await fs.mkdir(videoDir, { recursive: true });

      const ext = path.extname(req.file.originalname);
      const videoFileName = `${instructorId}_intro_${Date.now()}${ext}`;
      const videoPath = path.join(videoDir, videoFileName);
      await fs.rename(req.file.path, videoPath);

      introductionVideo = {
        originalName: req.file.originalname,
        storageType: 'local',
        storedName: videoFileName,
        url: constructUploadPath('instructor-videos', videoFileName),
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      };
    }

    const agreement = new InstructorAgreement({
      instructor: instructorId,
      agreedToTerms: true,
      instructorPercentage,
      agreementText,
      agreementVersion,
      introductionVideo,
      status: 'pending'
    });
    await agreement.save();

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });
    }

    instructor.instructorAgreementAccepted = true;
    instructor.instructorVideoSubmitted = true;
    await instructor.save();

    const admins = await User.find({ role: 'admin' });
    for (const admin of admins) {
      admin.notifications.push({
        message: `New instructor signup: ${instructor.name} submitted agreement and video`,
        type: 'info',
        read: false
      });
      await admin.save();
    }

    res.status(201).json({
      success: true,
      message: 'Agreement submitted successfully. Your profile is under review.',
      data: agreement
    });
  } catch (error) {
    console.error('Submit agreement error:', error);
    try {
      const jobId = req.body?.uploadSessionId;
      if (jobId) {
        const { updateJob } = require('../services/videoUploadJobs');
        updateJob(String(jobId), {
          status: 'failed',
          error: 'Upload failed'
        });
      }
    } catch (_) {}

    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(499).json({ success: false, message: 'Upload canceled' });
    }

    if (error?.code === 'YT_QUOTA_EXCEEDED' && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'quota',
        context: 'intro video upload (submit agreement)'
      });
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({ success: false, message: 'Upload failed, please try again in a few hours' });
    }

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'auth',
        context: 'intro video upload (submit agreement)'
      });
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({ success: false, message: 'Upload failed, please contact admin' });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit agreement'
    });
  }
};

// @desc    Get pending instructor agreements (admin)
// @route   GET /api/admin/pending-instructors
// @access  Private (Admin)
exports.getPendingAgreements = async (req, res) => {
  try {
    const agreements = await InstructorAgreement.find({ status: 'pending' })
      .populate('instructor', 'name email phone')
      .sort({ submittedAt: 1 });

    res.json({
      success: true,
      data: agreements
    });
  } catch (error) {
    console.error('Get pending agreements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending agreements'
    });
  }
};

// @desc    Approve instructor agreement (admin)
// @route   PUT /api/admin/instructors/:id/approve-agreement
// @access  Private (Admin)
exports.approveAgreement = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const { instructorPercentage } = req.body;
    const adminId = req.user.id;

    const agreement = await InstructorAgreement.findOne({ instructor: id })
      .populate('instructor', 'name email');

    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    if (agreement.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Only pending agreements can be approved' });
    }

    agreement.status = 'approved';
    agreement.reviewedAt = new Date();
    agreement.reviewedBy = adminId;
    if (instructorPercentage) {
      agreement.instructorPercentage = instructorPercentage;
    }
    await agreement.save();

    const instructor = await User.findById(id);
    instructor.instructorStatus = 'approved';
    if (instructorPercentage) {
      instructor.instructorPercentage = instructorPercentage;
    }
    await instructor.save();

    instructor.notifications.push({
      message: 'Congratulations! Your instructor account has been approved. You can now start creating courses.',
      type: 'success',
      read: false
    });
    await instructor.save();

    try {
      await sendEmail({
        email: instructor.email,
        subject: 'Instructor Account Approved - Welcome to EduFlow!',
        message: `Congratulations ${instructor.name}! Your instructor account has been approved. You can now log in and start creating courses.`
      });
    } catch (emailError) {
      console.error('Approval email failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Instructor approved successfully',
      data: agreement
    });
  } catch (error) {
    console.error('Approve agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve instructor'
    });
  }
};

// @desc    Reject instructor agreement (admin)
// @route   PUT /api/admin/instructors/:id/reject-agreement
// @access  Private (Admin)
exports.rejectAgreement = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const { reason, allowResubmission = true } = req.body;
    const adminId = req.user.id;

    if (!reason || reason.trim().length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required (minimum 20 characters)'
      });
    }

    const agreement = await InstructorAgreement.findOne({ instructor: id })
      .populate('instructor', 'name email');

    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    agreement.status = 'rejected';
    agreement.rejectionReason = reason;
    agreement.allowResubmission = allowResubmission;
    agreement.reviewedAt = new Date();
    agreement.reviewedBy = adminId;
    await agreement.save();

    const instructor = await User.findById(id);
    instructor.instructorStatus = 'rejected';
    instructor.notifications.push({
      message: `Your instructor application has been rejected. Reason: ${reason}`,
      type: 'error',
      read: false
    });
    await instructor.save();

    try {
      await sendEmail({
        email: instructor.email,
        subject: 'Instructor Application - Action Required',
        message: `Your instructor application has been reviewed.\n\nReason for rejection: ${reason}\n\n${allowResubmission ? 'You can resubmit your application with corrections.' : 'Please contact support for more information.'}`
      });
    } catch (emailError) {
      console.error('Rejection email failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Instructor rejected',
      data: agreement
    });
  } catch (error) {
    console.error('Reject agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject instructor'
    });
  }

};

exports.reuploadIntroVideo = async (req, res) => {
  try {
    const instructorId = req.user.id;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Introduction video is required'
      });
    }

    const agreement = await InstructorAgreement.findOne({ instructor: instructorId });
    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    // If the agreement was explicitly rejected and resubmission is disabled, block reupload.
    // For approved/pending agreements, allow intro video updates (subject to maxReuploads).
    if (agreement.status === 'rejected' && agreement.allowResubmission === false) {
      return res.status(403).json({ success: false, message: 'Resubmission not allowed for this rejection' });
    }

    const settings = await AdminSettings.getSettings();
    const maxReuploads = typeof settings.introVideoMaxReuploads === 'number'
      ? settings.introVideoMaxReuploads
      : 3;

    if (
      maxReuploads >= 0 &&
      agreement.reuploadAttempts !== undefined &&
      agreement.reuploadAttempts >= maxReuploads
    ) {
      return res.status(400).json({
        success: false,
        message: `Maximum intro video reupload attempts reached (${maxReuploads}). Please contact admin.`
      });
    }

    const { type: providerType, service: videoService } = getVideoProvider();
    const uploadSessionId = req.body?.uploadSessionId;
    const shouldTrackHostedProgress = providerType === 'youtube' && Boolean(uploadSessionId);
    const totalBytes = typeof req.file?.size === 'number' ? req.file.size : null;
    const abortController = shouldTrackHostedProgress && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    let jobId = null;

    if (shouldTrackHostedProgress) {
      const { createJob, updateJob, attachJobRuntime, getJob } = require('../services/videoUploadJobs');
      jobId = String(uploadSessionId);
      try {
        createJob({ id: jobId, ownerId: instructorId, totalBytes, replaceIfExists: true });
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

    const previousStorageType = agreement?.introductionVideo?.storageType || 'local';

    let introVideo;
    if (providerType === 'youtube') {
      const instructor = await User.findById(instructorId).select('name');
      const uploaded = await videoService.uploadLessonVideo(req.file, {
        userId: instructorId,
        title: formatIntroVideoTitle(instructor?.name),
        description: '',
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

      introVideo = {
        originalName: req.file.originalname,
        storageType: 'youtube',
        storedName: uploaded.youtubeVideoId,
        url: uploaded.youtubeUrl,
        youtubeVideoId: uploaded.youtubeVideoId,
        youtubeUrl: uploaded.youtubeUrl,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: uploaded.uploadedAt || new Date()
      };
    } else {
      const videoDir = path.join(__dirname, '../uploads/instructor-videos');
      await fs.mkdir(videoDir, { recursive: true });

      const ext = path.extname(req.file.originalname);
      const videoFileName = `${instructorId}_intro_${Date.now()}${ext}`;
      const videoPath = path.join(videoDir, videoFileName);
      await fs.rename(req.file.path, videoPath);

      introVideo = {
        originalName: req.file.originalname,
        storageType: 'local',
        storedName: videoFileName,
        url: constructUploadPath('instructor-videos', videoFileName),
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      };
    }

    if (previousStorageType !== 'youtube') {
      try {
        if (agreement.introductionVideo && agreement.introductionVideo.storedName) {
          const oldPath = path.join(
            __dirname,
            '../uploads/instructor-videos',
            agreement.introductionVideo.storedName
          );
          await fs.unlink(oldPath).catch(() => {});
        }
      } catch (_) {}
    }

    agreement.introductionVideo = introVideo;

    agreement.status = 'pending';
    agreement.rejectionReason = undefined;
    agreement.reviewedAt = null;
    agreement.reviewedBy = null;
    agreement.submittedAt = new Date();
    agreement.reuploadAttempts = (agreement.reuploadAttempts || 0) + 1;
    await agreement.save();

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });
    }

    const instructor = await User.findById(instructorId);
    if (instructor) {
      instructor.instructorVideoSubmitted = true;
      await instructor.save();
    }

    return res.json({
      success: true,
      message: 'Video reuploaded successfully. Your application is back in the review queue.',
      data: agreement
    });
  } catch (error) {
    console.error('Reupload intro video error:', error);
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

    if (error?.code === 'YT_QUOTA_EXCEEDED' && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'quota',
        context: 'intro video reupload'
      });
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({ success: false, message: 'Upload failed, please try again in a few hours' });
    }

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      await notifyAdminsAboutUploadIssue({
        uploaderId: req.user?.id,
        uploaderName: req.user?.name,
        issueType: 'auth',
        context: 'intro video reupload'
      });
      if (req.file?.path) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      return res.status(500).json({
        success: false,
        message: 'Upload failed, please contact admin'
      });
    }

    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    res.status(500).json({
      success: false,
      message: 'Failed to upload video, please contact admin'
    });
  }
};

exports.adminResetIntroVideo = async (req, res) => {
  try {
    const { id } = req.params;
    const agreement = await InstructorAgreement.findOne({ instructor: id });
    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }
    agreement.allowResubmission = true;
    agreement.reuploadAttempts = 0;
    if (agreement.status !== 'pending') {
      agreement.status = 'rejected';
    }
    await agreement.save();
    return res.json({ success: true, message: 'Intro video reupload reset. Instructor can reupload again.', data: { reuploadAttempts: agreement.reuploadAttempts, status: agreement.status } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to reset reupload status' });
  }
};

exports.adminResetAllIntroVideos = async (req, res) => {
  try {
    const result = await InstructorAgreement.updateMany(
      {},
      {
        $set: {
          reuploadAttempts: 0,
          allowResubmission: true
        }
      }
    );

    const modifiedCount =
      typeof result.modifiedCount === 'number'
        ? result.modifiedCount
        : (typeof result.nModified === 'number' ? result.nModified : 0);

    return res.json({
      success: true,
      message: `Intro video reupload attempts reset for ${modifiedCount} instructor agreement(s).`,
      data: { modifiedCount }
    });
  } catch (error) {
    console.error('Admin reset all intro video attempts error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reset intro video attempts for all instructors'
    });
  }
};

// @desc    Get instructor introduction video
// @route   GET /api/instructor/:id/intro-video
// @access  Public
exports.getInstructorVideo = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Best-effort viewer identification for access control.
    // This route is public (no protect middleware), but if a JWT is provided
    // via Authorization header or ?token=, we decode it to determine whether
    // the viewer is an admin or the instructor themselves.
    if (!req.user) {
      let token;
      if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      } else if (req.query && req.query.token) {
        token = req.query.token;
      }

      if (token) {
        try {
          const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
          if (secret) {
            const decoded = jwt.verify(token, secret);
            // Load minimal user info required for role/id checks
            const viewer = await User.findById(decoded.id).select('role');
            if (viewer) {
              req.user = viewer;
            }
          }
        } catch (e) {
          // Invalid/expired token – treat as public viewer
        }
      }
    }

    const agreement = await InstructorAgreement.findOne({ instructor: id })
      .select('introductionVideo status');
    
    if (!agreement || !agreement.introductionVideo) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    if (
      agreement?.introductionVideo?.storageType === 'youtube' ||
      agreement?.introductionVideo?.youtubeVideoId
    ) {
      return res.status(404).json({
        success: false,
        message: 'Video file not found'
      });
    }
    
    const viewerRole = req.user?.role;
    const viewerId = req.user?._id?.toString?.() || req.user?.id?.toString?.();
    const isInstructorSelf = viewerRole === 'instructor' && viewerId === id.toString();
    const isAdmin = viewerRole === 'admin';

    // Public viewers may only see approved videos.
    // Instructors can always preview their own intro video.
    // Admins can always view any intro video for review.
    if (agreement.status !== 'approved' && !isAdmin && !isInstructorSelf) {
      return res.status(403).json({
        success: false,
        message: 'Video not available'
      });
    }
    
    const videoPath = path.join(__dirname, '../uploads/instructor-videos', agreement.introductionVideo.storedName);
    
    // Check if file exists
    try {
      await fs.access(videoPath);
    } catch {
      return res.status(404).json({
        success: false,
        message: 'Video file not found'
      });
    }
    
    const stat = await fs.stat(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Add CORS headers for video streaming
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    });
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = require('fs').createReadStream(videoPath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': agreement.introductionVideo.mimeType || 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': agreement.introductionVideo.mimeType || 'video/mp4',
        'Accept-Ranges': 'bytes',
      };
      res.writeHead(200, head);
      require('fs').createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    console.error('Get instructor video error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load video'
    });
  }
};

// @desc    Get instructor video info (for display without streaming)
// @route   GET /api/instructor/:id/video-info
// @access  Public
exports.getInstructorVideoInfo = async (req, res) => {
  try {
    const { id } = req.params;
    console.log('[VideoInfo] Fetching video info for instructor:', id);

    const agreement = await InstructorAgreement.findOne({ instructor: id })
      .populate('instructor', 'name email profilePhoto')
      .select('introductionVideo status');

    console.log('[VideoInfo] Agreement found:', !!agreement);
    console.log('[VideoInfo] Has video:', !!agreement?.introductionVideo);

    if (!agreement || !agreement.introductionVideo) {
      console.log('[VideoInfo] No video found for instructor:', id);
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    // Best-effort viewer identification for access control
    if (!req.user) {
      let token;
      if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      } else if (req.query && req.query.token) {
        token = req.query.token;
      }

      if (token) {
        try {
          const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
          if (secret) {
            const decoded = jwt.verify(token, secret);
            const viewer = await User.findById(decoded.id).select('role');
            if (viewer) {
              req.user = viewer;
            }
          }
        } catch (e) {
          // Invalid/expired token – treat as public viewer
        }
      }
    }

    const viewerRole = req.user?.role;
    const viewerId = req.user?._id?.toString?.() || req.user?.id?.toString?.();
    const isInstructorSelf = viewerRole === 'instructor' && viewerId === id.toString();
    const isAdmin = viewerRole === 'admin';

    // Public viewers may only see approved videos.
    // Instructors and admins can see any status for review/preview.
    if (agreement.status !== 'approved' && !isAdmin && !isInstructorSelf) {
      console.log('[VideoInfo] Hiding non-approved video from public viewer');
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    console.log('[VideoInfo] Returning video info');

    // Forward JWT (if any) to the video stream endpoint via query string so that
    // instructors and admins can authenticate inside an HTML5 <video> tag.
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = req.query.token;
    }

    const intro = agreement.introductionVideo || {};
    const storageType = intro.storageType || (intro.youtubeVideoId ? 'youtube' : 'local');

    let videoUrl;
    let youtubeVideoId;
    let youtubeUrl;

    if (storageType === 'youtube') {
      youtubeVideoId = intro.youtubeVideoId || null;
      youtubeUrl = intro.youtubeUrl || intro.url || null;
      videoUrl = youtubeUrl;
    } else {
      const baseVideoUrl = `/api/instructor/${id}/intro-video`;
      videoUrl = token ? `${baseVideoUrl}?token=${token}` : baseVideoUrl;
    }

    res.json({
      success: true,
      data: {
        hasVideo: true,
        videoUrl,
        storageType,
        youtubeVideoId,
        youtubeUrl,
        uploadedAt: agreement.introductionVideo.uploadedAt,
        status: agreement.status,
        instructor: agreement.instructor
      }
    });
  } catch (error) {
    console.error('[VideoInfo] Get instructor video info error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load video info'
    });
  }
};

module.exports = exports;
