const mongoose = require('mongoose');

const youtubeVideoSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  youtubeVideoId: {
    type: String,
    required: true,
    unique: true
  },
  youtubeUrl: {
    type: String,
    required: true
  },
  privacyStatus: {
    type: String,
    enum: ['private', 'unlisted', 'public'],
    default: 'unlisted'
  },
  status: {
    type: String,
    enum: ['active', 'superseded', 'pending_deletion', 'orphaned', 'physically_deleted'],
    default: 'active'
  },
  statusChangedAt: {
    type: Date,
    default: Date.now
  },
  physicallyDeletedAt: {
    type: Date,
    default: null
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course'
  },
  section: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section'
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group'
  },
  content: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Content'
  },
  originalFilename: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number // in bytes
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for faster queries
youtubeVideoSchema.index({ uploadedBy: 1, course: 1 });
youtubeVideoSchema.index({ section: 1 });
youtubeVideoSchema.index({ youtubeVideoId: 1 });
youtubeVideoSchema.index({ status: 1, uploadedAt: -1 });

module.exports = mongoose.model('YouTubeVideo', youtubeVideoSchema);
