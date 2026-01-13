const Content = require('../models/Content');
const StudentContentGrade = require('../models/StudentContentGrade');
const { awardPointsInternal, awardOnceForActivityInternal } = require('./gamification');
const { emitInstructorPendingSummaryUpdate } = require('./instructorDashboard');
const CourseGrade = require('../models/CourseGrade');
const { sendEmail } = require('../utils/sendEmail');
const {
  calculateSectionGrade,
  calculateCourseGrade,
  recordVideoWatched,
  recordAssignmentSubmission,
  gradeAssignment
} = require('../services/gradingService');
const { uploadAssignment, assignmentsDir } = require('../middleware/upload');
const { constructUploadPath } = require('../utils/urlHelper');
const path = require('path');
const { getFileProvider } = require('../services/storage');
const { streamTelegramFile } = require('../services/telegramFileService');

// @desc    Record that a student watched a video
// @route   POST /api/contents/:contentId/watched
// @access  Private (Student)
exports.recordWatched = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { watchedDuration, totalDuration } = req.body;
    const studentId = req.user.id;

    if (!watchedDuration || !totalDuration) {
      return res.status(400).json({
        success: false,
        message: 'watchedDuration and totalDuration are required'
      });
    }

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'lecture') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for lecture content'
      });
    }

    const grade = await recordVideoWatched(
      studentId,
      contentId,
      watchedDuration,
      totalDuration
    );

    res.json({
      success: true,
      message: grade.status === 'watched' ? 'Video marked as watched' : 'Progress recorded',
      data: grade
    });
  } catch (error) {
    console.error('Record watched error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record video progress',
      error: error.message
    });
  }
};

// @desc    Submit assignment (.rar file)
// @route   POST /api/contents/:contentId/submission
// @access  Private (Student)
exports.submitAssignment = async (req, res) => {
  try {
    const { contentId } = req.params;
    const studentId = req.user.id;
    const { uploadSessionId } = req.body || {};

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'assignment' && content.type !== 'project') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint is only for assignment or project content'
      });
    }

    // File should be uploaded via multer middleware before reaching here
    if (!req.file) {
      console.log('No file in request. Body:', req.body);
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please upload a .rar file'
      });
    }

    console.log('File uploaded:', req.file);

    const { type: fileProviderType, service: fileService } = getFileProvider();
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
        createJob({ id: jobId, ownerId: studentId, totalBytes, replaceIfExists: true });
      } catch (e) {
        if (e?.code === 'UPLOAD_SESSION_CANCELED') {
          if (req.file?.path) {
            const fs = require('fs').promises;
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
            const fs = require('fs').promises;
            await fs.unlink(req.file.path).catch(() => {});
          }
        }
      });

      const job = getJob(jobId);
      if (job?.status === 'canceled' || job?.status === 'canceling' || job?.canceled) {
        if (req.file?.path) {
          const fs = require('fs').promises;
          await fs.unlink(req.file.path).catch(() => {});
        }
        return res.status(499).json({ success: false, message: 'Upload canceled' });
      }
    }

    const fileData = await fileService.uploadLessonFile(req.file, {
      userId: studentId,
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

    const maybeUrl = fileData?.url || (fileProviderType === 'local' ? constructUploadPath('assignments', req.file.filename) : null);
    const fileInfo = {
      ...fileData,
      ...(maybeUrl ? { url: maybeUrl } : {})
    };

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'processing',
        percent: 100,
        bytesUploaded: totalBytes,
        totalBytes
      });
    }

    const grade = await recordAssignmentSubmission(studentId, contentId, fileInfo);

    // Refresh instructor pending summary (one more pending submission for this course)
    try {
      const io = req.app.get('io');
      if (io && content && content.course) {
        const Course = require('../models/Course');
        const courseDoc = await Course.findById(content.course).select('instructor');
        if (courseDoc && courseDoc.instructor) {
          await emitInstructorPendingSummaryUpdate(io, courseDoc.instructor.toString());
        }
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after assignment submission:', e.message);
    }

    let assignmentAward = null;
    try {
      const activityType = content.type === 'project' ? 'projectUpload' : 'assignmentUpload';
      assignmentAward = await awardOnceForActivityInternal({
        studentId,
        activityType,
        contentId: contentId,
        contentModel: 'Content',
        contentTitle: content.title,
        courseId: content.course,
        metadata: { reuploadUsed: !!grade?.reuploadUsed }
      });
    } catch (e) {}

    let courseAward = null;
    try {
      const prev = await CourseGrade.findOne({ student: studentId, course: content.course });
      await calculateCourseGrade(studentId, content.course);
      const now = await CourseGrade.findOne({ student: studentId, course: content.course });
      if (!prev?.isComplete && now?.isComplete) {
        courseAward = await awardPointsInternal(studentId, 'course');
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

    // If this submission is a reupload (after approval), notify the instructor
    if (grade && grade.reuploadUsed) {
      try {
        const Course = require('../models/Course');
        const User = require('../models/User');
        const course = await Course.findById(content.course).populate('instructor', 'name email');

        if (course && course.instructor && !course.instructor.isDeleted && course.instructor.status !== 'deleted') {
          const instructorUser = await User.findById(course.instructor._id);
          if (instructorUser) {
            instructorUser.notifications.push({
              message: `Student ${req.user.name || 'A student'} has submitted a reupload for ${content.title} in course ${course.name}.`,
              type: 'info',
              read: false
            });
            await instructorUser.save();
          }

          await sendEmail({
            email: course.instructor.email,
            subject: 'Reupload submitted and pending regrading',
            message: `A student submitted a reupload for ${content.title} in course ${course.name}. Please review and regrade.`,
            html: `<p>A student submitted a reupload for <strong>${content.title}</strong> in course <strong>${course.name}</strong>. Please review and regrade.</p>`
          });
        }
      } catch (notifyError) {
        console.error('Failed to notify instructor about reupload submission:', notifyError);
      }
    }

    if (shouldTrackHostedProgress) {
      const { updateJob } = require('../services/videoUploadJobs');
      updateJob(jobId, {
        status: 'completed',
        percent: 100,
        contentId
      });
    }

    res.json({
      success: true,
      message: 'Assignment submitted successfully. It will be graded by the instructor.',
      data: grade,
      gamification: Object.keys(gamification).length ? gamification : { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null }
    });
  } catch (error) {
    console.error('Submit assignment error:', error);
    if (error?.name === 'AbortError' || error?.code === 'UPLOAD_CANCELED' || error?.code === 'UPLOAD_SESSION_CANCELED') {
      try {
        const jobId = req.body?.uploadSessionId ? String(req.body.uploadSessionId) : null;
        if (jobId) {
          const { updateJob } = require('../services/videoUploadJobs');
          updateJob(jobId, { status: 'canceled', error: null });
        }
      } catch (_) {}

      if (req.file?.path) {
        const fs = require('fs').promises;
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

    const isKnownUserError = error?.code === 'REUPLOAD_NOT_ALLOWED' || error?.code === 'ALREADY_SUBMITTED';
    const status = isKnownUserError ? 400 : 500;
    res.status(status).json({
      success: false,
      message: isKnownUserError
        ? (error.message || 'Upload failed. Please try again.')
        : 'Upload failed. Please try again.'
    });
  }
};

// @desc    Request a one-time reupload for an assignment/project
// @route   POST /api/contents/:contentId/reupload/request
// @access  Private (Student)
exports.requestReupload = async (req, res) => {
  try {
    const { contentId } = req.params;
    const studentId = req.user.id;
    const { reason } = req.body || {};

    const content = await Content.findById(contentId);
    if (!content || (content.type !== 'assignment' && content.type !== 'project')) {
      return res.status(400).json({
        success: false,
        message: 'Reupload is only available for assignments and projects'
      });
    }

    const grade = await StudentContentGrade.findOne({ student: studentId, content: contentId });
    if (!grade || grade.status !== 'graded') {
      return res.status(400).json({
        success: false,
        message: 'You can request a reupload only after the assignment has been graded'
      });
    }

    if (grade.reuploadRequested || grade.reuploadUsed || grade.regradeUsed || grade.reuploadStatus !== 'none') {
      return res.status(400).json({
        success: false,
        message: 'Reupload has already been requested or used for this assignment'
      });
    }

    grade.reuploadRequested = true;
    grade.reuploadStatus = 'pending';
    grade.reuploadReason = typeof reason === 'string' ? reason.slice(0, 500) : undefined;
    grade.reuploadRequestedAt = new Date();
    await grade.save();

    // Notify instructor via in-app notification and email
    try {
      const Course = require('../models/Course');
      const User = require('../models/User');
      const course = await Course.findById(content.course).populate('instructor', 'name email');

      if (course && course.instructor && !course.instructor.isDeleted && course.instructor.status !== 'deleted') {
        const instructorUser = await User.findById(course.instructor._id);
        if (instructorUser) {
          instructorUser.notifications.push({
            message: `Reupload request from ${req.user.name || 'student'} for ${content.title} in course ${course.name}.`,
            type: 'info',
            read: false
          });
          await instructorUser.save();
        }

        await sendEmail({
          email: course.instructor.email,
          subject: 'Reupload request pending approval',
          message: `A student requested a reupload for ${content.title} in course ${course.name}.`,
          html: `<p>A student requested a reupload for <strong>${content.title}</strong> in course <strong>${course.name}</strong>.</p>`
        });
      }
    } catch (notifyError) {
      console.error('Failed to notify instructor about reupload request:', notifyError);
    }

    res.json({
      success: true,
      message: 'Reupload request submitted and pending instructor approval.',
      data: grade
    });
  } catch (error) {
    console.error('Request reupload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to request reupload',
      error: error.message
    });
  }
};

// @desc    Approve a pending reupload request
// @route   POST /api/contents/:contentId/reupload/approve
// @access  Private (Instructor/Admin)
exports.approveReupload = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { studentId } = req.body || {};

    if (!studentId) {
      return res.status(400).json({
        success: false,
        message: 'studentId is required'
      });
    }

    const content = await Content.findById(contentId);
    if (!content || (content.type !== 'assignment' && content.type !== 'project')) {
      return res.status(400).json({
        success: false,
        message: 'Reupload is only available for assignments and projects'
      });
    }

    // Permission check: must be course instructor or admin
    if (req.user.role !== 'admin') {
      const Course = require('../models/Course');
      const course = await Course.findById(content.course);
      if (!course || course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to approve reupload for this content'
        });
      }
    }

    const grade = await StudentContentGrade.findOne({ student: studentId, content: contentId });
    if (!grade || !grade.reuploadRequested || grade.reuploadStatus !== 'pending' || grade.reuploadUsed || grade.regradeUsed) {
      return res.status(400).json({
        success: false,
        message: 'No pending reupload request found for this student and content'
      });
    }

    grade.reuploadStatus = 'approved';
    grade.reuploadApprovedAt = new Date();
    await grade.save();

    // Notify student via in-app notification and email
    try {
      const User = require('../models/User');
      const Course = require('../models/Course');
      const student = await User.findById(studentId).select('email name notifications');
      const course = await Course.findById(content.course).select('name');

      if (student) {
        student.notifications.push({
          message: `Your reupload request for ${content.title} in course ${course?.name || ''} has been approved. You can now submit a new file once.`,
          type: 'success',
          read: false
        });
        await student.save();

        await sendEmail({
          email: student.email,
          subject: 'Reupload request approved',
          message: `Your reupload request for ${content.title} has been approved. You can now submit a new file once.`,
          html: `<p>Your reupload request for <strong>${content.title}</strong> in course <strong>${course?.name || ''}</strong> has been approved.</p><p>You can now submit a new file once for regrading.</p>`
        });
      }
    } catch (notifyError) {
      console.error('Failed to notify student about reupload approval:', notifyError);
    }

    res.json({
      success: true,
      message: 'Reupload request approved successfully',
      data: grade
    });
  } catch (error) {
    console.error('Approve reupload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve reupload',
      error: error.message
    });
  }
};

// @desc    Reject a pending reupload request
// @route   POST /api/contents/:contentId/reupload/reject
// @access  Private (Instructor/Admin)
exports.rejectReupload = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { studentId, reason } = req.body || {};

    if (!studentId) {
      return res.status(400).json({
        success: false,
        message: 'studentId is required'
      });
    }

    const content = await Content.findById(contentId);
    if (!content || (content.type !== 'assignment' && content.type !== 'project')) {
      return res.status(400).json({
        success: false,
        message: 'Reupload is only available for assignments and projects'
      });
    }

    // Permission check: must be course instructor or admin
    if (req.user.role !== 'admin') {
      const Course = require('../models/Course');
      const course = await Course.findById(content.course);
      if (!course || course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to reject reupload for this content'
        });
      }
    }

    const grade = await StudentContentGrade.findOne({ student: studentId, content: contentId });
    if (!grade || !grade.reuploadRequested || grade.reuploadStatus !== 'pending' || grade.reuploadUsed || grade.regradeUsed) {
      return res.status(400).json({
        success: false,
        message: 'No pending reupload request found for this student and content'
      });
    }

    grade.reuploadStatus = 'rejected';
    grade.reuploadRejectedAt = new Date();
    await grade.save();

    // Notify student via in-app notification and email
    try {
      const User = require('../models/User');
      const Course = require('../models/Course');
      const student = await User.findById(studentId).select('email name notifications');
      const course = await Course.findById(content.course).select('name');

      const messageText = reason
        ? `Your reupload request for ${content.title} in course ${course?.name || ''} has been rejected. Reason: ${reason}`
        : `Your reupload request for ${content.title} in course ${course?.name || ''} has been rejected.`;

      if (student) {
        student.notifications.push({
          message: messageText,
          type: 'error',
          read: false
        });
        await student.save();

        await sendEmail({
          email: student.email,
          subject: 'Reupload request rejected',
          message: messageText,
          html: `<p>${messageText}</p>`
        });
      }
    } catch (notifyError) {
      console.error('Failed to notify student about reupload rejection:', notifyError);
    }

    res.json({
      success: true,
      message: 'Reupload request rejected successfully',
      data: grade
    });
  } catch (error) {
    console.error('Reject reupload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject reupload',
      error: error.message
    });
  }
};

// @desc    Get pending reupload requests for instructor/admin
// @route   GET /api/grading/reuploads/pending
// @access  Private (Instructor/Admin)
exports.getPendingReuploadRequests = async (req, res) => {
  try {
    let courseQuery = {};

    if (req.user.role === 'instructor') {
      courseQuery.instructor = req.user.id;
    }

    const Course = require('../models/Course');
    const courses = await Course.find(courseQuery).select('_id');
    const courseIds = courses.map((c) => c._id);

    const pending = await StudentContentGrade.find({
      course: { $in: courseIds },
      reuploadRequested: true,
      reuploadStatus: 'pending'
    })
      .populate('student', 'name email')
      .populate('content', 'title type')
      .populate('course', 'name')
      .sort({ reuploadRequestedAt: -1 });

    res.json({
      success: true,
      count: pending.length,
      data: pending
    });
  } catch (error) {
    console.error('Get pending reupload requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending reupload requests',
      error: error.message
    });
  }
};

// @desc    Grade an assignment (instructor/admin)
// @route   POST /api/contents/:contentId/grade
// @access  Private (Instructor/Admin)
exports.gradeContent = async (req, res) => {
  try {
    const { contentId } = req.params;
    const { studentId, gradePercent, feedback } = req.body;
    const gradedBy = req.user.id;

    if (!studentId || gradePercent === undefined) {
      return res.status(400).json({
        success: false,
        message: 'studentId and gradePercent are required'
      });
    }

    if (gradePercent < 0 || gradePercent > 100) {
      return res.status(400).json({
        success: false,
        message: 'gradePercent must be between 0 and 100'
      });
    }

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    if (content.type !== 'assignment' && content.type !== 'project') {
      return res.status(400).json({
        success: false,
        message: 'Only assignments and projects can be graded'
      });
    }

    // Check permissions: must be instructor of the course or admin
    const Course = require('../models/Course');
    const course = await Course.findById(content.course);
    if (req.user.role !== 'admin') {
      if (!course || course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to grade this content'
        });
      }
    }

    // Enforce at most one regrade per reupload
    const existingGrade = await StudentContentGrade.findOne({ student: studentId, content: contentId });

    if (existingGrade && existingGrade.regradeUsed) {
      return res.status(400).json({
        success: false,
        message: 'Regrade already performed for this assignment or project'
      });
    }

    const grade = await gradeAssignment(studentId, contentId, gradePercent, feedback, gradedBy);

    // If this is a regrade (after approved reupload), mark regrade flags.
    // The original grade snapshot is already preserved when the reupload was submitted.
    if (existingGrade && existingGrade.reuploadUsed && !existingGrade.regradeUsed) {
      grade.regradeUsed = true;
      grade.regradeAt = new Date();
      grade.reuploadStatus = 'completed';
      await grade.save();
    }

    // After grading, refresh instructor pending summary (one fewer pending assignment)
    try {
      const io = req.app.get('io');
      if (io && course && course.instructor) {
        await emitInstructorPendingSummaryUpdate(io, course.instructor.toString());
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after grading:', e.message);
    }

    // Send email notification to the student
    try {
      const { sendAssignmentGradedEmail } = require('../utils/emailNotifications');
      const User = require('../models/User');
      const Course = require('../models/Course');
      
      const student = await User.findById(studentId).select('email name');
      const course = await Course.findById(content.course).select('name');
      
      if (student && course) {
        sendAssignmentGradedEmail(
          student.email,
          student.name,
          content.title,
          gradePercent,
          course.name
        ).catch(err => console.error('Error sending grade notification email:', err));
      }
    } catch (emailError) {
      console.error('Error sending grading email:', emailError);
    }

    res.json({
      success: true,
      message: 'Assignment graded successfully',
      data: grade
    });
  } catch (error) {
    console.error('Grade assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to grade assignment',
      error: error.message
    });
  }
};

// @desc    Get section grade for a student
// @route   GET /api/students/:studentId/sections/:sectionId/grade
// @access  Private (Student can see own, Instructor/Admin can see all)
exports.getSectionGrade = async (req, res) => {
  try {
    const { studentId, sectionId } = req.params;

    // Permission check: students can only see their own grades
    if (req.user.role === 'student' && req.user.id !== studentId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this grade'
      });
    }

    const result = await calculateSectionGrade(studentId, sectionId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get section grade error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate section grade',
      error: error.message
    });
  }
};

// @desc    Get course grade for a student
// @route   GET /api/students/:studentId/courses/:courseId/grade
// @access  Private (Student can see own, Instructor/Admin can see all)
exports.getCourseGrade = async (req, res) => {
  try {
    const { studentId, courseId } = req.params;

    // Permission check: students can only see their own grades
    if (req.user.role === 'student' && req.user.id !== studentId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this grade'
      });
    }

    const result = await calculateCourseGrade(studentId, courseId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get course grade error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate course grade',
      error: error.message
    });
  }
};

// @desc    Get student submissions for grading (instructor/admin)
// @route   GET /api/contents/:contentId/submissions
// @access  Private (Instructor/Admin)
exports.getContentSubmissions = async (req, res) => {
  try {
    const { contentId } = req.params;

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    // Check permissions
    if (req.user.role !== 'admin') {
      const Course = require('../models/Course');
      const course = await Course.findById(content.course);
      if (!course || course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view submissions'
        });
      }
    }

    const submissions = await StudentContentGrade.find({
      content: contentId,
      status: { $in: ['submitted_ungraded', 'graded'] }
    })
      .populate('student', 'name email')
      .populate('gradedBy', 'name email')
      .sort({ updatedAt: -1 });

    res.json({
      success: true,
      count: submissions.length,
      data: submissions
    });
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch submissions',
      error: error.message
    });
  }
};

// @desc    Download student submission file
// @route   GET /api/grading/submissions/:gradeId/download
// @access  Private (Instructor/Admin)
exports.downloadSubmission = async (req, res) => {
  try {
    const { gradeId } = req.params;
    
    console.log('[DownloadSubmission] Request received for gradeId:', gradeId);
    console.log('[DownloadSubmission] User:', req.user.id, 'Role:', req.user.role);

    const grade = await StudentContentGrade.findById(gradeId)
      .populate('content');
    
    console.log('[DownloadSubmission] Grade found:', grade ? 'YES' : 'NO');
    if (grade) {
      console.log('[DownloadSubmission] Submission file:', grade.submissionFile);
    }
    
    if (!grade) {
      console.error('[DownloadSubmission] Grade not found for ID:', gradeId);
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check permissions
    if (req.user.role !== 'admin') {
      const Course = require('../models/Course');
      const course = await Course.findById(grade.course);
      if (!course || course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to download this submission'
        });
      }
    }

    const fileMeta =
      grade.reuploadUsed && grade.reuploadSubmissionFile
        ? grade.reuploadSubmissionFile
        : grade.submissionFile;

    if (!fileMeta) {
      console.error('[DownloadSubmission] No submission file or path in grade');
      return res.status(404).json({
        success: false,
        message: 'No submission file found'
      });
    }

    if (fileMeta.storageType === 'telegram' && fileMeta.telegramFileId) {
      const filename = fileMeta.originalName || 'submission.rar';
      return streamTelegramFile(fileMeta.telegramFileId, res, {
        asAttachment: true,
        filename
      });
    }

    if (!fileMeta.path && !fileMeta.url) {
      console.error('[DownloadSubmission] No submission file or path in grade');
      return res.status(404).json({
        success: false,
        message: 'No submission file found'
      });
    }

    // Handle both absolute and relative paths, or URL-based paths
    let filePath;
    const fileSource = fileMeta.path || fileMeta.url;
    
    // Check for URL path first (starts with /uploads)
    if (fileSource.startsWith('/uploads/')) {
      filePath = path.resolve(__dirname, '..', fileSource.substring(1)); // Remove leading /
      console.log('[DownloadSubmission] Converted URL path to:', filePath);
    } else if (path.isAbsolute(fileSource)) {
      filePath = fileSource;
      console.log('[DownloadSubmission] Using absolute path:', filePath);
    } else {
      filePath = path.resolve(__dirname, '..', fileSource);
      console.log('[DownloadSubmission] Resolved relative path to:', filePath);
    }
    console.log('[DownloadSubmission] __dirname:', __dirname);
    
    const fs = require('fs').promises;
    
    try {
      await fs.access(filePath);
      console.log('[DownloadSubmission] File exists at:', filePath);
    } catch (err) {
      console.error('[DownloadSubmission] File NOT found at:', filePath);
      console.error('[DownloadSubmission] Error:', err.message);
      return res.status(404).json({
        success: false,
        message: 'Submission file not found on server',
        path: filePath
      });
    }

    // Get file stats for Content-Length header
    const fileStats = await fs.stat(filePath);
    console.log('[DownloadSubmission] File size:', fileStats.size, 'bytes');

    console.log('[DownloadSubmission] Sending file:', fileMeta.originalName);
    
    // Use Express's built-in download method (more reliable than streaming)
    res.download(filePath, fileMeta.originalName, (err) => {
      if (err) {
        console.error('[DownloadSubmission] Download error:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error downloading file'
          });
        }
      } else {
        console.log('[DownloadSubmission] File sent successfully');
      }
    });
  } catch (error) {
    console.error('Download submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to download submission',
      error: error.message
    });
  }
};

module.exports = exports;
