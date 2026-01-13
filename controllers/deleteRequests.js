const DeleteRequest = require('../models/DeleteRequest');
const Course = require('../models/Course');
const Group = require('../models/Group');
const Section = require('../models/Section');
const Content = require('../models/Content');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Message = require('../models/Message');
const YouTubeVideo = require('../models/YouTubeVideo');

// Reuse existing controllers so we keep all safety checks and cascade logic
const coursesController = require('./courses');
const groupManagementController = require('./groupManagement');
const sectionManagementController = require('./sectionManagement');
const contentManagementController = require('./contentManagement');

// @desc    Instructor requests course delete
// @route   POST /api/courses/:id/request-delete
// @access  Private (Instructor/Admin)
exports.requestCourseDelete = async (req, res) => {
  try {
    const courseId = req.params.id;
    const userId = req.user._id || req.user.id;

    const course = await Course.findById(courseId).select('instructor name');
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Only course instructor or admin can request delete
    if (req.user.role !== 'admin' && course.instructor.toString() !== String(userId)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to request deletion for this course'
      });
    }

    const reason = (req.body?.reason || '').trim();
    if (reason.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a detailed reason for deletion (at least 20 characters).'
      });
    }

    const existing = await DeleteRequest.findOne({
      targetType: 'course',
      course: courseId,
      status: 'pending'
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'There is already a pending delete request for this course'
      });
    }

    const request = await DeleteRequest.create({
      targetType: 'course',
      course: courseId,
      requestedBy: userId,
      reason
    });

    // Notify admins that pending delete request counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after course delete request:', e.message);
    }

    // Notify admins about the new delete request (notifications + inbox messages)
    try {
      const adminUsers = await User.find({ role: 'admin' }).select('name email');
      const requesterName = req.user.name || 'Instructor';
      const targetName = course.name || courseId;
      const baseMessage = `${requesterName} requested deletion of course "${targetName}".`;

      for (const admin of adminUsers) {
        await Notification.create({
          user: admin._id,
          type: 'delete_request',
          title: 'New delete request (course)',
          message: baseMessage,
          link: '/admin/delete-requests?status=pending',
          priority: 'high',
          metadata: {
            requestId: request._id,
            targetType: 'course',
            courseId
          }
        });

        await Message.create({
          sender: req.user.id || req.user._id,
          recipient: admin._id,
          subject: 'New delete request for course',
          content: `${baseMessage}\n\nReason provided by instructor:\n${reason}`,
          conversationType: 'direct',
          course: courseId
        });
      }
    } catch (notifyError) {
      console.error('Failed to create admin notifications/messages for course delete request:', notifyError);
    }

    return res.status(201).json({
      success: true,
      data: request,
      message: 'Delete request submitted to admin. They must approve before the course can be deleted.'
    });
  } catch (error) {
    console.error('Request course delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit delete request',
      error: error.message
    });
  }
};

// @desc    Instructor requests section delete
// @route   POST /api/sections/:id/request-delete
// @access  Private (Instructor/Admin)
exports.requestSectionDelete = async (req, res) => {
  try {
    const sectionId = req.params.id;
    const userId = req.user._id || req.user.id;

    const section = await Section.findById(sectionId)
      .populate('course', 'instructor name')
      .populate('group', 'instructor name');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    const courseInstructorId = section.course?.instructor?.toString();
    const groupInstructorId = section.group?.instructor?.toString();

    if (
      req.user.role !== 'admin' &&
      (!courseInstructorId || courseInstructorId !== String(userId)) &&
      (!groupInstructorId || groupInstructorId !== String(userId))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to request deletion for this section'
      });
    }

    const reason = (req.body?.reason || '').trim();
    if (reason.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a detailed reason for deletion (at least 20 characters).'
      });
    }

    const existing = await DeleteRequest.findOne({
      targetType: 'section',
      section: sectionId,
      status: 'pending'
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'There is already a pending delete request for this section'
      });
    }

    const request = await DeleteRequest.create({
      targetType: 'section',
      section: sectionId,
      requestedBy: userId,
      reason
    });

    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after section delete request:', e.message);
    }

    // Notify admins about the new delete request (section)
    try {
      const adminUsers = await User.find({ role: 'admin' }).select('name email');
      const requesterName = req.user.name || 'Instructor';
      const sectionName = section.name || sectionId;
      const courseName = section.course && section.course.name ? section.course.name : null;
      const baseMessage = courseName
        ? `${requesterName} requested deletion of section "${sectionName}" in course "${courseName}".`
        : `${requesterName} requested deletion of section "${sectionName}".`;

      const courseId = section.course && (section.course._id || section.course);

      for (const admin of adminUsers) {
        await Notification.create({
          user: admin._id,
          type: 'delete_request',
          title: 'New delete request (section)',
          message: baseMessage,
          link: '/admin/delete-requests?status=pending',
          priority: 'high',
          metadata: {
            requestId: request._id,
            targetType: 'section',
            sectionId,
            courseId
          }
        });

        await Message.create({
          sender: req.user.id || req.user._id,
          recipient: admin._id,
          subject: 'New delete request for section',
          content: `${baseMessage}\n\nReason provided by instructor:\n${reason}`,
          conversationType: 'direct',
          course: courseId
        });
      }
    } catch (notifyError) {
      console.error('Failed to create admin notifications/messages for section delete request:', notifyError);
    }

    return res.status(201).json({
      success: true,
      data: request,
      message: 'Delete request submitted to admin. They must approve before the section can be deleted.'
    });
  } catch (error) {
    console.error('Request section delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit delete request',
      error: error.message
    });
  }
};

// @desc    Instructor requests content delete
// @route   POST /api/content/:id/request-delete
// @access  Private (Instructor/Admin)
exports.requestContentDelete = async (req, res) => {
  try {
    const contentId = req.params.id;
    const userId = req.user._id || req.user.id;

    const content = await Content.findById(contentId)
      .populate('course', 'instructor name')
      .populate('group', 'instructor');
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }

    const courseInstructorId = content.course?.instructor?.toString();
    const groupInstructorId = content.group?.instructor?.toString();
    const createdById = content.createdBy ? content.createdBy.toString() : null;

    if (
      req.user.role !== 'admin' &&
      (!courseInstructorId || courseInstructorId !== String(userId)) &&
      (!groupInstructorId || groupInstructorId !== String(userId)) &&
      (!createdById || createdById !== String(userId))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to request deletion for this content'
      });
    }

    const reason = (req.body?.reason || '').trim();
    if (reason.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a detailed reason for deletion (at least 20 characters).'
      });
    }

    const existing = await DeleteRequest.findOne({
      targetType: 'content',
      content: contentId,
      status: 'pending'
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'There is already a pending delete request for this content item'
      });
    }

    const request = await DeleteRequest.create({
      targetType: 'content',
      content: contentId,
      requestedBy: userId,
      reason
    });

    await Content.findByIdAndUpdate(
      contentId,
      { deletionStatus: 'pending_deletion' },
      { new: true }
    );

    if (content?.video?.youtubeVideoId) {
      await YouTubeVideo.findOneAndUpdate(
        { youtubeVideoId: content.video.youtubeVideoId },
        { status: 'pending_deletion', statusChangedAt: new Date() },
        { new: true }
      );
    }

    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after content delete request:', e.message);
    }

    // Notify admins about the new delete request (content)
    try {
      const adminUsers = await User.find({ role: 'admin' }).select('name email');
      const requesterName = req.user.name || 'Instructor';
      const title = content.title || 'Content item';
      const typeLabel = content.type ? ` (${content.type})` : '';
      const displayName = `${title}${typeLabel}`;
      const courseName = content.course && content.course.name ? content.course.name : null;
      const baseMessage = courseName
        ? `${requesterName} requested deletion of ${displayName} in course "${courseName}".`
        : `${requesterName} requested deletion of ${displayName}.`;

      const courseId = content.course && (content.course._id || content.course);

      for (const admin of adminUsers) {
        await Notification.create({
          user: admin._id,
          type: 'delete_request',
          title: 'New delete request (content)',
          message: baseMessage,
          link: '/admin/delete-requests?status=pending',
          priority: 'high',
          metadata: {
            requestId: request._id,
            targetType: 'content',
            contentId,
            courseId
          }
        });

        await Message.create({
          sender: req.user.id || req.user._id,
          recipient: admin._id,
          subject: 'New delete request for content',
          content: `${baseMessage}\n\nReason provided by instructor:\n${reason}`,
          conversationType: 'direct',
          course: courseId
        });
      }
    } catch (notifyError) {
      console.error('Failed to create admin notifications/messages for content delete request:', notifyError);
    }

    return res.status(201).json({
      success: true,
      data: request,
      message: 'Delete request submitted to admin. They must approve before the content can be deleted.'
    });
  } catch (error) {
    console.error('Request content delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit delete request',
      error: error.message
    });
  }
};

// @desc    Instructor requests group delete
// @route   POST /api/groups/:groupId/request-delete
// @access  Private (Instructor/Admin)
exports.requestGroupDelete = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user._id || req.user.id;

    const group = await Group.findById(groupId).populate('course', 'instructor name');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const courseInstructorId = group.course?.instructor?.toString();

    // Only group instructor, course instructor, or admin can request delete
    if (
      req.user.role !== 'admin' &&
      group.instructor.toString() !== String(userId) &&
      (!courseInstructorId || courseInstructorId !== String(userId))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to request deletion for this group'
      });
    }

    const reason = (req.body?.reason || '').trim();
    if (reason.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a detailed reason for deletion (at least 20 characters).'
      });
    }

    const existing = await DeleteRequest.findOne({
      targetType: 'group',
      group: groupId,
      status: 'pending'
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'There is already a pending delete request for this group'
      });
    }

    const request = await DeleteRequest.create({
      targetType: 'group',
      group: groupId,
      requestedBy: userId,
      reason
    });

    // Notify admins that pending delete request counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after group delete request:', e.message);
    }

    // Notify admins about the new delete request (group)
    try {
      const adminUsers = await User.find({ role: 'admin' }).select('name email');
      const requesterName = req.user.name || 'Instructor';
      const groupName = group.name || groupId;
      const courseName = group.course && group.course.name ? group.course.name : null;
      const baseMessage = courseName
        ? `${requesterName} requested deletion of group "${groupName}" in course "${courseName}".`
        : `${requesterName} requested deletion of group "${groupName}".`;

      const courseId = group.course && (group.course._id || group.course);

      for (const admin of adminUsers) {
        await Notification.create({
          user: admin._id,
          type: 'delete_request',
          title: 'New delete request (group)',
          message: baseMessage,
          link: '/admin/delete-requests?status=pending',
          priority: 'high',
          metadata: {
            requestId: request._id,
            targetType: 'group',
            groupId,
            courseId
          }
        });

        await Message.create({
          sender: req.user.id || req.user._id,
          recipient: admin._id,
          subject: 'New delete request for group',
          content: `${baseMessage}\n\nReason provided by instructor:\n${reason}`,
          conversationType: 'direct',
          course: courseId
        });
      }
    } catch (notifyError) {
      console.error('Failed to create admin notifications/messages for group delete request:', notifyError);
    }

    return res.status(201).json({
      success: true,
      data: request,
      message: 'Delete request submitted to admin. They must approve before the group can be deleted.'
    });
  } catch (error) {
    console.error('Request group delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit delete request',
      error: error.message
    });
  }
};

// @desc    Get all delete requests (optionally filtered by status)
// @route   GET /api/delete-requests
// @access  Private (Admin)
exports.getDeleteRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) {
      filter.status = status;
    }

    const requests = await DeleteRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate('requestedBy', 'name email role')
      .populate('course', 'name')
      .populate({
        path: 'group',
        select: 'name course',
        populate: {
          path: 'course',
          select: 'name'
        }
      })
      .populate({
        path: 'section',
        select: 'name group course',
        populate: [
          { path: 'group', select: 'name' },
          { path: 'course', select: 'name' }
        ]
      })
      .populate({
        path: 'content',
        select: 'title type section group course',
        populate: [
          { path: 'section', select: 'name' },
          { path: 'group', select: 'name' },
          { path: 'course', select: 'name' }
        ]
      })
      .lean();

    const enhancedRequests = await Promise.all(
      requests.map(async (reqDoc) => {
        let enrollmentCount = null;

        try {
          if (reqDoc.targetType === 'course' && reqDoc.course) {
            const courseId = reqDoc.course._id || reqDoc.course;
            enrollmentCount = await Enrollment.countDocuments({
              course: courseId,
              status: { $ne: 'rejected' }
            });
          } else if (reqDoc.targetType === 'group' && reqDoc.group) {
            const groupId = reqDoc.group._id || reqDoc.group;
            enrollmentCount = await Enrollment.countDocuments({
              group: groupId,
              status: { $ne: 'rejected' }
            });
          }
        } catch (err) {
          console.error('Failed to compute enrollment count for delete request', {
            requestId: reqDoc._id,
            targetType: reqDoc.targetType,
            error: err.message
          });
        }

        return {
          ...reqDoc,
          analytics: {
            enrollmentCount,
            hasEnrollments: typeof enrollmentCount === 'number' && enrollmentCount > 0
          }
        };
      })
    );

    res.json({
      success: true,
      count: enhancedRequests.length,
      data: enhancedRequests
    });
  } catch (error) {
    console.error('Get delete requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch delete requests',
      error: error.message
    });
  }
};

// @desc    Approve or reject a delete request
// @route   PATCH /api/delete-requests/:id
// @access  Private (Admin)
exports.updateDeleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, adminNote } = req.body || {};

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Action must be "approve" or "reject"'
      });
    }

    if (action === 'reject') {
      const trimmedNote = (adminNote || '').trim();
      if (trimmedNote.length < 20) {
        return res.status(400).json({
          success: false,
          message: 'Admin rejection note must be at least 20 characters.'
        });
      }
    }

    const request = await DeleteRequest.findById(id)
      .populate('requestedBy', 'name email role')
      .populate('course', 'name')
      .populate({
        path: 'group',
        select: 'name course',
        populate: {
          path: 'course',
          select: 'name'
        }
      })
      .populate({
        path: 'section',
        select: 'name group course',
        populate: [
          { path: 'group', select: 'name' },
          { path: 'course', select: 'name' }
        ]
      })
      .populate({
        path: 'content',
        select: 'title type section group course',
        populate: [
          { path: 'section', select: 'name' },
          { path: 'group', select: 'name' },
          { path: 'course', select: 'name' }
        ]
      });

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Delete request not found'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'This request has already been resolved'
      });
    }

    if (action === 'reject' && request.targetType === 'content' && request.content) {
      try {
        const contentId = request.content._id || request.content;
        const content = await Content.findById(contentId).select('video.youtubeVideoId');

        await Content.findByIdAndUpdate(
          contentId,
          { deletionStatus: 'active' },
          { new: true }
        );

        if (content?.video?.youtubeVideoId) {
          await YouTubeVideo.findOneAndUpdate(
            { youtubeVideoId: content.video.youtubeVideoId, status: 'pending_deletion' },
            { status: 'active', statusChangedAt: new Date() },
            { new: true }
          );
        }
      } catch (e) {
        console.error('Failed to clear pending_deletion on rejected delete request:', e);
      }
    }

    // Helper to call the appropriate delete controller while capturing its response
    const performDeletionIfApproved = async () => {
      if (action !== 'approve') {
        return { statusCode: 200, body: null };
      }

      const makeMockRes = () => {
        return {
          statusCode: 200,
          body: null,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(payload) {
            this.body = payload;
            return this;
          }
        };
      };

      // Base request properties to preserve auth and app context
      const baseReq = {
        user: req.user,
        app: req.app,
        headers: req.headers,
        query: {},
        body: {}
      };

      try {
        if (request.targetType === 'course' && request.course) {
          const courseId = request.course._id || request.course;
          const mockReq = { ...baseReq, params: { id: courseId.toString() } };
          const mockRes = makeMockRes();
          await coursesController.deleteCourse(mockReq, mockRes);
          return mockRes;
        }

        if (request.targetType === 'group' && request.group) {
          const groupId = request.group._id || request.group;
          const mockReq = { ...baseReq, params: { groupId: groupId.toString() } };
          const mockRes = makeMockRes();
          await groupManagementController.deleteGroup(mockReq, mockRes);
          return mockRes;
        }

        if (request.targetType === 'section' && request.section) {
          const sectionId = request.section._id || request.section;
          const mockReq = { ...baseReq, params: { sectionId: sectionId.toString() } };
          const mockRes = makeMockRes();
          await sectionManagementController.deleteSection(mockReq, mockRes);
          return mockRes;
        }

        if (request.targetType === 'content' && request.content) {
          const contentId = request.content._id || request.content;
          const mockReq = { ...baseReq, params: { contentId: contentId.toString() } };
          const mockRes = makeMockRes();
          await contentManagementController.deleteContent(mockReq, mockRes);
          return mockRes;
        }

        // Unknown type or missing target; treat as no-op but log for visibility
        console.warn('DeleteRequest approval: unknown or missing target for request', {
          id: request._id,
          targetType: request.targetType
        });
        return { statusCode: 200, body: null };
      } catch (err) {
        console.error('Error while deleting target for delete request:', err);
        return {
          statusCode: 500,
          body: { message: 'Failed to delete requested item', error: err.message }
        };
      }
    };

    const deletionResult = await performDeletionIfApproved();

    // If deletion failed with a client/server error (except 404 not found),
    // surface that error to the admin and keep the request in pending state.
    if (
      action === 'approve' &&
      deletionResult &&
      typeof deletionResult.statusCode === 'number' &&
      deletionResult.statusCode >= 400 &&
      deletionResult.statusCode !== 404
    ) {
      return res.status(deletionResult.statusCode).json({
        success: false,
        message:
          (deletionResult.body && deletionResult.body.message) ||
          'Failed to delete the requested item. Please review constraints and try again.'
      });
    }

    request.status = action === 'approve' ? 'approved' : 'rejected';
    if (adminNote) {
      const trimmedNote = adminNote.trim();
      request.adminNote = trimmedNote;
      if (action === 'reject') {
        request.rejectionReason = trimmedNote;
      }
    }
    request.resolvedAt = new Date();
    request.resolvedBy = req.user._id || req.user.id;

    await request.save();

    // Notify the requesting instructor about the resolution
    try {
      if (request.requestedBy) {
        const actionLabel = action === 'approve' ? 'approved' : 'rejected';
        const adminName = req.user.name || 'Admin';

        let targetLabel = 'item';
        let link = '/instructor/courses';
        const targetType = request.targetType;

        if (targetType === 'course' && request.course) {
          const courseId = request.course._id || request.course;
          targetLabel = `course "${request.course.name}"`;
          link = `/instructor/courses/${courseId}/edit`;
        } else if (targetType === 'group' && request.group) {
          const courseName = request.group.course && request.group.course.name
            ? request.group.course.name
            : '';
          targetLabel = courseName
            ? `group "${request.group.name}" in course "${courseName}"`
            : `group "${request.group.name}"`;
        } else if (targetType === 'section' && request.section) {
          const courseName = request.section.course && request.section.course.name
            ? request.section.course.name
            : '';
          targetLabel = courseName
            ? `section "${request.section.name}" in course "${courseName}"`
            : `section "${request.section.name}"`;
        } else if (targetType === 'content' && request.content) {
          const title = request.content.title || 'content item';
          const typeLabel = request.content.type ? ` (${request.content.type})` : '';
          const courseName = request.content.course && request.content.course.name
            ? request.content.course.name
            : '';
          targetLabel = courseName
            ? `${title}${typeLabel} in course "${courseName}"`
            : `${title}${typeLabel}`;
        }

        const baseMessage = `Your delete request for ${targetLabel} has been ${actionLabel} by ${adminName}.`;
        const trimmedNote = (adminNote || '').trim();
        const fullMessage =
          action === 'reject' && trimmedNote
            ? `${baseMessage}\n\nReason from admin:\n${trimmedNote}`
            : baseMessage;

        const requesterId = request.requestedBy._id || request.requestedBy;

        await Notification.create({
          user: requesterId,
          type: action === 'approve' ? 'delete_request_approved' : 'delete_request_rejected',
          title: action === 'approve' ? 'Delete request approved' : 'Delete request rejected',
          message: fullMessage,
          link,
          priority: 'high',
          metadata: {
            requestId: request._id,
            targetType,
            courseId: request.course && (request.course._id || request.course),
            groupId: request.group && (request.group._id || request.group),
            sectionId: request.section && (request.section._id || request.section),
            contentId: request.content && (request.content._id || request.content)
          }
        });

        await Message.create({
          sender: req.user.id || req.user._id,
          recipient: requesterId,
          conversationType: 'direct',
          subject: action === 'approve' ? 'Delete request approved' : 'Delete request rejected',
          content: fullMessage,
          course: request.course && (request.course._id || request.course),
          group: request.group && (request.group._id || request.group)
        });
      }
    } catch (notifyError) {
      console.error('Failed to notify requester about delete request resolution:', notifyError);
    }

    // Notify admins that pending delete request counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after delete request update:', e.message);
    }

    return res.json({
      success: true,
      data: request,
      message:
        action === 'approve'
          ? 'Delete request approved and target item deleted (where permitted by safety rules).'
          : 'Delete request rejected.'
    });
  } catch (error) {
    console.error('Update delete request error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update delete request',
      error: error.message
    });
  }
};
