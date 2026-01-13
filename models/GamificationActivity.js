const mongoose = require('mongoose');

const gamificationActivitySchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  activityType: {
    type: String,
    required: true,
    index: true
  },
  contentId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'contentModel',
    required: true,
    index: true
  },
  // Optional: which model contentId points to (Content, ActiveTest, etc.)
  contentModel: {
    type: String,
    default: 'Content'
  },
  contentTitle: {
    type: String,
    default: ''
  },
  contentType: {
    type: String,
    default: '' // e.g. "Video", "Assignment", "Project", "Test", "Course"
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    index: true
  },
  metadata: {
    type: Object,
    default: {}
  },
  awardedPoints: {
    type: Number,
    default: 0
  },
  uniquenessKey: {
    type: String,
    required: true,
    unique: true
  }
}, {
  timestamps: true
});

// Enforce one-time reward per (student, activityType, contentId)
gamificationActivitySchema.index({ student: 1, activityType: 1, contentId: 1 }, { unique: true });

module.exports = mongoose.model('GamificationActivity', gamificationActivitySchema);
