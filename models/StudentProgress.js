const mongoose = require('mongoose');

const studentProgressSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Student is required']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Course is required']
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: [true, 'Group is required']
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: [true, 'Section is required']
  },
  item: {
    type: mongoose.Schema.ObjectId,
    ref: 'Content',
    required: [true, 'Content item is required']
  },
  content: {
    type: mongoose.Schema.ObjectId,
    ref: 'Content'
  },
  type: {
    type: String,
    enum: ['lecture', 'assignment', 'project'],
    required: true
  },
  contentType: {
    type: String,
    enum: ['lecture', 'assignment', 'project']
  },
  completed: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  },
  viewedAt: {
    type: Date
  },
  // For video progress
  watchTime: {
    type: Number, // in seconds
    default: 0
  },
  lastPosition: {
    type: Number, // last playback position in seconds
    default: 0
  },
  // For assignments and projects
  submitted: {
    type: Boolean,
    default: false
  },
  submittedAt: {
    type: Date
  },
  submissionUrl: {
    type: String
  },
  grade: {
    score: {
      type: Number,
      min: 0,
      max: 100
    },
    feedback: {
      type: String
    },
    gradedAt: {
      type: Date
    },
    gradedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
studentProgressSchema.index({ student: 1, course: 1, group: 1 });
studentProgressSchema.index({ student: 1, section: 1 });
studentProgressSchema.index({ student: 1, item: 1 }, { unique: true });
studentProgressSchema.index({ student: 1, content: 1 });
studentProgressSchema.index({ group: 1, section: 1 });

// Mark as completed when criteria met
studentProgressSchema.pre('save', function(next) {
  const progressType = this.type || this.contentType;
  if (progressType === 'lecture') {
    // Lecture is completed if watched at least 90% of video
    if (this.watchTime && this.populated && this.populated('item') && this.populated('item').video && this.populated('item').video.duration) {
      const watchPercentage = (this.watchTime / this.populated('item').video.duration) * 100;
      if (watchPercentage >= 90 && !this.completed) {
        this.completed = true;
        this.completedAt = new Date();
      }
    }
  } else if (progressType === 'assignment' || progressType === 'project') {
    // Assignment/Project is completed when submitted
    if (this.submitted && !this.completed) {
      this.completed = true;
      this.completedAt = this.submittedAt;
    }
  }
  next();
});

module.exports = mongoose.model('StudentProgress', studentProgressSchema);
