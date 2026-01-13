const { validationResult } = require('express-validator');
const Message = require('../models/Message');
const User = require('../models/User');
const { sendMessageNotificationEmail } = require('../utils/emailNotifications');

// @desc    Get user messages
// @route   GET /api/messages
// @access  Private
exports.getMessages = async (req, res) => {
  try {
    const { type, page = 1, limit = 10 } = req.query;
    
    let query = {};
    if (type === 'sent') {
      query.sender = req.user.id;
    } else if (type === 'received') {
      query.recipient = req.user.id;
    } else {
      // Return both sent and received messages by default
      query.$or = [
        { sender: req.user.id },
        { recipient: req.user.id }
      ];
    }

    const messages = await Message.find(query)
      .populate('sender', 'name email avatar role')
      .populate('recipient', 'name email avatar role')
      .populate('course', 'name')
      .populate('group', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Message.countDocuments(query);

    res.json({
      success: true,
      count: messages.length,
      total,
      messages
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single message
// @route   GET /api/messages/:id
// @access  Private
exports.getMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id)
      .populate('sender', 'name email avatar role')
      .populate('recipient', 'name email avatar role')
      .populate('course', 'name')
      .populate('group', 'name');

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is sender or recipient
    if (message.sender._id.toString() !== req.user.id && message.recipient._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this message'
      });
    }

    // Mark as read if user is recipient
    if (message.recipient._id.toString() === req.user.id && !message.isRead) {
      message.isRead = true;
      message.readAt = new Date();
      await message.save();
    }

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Get message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Send message
// @route   POST /api/messages
// @access  Private
exports.sendMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Message validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array()
      });
    }

    const { recipient, subject, content, course, group, priority = 'normal' } = req.body;

    // Validate recipient format
    if (!recipient) {
      return res.status(400).json({
        success: false,
        message: 'Recipient ID is required'
      });
    }

    // Check if recipient exists
    const recipientUser = await User.findById(recipient);
    if (!recipientUser) {
      return res.status(404).json({
        success: false,
        message: 'Recipient not found'
      });
    }

    // Disallow sending messages to deleted accounts
    if (recipientUser.isDeleted || recipientUser.status === 'deleted') {
      return res.status(400).json({
        success: false,
        message: 'Cannot send messages to a deleted account.'
      });
    }

    const message = await Message.create({
      sender: req.user.id,
      recipient,
      subject,
      content,
      course,
      group,
      priority
    });

    // Add notification to recipient
    recipientUser.notifications.push({
      message: `New message: ${subject}`,
      type: 'info',
      read: false
    });
    await recipientUser.save();

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'name email avatar role')
      .populate('recipient', 'name email avatar role');

    // Send email notification to recipient with full content (non-blocking)
    sendMessageNotificationEmail(
      recipientUser.email,
      recipientUser.name,
      populatedMessage.sender.name,
      populatedMessage.sender.role,
      subject,
      content
    ).catch(emailError => {
      console.error('Failed to send email notification:', emailError);
    });

    res.status(201).json({
      success: true,
      message: populatedMessage
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Send bulk message
// @route   POST /api/messages/bulk
// @access  Private (Instructor/Admin only)
exports.sendBulkMessage = async (req, res) => {
  try {
    const { recipientType, courseId, subject, content, priority = 'normal' } = req.body;
    const senderId = req.user.id;
    const senderRole = req.user.role;

    // Validate inputs
    if (!recipientType || !subject || !content) {
      return res.status(400).json({
        success: false,
        message: 'Recipient type, subject, and content are required'
      });
    }

    let recipients = [];

    // Instructor: Send to enrolled students in their courses
    if (senderRole === 'instructor' && recipientType === 'enrolled_students') {
      if (!courseId) {
        return res.status(400).json({
          success: false,
          message: 'Course ID is required for instructor bulk messages'
        });
      }

      const Enrollment = require('../models/Enrollment');
      const enrollments = await Enrollment.find({ 
        course: courseId, 
        status: { $in: ['enrolled', 'approved', 'completed'] }
      }).populate('student');
      
      recipients = enrollments
        .filter(e => e.student) // Filter out null students
        .map(e => e.student._id);
    }
    // Admin: Send to all instructors
    else if (senderRole === 'admin' && recipientType === 'all_instructors') {
      const instructors = await User.find({ 
        role: 'instructor',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      });
      recipients = instructors.map(i => i._id);
    }
    // Admin: Send to all students
    else if (senderRole === 'admin' && recipientType === 'all_students') {
      const students = await User.find({ 
        role: 'student',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      });
      recipients = students.map(s => s._id);
    }
    else {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized bulk message type for your role'
      });
    }

    if (recipients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No recipients found'
      });
    }

    // Create message for each recipient
    const messages = [];
    const sender = await User.findById(senderId).select('name role');
    
    for (const recipientId of recipients) {
      const message = await Message.create({
        sender: senderId,
        recipient: recipientId,
        subject,
        content,
        course: courseId || null,
        priority
      });

      // Add notification
      await User.findByIdAndUpdate(recipientId, {
        $push: {
          notifications: {
            message: `New message: ${subject}`,
            type: 'info',
            read: false
          }
        }
      });

      messages.push(message);
      
      // Send email notification in background with full content
      try {
        const { sendMessageNotificationEmail } = require('../utils/emailNotifications');
        const recipient = await User.findById(recipientId).select('email name');
        if (recipient) {
          sendMessageNotificationEmail(
            recipient.email,
            recipient.name,
            sender.name,
            sender.role,
            subject,
            content
          ).catch(err => console.error('Error sending bulk message email:', err));
        }
      } catch (emailError) {
        console.error('Error sending email for bulk message:', emailError);
      }
    }

    res.status(201).json({
      success: true,
      message: `Message sent to ${recipients.length} recipient(s)`,
      count: recipients.length
    });
  } catch (error) {
    console.error('Send bulk message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Mark message as read
// @route   PUT /api/messages/:id/read
// @access  Private
exports.markAsRead = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is recipient
    if (message.recipient.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to mark this message as read'
      });
    }

    message.isRead = true;
    message.readAt = new Date();
    await message.save();

    res.json({
      success: true,
      message: 'Message marked as read'
    });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete message
// @route   DELETE /api/messages/:id
// @access  Private
exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is sender or recipient
    if (message.sender.toString() !== req.user.id && message.recipient.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this message'
      });
    }

    await message.deleteOne();

    res.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get unread message count
// @route   GET /api/messages/unread-count
// @access  Private
exports.getUnreadCount = async (req, res) => {
  try {
    // Count unread messages
    const unreadMessagesCount = await Message.countDocuments({
      recipient: req.user.id,
      isRead: false
    });
    
    // Count unread notifications; handle case where user record is missing
    const user = await User.findById(req.user.id).select('notifications');
    const unreadNotificationsCount = user && Array.isArray(user.notifications)
      ? user.notifications.filter(n => !n.read).length
      : 0;
    
    // Total unread = messages + notifications
    const unreadCount = unreadMessagesCount + unreadNotificationsCount;
    
    console.log(`[GetUnreadCount] User: ${req.user.id}, Messages: ${unreadMessagesCount}, Notifications: ${unreadNotificationsCount}, Total: ${unreadCount}`);

    res.json({
      success: true,
      unreadCount,
      unreadMessages: unreadMessagesCount,
      unreadNotifications: unreadNotificationsCount
    });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get message contacts (admins + instructors for students)
// @route   GET /api/messages/contacts
// @access  Private
exports.getContacts = async (req, res) => {
  try {
    const userRole = req.user.role;
    let contacts = [];

    if (userRole === 'student') {
      // Get admin (exclude deleted admins)
      const admins = await User.find({ 
        role: 'admin',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      }).select('name email avatar role');
      contacts = [...admins];

      // Get instructors of enrolled courses
      const user = await User.findById(req.user.id).populate({
        path: 'enrolledCourses.course',
        populate: {
          path: 'instructor',
          select: 'name email avatar role isDeleted status'
        }
      });

      const instructors = new Map();
      user.enrolledCourses.forEach(enrollment => {
        if (enrollment.course?.instructor) {
          const instructor = enrollment.course.instructor;
          if (!instructor.isDeleted && instructor.status !== 'deleted') {
            if (!instructors.has(instructor._id.toString())) {
              instructors.set(instructor._id.toString(), {
                ...instructor.toObject(),
                courseName: enrollment.course.name
              });
            }
          }
        }
      });

      contacts = [...contacts, ...Array.from(instructors.values())];
    } else if (userRole === 'instructor') {
      // Instructors can message admins (exclude deleted admins)
      const admins = await User.find({ 
        role: 'admin',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      }).select('name email avatar role');
      contacts = admins;
    } else if (userRole === 'admin') {
      // Admins can message everyone (exclude deleted accounts)
      const users = await User.find({ 
        _id: { $ne: req.user.id },
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      }).select('name email avatar role').limit(50);
      contacts = users;
    }

    res.json({
      success: true,
      contacts
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get notifications
// @route   GET /api/messages/notifications
// @access  Private
exports.getNotifications = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    const unreadCount = user.notifications.filter(n => !n.read).length;
    const recentNotifications = user.notifications
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    res.json({
      success: true,
      notifications: recentNotifications,
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Mark multiple messages as read
// @route   PUT /api/messages/mark-read
// @access  Private
exports.markMultipleAsRead = async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Message IDs array is required'
      });
    }

    // Update messages that belong to the user
    const result = await Message.updateMany(
      {
        _id: { $in: messageIds },
        recipient: req.user.id,
        isRead: false
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} message(s) marked as read`,
      count: result.modifiedCount
    });
  } catch (error) {
    console.error('Mark multiple as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Mark notifications as read
// @route   PUT /api/messages/notifications/mark-read
// @access  Private
exports.markNotificationsAsRead = async (req, res) => {
  try {
    const { notificationIds } = req.body;

    const user = await User.findById(req.user.id);

    if (!notificationIds || !Array.isArray(notificationIds)) {
      return res.status(400).json({
        success: false,
        message: 'Notification IDs array is required'
      });
    }

    // Mark specified notifications as read
    let updatedCount = 0;
    user.notifications.forEach(notification => {
      if (notificationIds.includes(notification._id.toString()) && !notification.read) {
        notification.read = true;
        updatedCount++;
      }
    });

    await user.save();
    
    // Recalculate unread count after save
    const remainingUnread = user.notifications.filter(n => !n.read).length;
    console.log(`[MarkNotificationsRead] Updated ${updatedCount} notifications, remaining unread: ${remainingUnread}`);

    res.json({
      success: true,
      message: `${updatedCount} notification(s) marked as read`,
      count: updatedCount,
      remainingUnread
    });
  } catch (error) {
    console.error('Mark notifications as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete notification
// @route   DELETE /api/messages/notifications/:id
// @access  Private
exports.deleteNotification = async (req, res) => {
  try {
    const notificationId = req.params.id;
    
    // Use atomic $pull operation to avoid version conflicts
    const result = await User.findOneAndUpdate(
      { 
        _id: req.user.id,
        'notifications._id': notificationId
      },
      { 
        $pull: { notifications: { _id: notificationId } }
      },
      { new: true }
    );

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // Dispatch event to update unread count
    console.log(`[DeleteNotification] Deleted notification ${notificationId} for user ${req.user.id}`);

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Search users for messaging (role-based)
// @route   GET /api/messages/search-users
// @access  Private (Admin/Instructor)
exports.searchUsers = async (req, res) => {
  try {
    const { query } = req.query;
    const userRole = req.user.role;
    const userId = req.user.id;

    if (!query || query.trim().length < 2) {
      return res.json({
        success: true,
        users: []
      });
    }

    const searchRegex = new RegExp(query, 'i');
    let users = [];

    if (userRole === 'admin') {
      // Admin can search all users (students and instructors), excluding deleted accounts
      users = await User.find({
        _id: { $ne: userId }, // Exclude self
        $or: [
          { name: searchRegex },
          { email: searchRegex }
        ],
        role: { $in: ['student', 'instructor'] },
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      })
        .select('name email avatar role')
        .limit(10);
    } else if (userRole === 'instructor') {
      // Instructor can only search students enrolled in their courses
      const Course = require('../models/Course');
      const Enrollment = require('../models/Enrollment');

      // Get courses taught by this instructor
      const instructorCourses = await Course.find({ instructor: userId }).select('_id');
      const courseIds = instructorCourses.map(c => c._id);

      if (courseIds.length === 0) {
        return res.json({
          success: true,
          users: []
        });
      }

      // Get enrolled students from these courses
      const enrollments = await Enrollment.find({
        course: { $in: courseIds },
        status: { $in: ['enrolled', 'approved', 'completed'] }
      }).populate({
        path: 'student',
        match: {
          $or: [
            { name: searchRegex },
            { email: searchRegex }
          ]
        },
        select: 'name email avatar role isDeleted status'
      });

      // Filter out null students, deleted accounts, and duplicates
      const studentMap = new Map();
      enrollments.forEach(enrollment => {
        const student = enrollment.student;
        if (student && !student.isDeleted && student.status !== 'deleted') {
          const studentId = student._id.toString();
          if (!studentMap.has(studentId)) {
            studentMap.set(studentId, student);
          }
        }
      });

      users = Array.from(studentMap.values()).slice(0, 10);
    } else {
      return res.status(403).json({
        success: false,
        message: 'Only admins and instructors can search for message recipients'
      });
    }

    res.json({
      success: true,
      users
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
