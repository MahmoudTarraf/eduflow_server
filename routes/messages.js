const express = require('express');
const { body } = require('express-validator');
const {
  getMessages,
  getMessage,
  sendMessage,
  sendBulkMessage,
  markAsRead,
  markMultipleAsRead,
  markNotificationsAsRead,
  deleteMessage,
  deleteNotification,
  getNotifications,
  getUnreadCount,
  getContacts,
  searchUsers
} = require('../controllers/messages');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @desc    Get user messages
// @route   GET /api/messages
// @access  Private
router.get('/', protect, getMessages);

// @desc    Get unread message count
// @route   GET /api/messages/unread-count
// @access  Private
router.get('/unread-count', protect, getUnreadCount);

// @desc    Get message contacts
// @route   GET /api/messages/contacts
// @access  Private
router.get('/contacts', protect, getContacts);

// @desc    Search users for messaging
// @route   GET /api/messages/search-users
// @access  Private (Admin/Instructor)
router.get('/search-users', protect, authorize('admin', 'instructor'), searchUsers);

// @desc    Get notifications
// @route   GET /api/messages/notifications
// @access  Private
// IMPORTANT: This must come BEFORE /:id route to avoid casting "notifications" as ObjectId
router.get('/notifications', protect, getNotifications);

// @desc    Get single message
// @route   GET /api/messages/:id
// @access  Private
router.get('/:id', protect, getMessage);

// @desc    Send message
// @route   POST /api/messages
// @access  Private
router.post('/', protect, [
  body('recipient').notEmpty().withMessage('Recipient is required'),
  body('subject').notEmpty().withMessage('Subject is required'),
  body('content').notEmpty().withMessage('Message content is required')
], sendMessage);

// @desc    Send bulk message
// @route   POST /api/messages/bulk
// @access  Private (Instructor/Admin)
router.post('/bulk', protect, authorize('instructor', 'admin'), [
  body('recipientType').notEmpty().withMessage('Recipient type is required'),
  body('subject').notEmpty().withMessage('Subject is required'),
  body('content').notEmpty().withMessage('Message content is required')
], sendBulkMessage);

// @desc    Mark multiple messages as read
// @route   PUT /api/messages/mark-read
// @access  Private
router.put('/mark-read', protect, markMultipleAsRead);

// @desc    Mark notifications as read
// @route   PUT /api/messages/notifications/mark-read
// @access  Private
router.put('/notifications/mark-read', protect, markNotificationsAsRead);

// @desc    Delete notification
// @route   DELETE /api/messages/notifications/:id
// @access  Private
router.delete('/notifications/:id', protect, deleteNotification);

// @desc    Mark message as read
// @route   PUT /api/messages/:id/read
// @access  Private
router.put('/:id/read', protect, markAsRead);

// @desc    Delete message
// @route   DELETE /api/messages/:id
// @access  Private
router.delete('/:id', protect, deleteMessage);

module.exports = router;
