const mongoose = require('mongoose');

const progressSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
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
  lectures: [{
    lecture: {
      type: mongoose.Schema.ObjectId,
      ref: 'Course.lectures'
    },
    watched: {
      type: Boolean,
      default: false
    },
    watchedAt: Date,
    watchTime: Number, // in seconds
    completed: {
      type: Boolean,
      default: false
    }
  }],
  assignments: [{
    assignment: {
      type: mongoose.Schema.ObjectId,
      ref: 'Course.assignments'
    },
    submitted: {
      type: Boolean,
      default: false
    },
    submittedAt: Date,
    grade: Number,
    feedback: String
  }],
  projects: [{
    project: {
      type: mongoose.Schema.ObjectId,
      ref: 'Course.projects'
    },
    submitted: {
      type: Boolean,
      default: false
    },
    submittedAt: Date,
    grade: Number,
    feedback: String
  }],
  overallProgress: {
    lectures: {
      type: Number,
      default: 0
    },
    assignments: {
      type: Number,
      default: 0
    },
    projects: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  certificateEarned: {
    type: Boolean,
    default: false
  },
  certificateEarnedAt: Date
}, {
  timestamps: true
});

// Calculate overall progress
progressSchema.pre('save', function(next) {
  const lectures = this.lectures.filter(l => l.completed).length;
  const assignments = this.assignments.filter(a => a.submitted).length;
  const projects = this.projects.filter(p => p.submitted).length;
  
  this.overallProgress.lectures = lectures;
  this.overallProgress.assignments = assignments;
  this.overallProgress.projects = projects;
  
  // Calculate total progress percentage
  const totalItems = this.lectures.length + this.assignments.length + this.projects.length;
  if (totalItems > 0) {
    this.overallProgress.total = Math.round(((lectures + assignments + projects) / totalItems) * 100);
  }
  
  next();
});

module.exports = mongoose.model('Progress', progressSchema);
