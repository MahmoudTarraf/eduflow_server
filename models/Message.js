const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  conversationType: {
    type: String,
    enum: ['direct', 'group', 'admin'],
    required: true,
    default: 'direct'
  },
  subject: {
    type: String,
    trim: true,
    maxlength: [200, 'Subject cannot be more than 200 characters']
  },
  content: {
    type: String,
    required: true,
    maxlength: [2000, 'Message content cannot be more than 2000 characters']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course'
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  attachments: [{
    filename: String,
    originalName: String,
    fileUrl: String,
    fileSize: Number
  }],
  priority: {
    type: String,
    enum: ['low', 'normal', 'high'],
    default: 'normal'
  }
}, {
  timestamps: true
});

// Indexes to optimize common queries
messageSchema.index({ recipient: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ conversationType: 1, group: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
