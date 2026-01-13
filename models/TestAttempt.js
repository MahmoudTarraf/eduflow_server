const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionId: {
    type: mongoose.Schema.ObjectId,
    required: true
  },
  selectedOptionIndex: {
    type: Number,
    required: true
  },
  isCorrect: {
    type: Boolean,
    default: false
  },
  pointsEarned: {
    type: Number,
    default: 0
  }
});

const testAttemptSchema = new mongoose.Schema({
  test: {
    type: mongoose.Schema.ObjectId,
    ref: 'ActiveTest',
    required: [true, 'Test reference is required']
  },
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Student reference is required']
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: true
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: true
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: true
  },
  answers: [answerSchema],
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date
  },
  submitTime: {
    type: Date
  },
  status: {
    type: String,
    enum: ['in_progress', 'submitted', 'expired', 'graded'],
    default: 'in_progress'
  },
  score: {
    type: Number,
    default: 0,
    min: [0, 'Score cannot be negative'],
    max: [100, 'Score cannot exceed 100']
  },
  pointsEarned: {
    type: Number,
    default: 0
  },
  totalPoints: {
    type: Number,
    required: true
  },
  passed: {
    type: Boolean,
    default: false
  },
  attemptNumber: {
    type: Number,
    required: true,
    min: [1, 'Attempt number must be at least 1']
  },
  timeSpentSeconds: {
    type: Number,
    default: 0
  },
  autoSubmitted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
testAttemptSchema.index({ test: 1, student: 1, attemptNumber: 1 });
testAttemptSchema.index({ student: 1, status: 1 });
testAttemptSchema.index({ test: 1, status: 1 });
testAttemptSchema.index({ course: 1, student: 1 });

// Calculate time spent before saving
testAttemptSchema.pre('save', function(next) {
  if (this.submitTime && this.startTime) {
    this.timeSpentSeconds = Math.floor((this.submitTime - this.startTime) / 1000);
  }
  next();
});

module.exports = mongoose.model('TestAttempt', testAttemptSchema);
