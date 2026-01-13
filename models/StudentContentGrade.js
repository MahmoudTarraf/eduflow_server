const mongoose = require('mongoose');

const studentContentGradeSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: mongoose.Schema.ObjectId,
    ref: 'Content',
    required: true
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
  gradePercent: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    min: 0,
    max: 100,
    get: (value) => (value ? parseFloat(value.toString()) : 0),
    set: (value) => {
      const num = parseFloat(value);
      return Math.min(100, Math.max(0, isNaN(num) ? 0 : num));
    }
  },
  status: {
    type: String,
    enum: ['not_delivered', 'submitted_ungraded', 'graded', 'watched'],
    default: 'not_delivered'
  },
  instructorFeedback: {
    type: String,
    default: ''
  },
  submissionFile: {
    storageType: String,
    telegramFileId: String,
    telegramMessageId: Number,
    telegramChatId: String,
    originalName: String,
    storedName: String,
    path: String,
    localPath: String,
    url: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date
  },
  reuploadRequested: {
    type: Boolean,
    default: false
  },
  reuploadStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected', 'completed'],
    default: 'none'
  },
  reuploadReason: {
    type: String
  },
  reuploadRequestedAt: Date,
  reuploadApprovedAt: Date,
  reuploadRejectedAt: Date,
  reuploadUsed: {
    type: Boolean,
    default: false
  },
  reuploadSubmittedAt: Date,
  reuploadSubmissionFile: {
    storageType: String,
    telegramFileId: String,
    telegramMessageId: Number,
    telegramChatId: String,
    originalName: String,
    storedName: String,
    path: String,
    localPath: String,
    url: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date
  },
  regradeUsed: {
    type: Boolean,
    default: false
  },
  regradeAt: Date,
  initialGradePercent: {
    type: mongoose.Schema.Types.Decimal128,
    get: (value) => (value ? parseFloat(value.toString()) : null)
  },
  initialGradedAt: Date,
  initialGradedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  initialFeedback: String,
  gradedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  gradedAt: Date,
  watchedDuration: {
    type: Number,
    default: 0
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true }
});

// Indexes for efficient queries
studentContentGradeSchema.index({ student: 1, content: 1 }, { unique: true });
studentContentGradeSchema.index({ student: 1, section: 1 });
studentContentGradeSchema.index({ student: 1, course: 1 });
studentContentGradeSchema.index({ content: 1, status: 1 });

// Update the updatedAt field before saving
studentContentGradeSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('StudentContentGrade', studentContentGradeSchema);
