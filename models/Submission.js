const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
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
  type: {
    type: String,
    enum: ['assignment', 'project'],
    required: true
  },
  assignment: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course.assignments'
  },
  project: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course.projects'
  },
  files: [{
    filename: String,
    originalName: String,
    fileUrl: String,
    fileSize: Number,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  status: {
    type: String,
    enum: ['submitted', 'graded', 'returned'],
    default: 'submitted'
  },
  grade: {
    score: {
      type: Number,
      min: 0,
      max: 100
    },
    feedback: String,
    gradedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    gradedAt: Date
  },
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Submission', submissionSchema);
