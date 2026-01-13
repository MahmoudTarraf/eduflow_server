const mongoose = require('mongoose');

const deleteRequestSchema = new mongoose.Schema({
  targetType: {
    type: String,
    enum: ['course', 'group', 'section', 'content'],
    required: true
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course'
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group'
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section'
  },
  content: {
    type: mongoose.Schema.ObjectId,
    ref: 'Content'
  },
  requestedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  reason: {
    type: String,
    maxlength: 1000,
    default: ''
  },
  adminNote: {
    type: String,
    maxlength: 1000
  },
  rejectionReason: {
    type: String,
    maxlength: [500, 'Rejection reason cannot exceed 500 characters']
  },
  resolvedAt: {
    type: Date
  },
  resolvedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Ensure exactly one target reference is set based on targetType
deleteRequestSchema.pre('validate', function(next) {
  if (this.targetType === 'course') {
    if (!this.course) {
      return next(new Error('Course delete requests must reference a course'));
    }
    this.group = undefined;
    this.section = undefined;
    this.content = undefined;
  } else if (this.targetType === 'group') {
    if (!this.group) {
      return next(new Error('Group delete requests must reference a group'));
    }
    this.course = undefined;
    this.section = undefined;
    this.content = undefined;
  } else if (this.targetType === 'section') {
    if (!this.section) {
      return next(new Error('Section delete requests must reference a section'));
    }
    this.course = undefined;
    this.group = undefined;
    this.content = undefined;
  } else if (this.targetType === 'content') {
    if (!this.content) {
      return next(new Error('Content delete requests must reference a content item'));
    }
    this.course = undefined;
    this.group = undefined;
    this.section = undefined;
  }
  next();
});

deleteRequestSchema.index({ targetType: 1, course: 1, group: 1, section: 1, content: 1, status: 1 });

module.exports = mongoose.model('DeleteRequest', deleteRequestSchema);
