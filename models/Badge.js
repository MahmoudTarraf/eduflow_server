const mongoose = require('mongoose');

const badgeSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Badge title is required'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Badge description is required']
  },
  icon: {
    type: String,
    default: '🏅' // Emoji or icon identifier
  },
  conditionType: {
    type: String,
    required: true,
    enum: ['lesson', 'quiz', 'course', 'streak', 'points'],
    index: true
  },
  threshold: {
    type: Number,
    required: [true, 'Threshold is required'],
    min: 1
  },
  pointsReward: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index for efficient queries
badgeSchema.index({ conditionType: 1, isActive: 1 });

module.exports = mongoose.model('Badge', badgeSchema);
