const mongoose = require('mongoose');

const telegramFileSchema = new mongoose.Schema({
  fileName: {
    type: String,
    required: true,
    trim: true
  },
  fileSize: {
    type: Number
  },
  mimeType: {
    type: String
  },
  telegramFileId: {
    type: String,
    index: true
  },
  telegramMessageId: {
    type: Number,
    index: true
  },
  telegramChatId: {
    type: String
  },
  downloadOverrideUrl: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'soft_deleted', 'changed', 'deleted'],
    default: 'active',
    index: true
  },
  statusChangedAt: {
    type: Date,
    default: Date.now
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    default: null
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: null
  },
  section: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section',
    default: null
  },
  content: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Content',
    default: null
  },
  contentType: {
    type: String,
    enum: ['assignment', 'project', 'solution', 'other'],
    default: 'other',
    index: true
  },
  replaces: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TelegramFile',
    default: null
  },
  replacedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TelegramFile',
    default: null
  },
  softDeletedAt: {
    type: Date,
    default: null
  },
  softDeletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

telegramFileSchema.index({ status: 1, uploadedAt: -1 });
telegramFileSchema.index({ uploadedBy: 1, course: 1 });
telegramFileSchema.index({ content: 1, telegramFileId: 1 });

module.exports = mongoose.model('TelegramFile', telegramFileSchema);
