const mongoose = require('mongoose');

const adminLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    enum: [
      'user_banned',
      'user_unbanned',
      'user_suspended',
      'user_unsuspended',
      'user_deleted',
      'course_approved',
      'course_rejected',
      'instructor_approved',
      'instructor_rejected',
      'payment_verified',
      'enrollment_approved',
      'course_price_changed',
      'other'
    ],
    index: true
  },
  targetUser: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    index: true
  },
  targetUserRole: {
    type: String,
    enum: ['student', 'instructor', 'admin']
  },
  performedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  performedByRole: {
    type: String,
    enum: ['admin'],
    default: 'admin'
  },
  details: {
    type: String,
    maxlength: 1000
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  ipAddress: String,
  userAgent: String
}, {
  timestamps: true
});

// Indexes for efficient queries
adminLogSchema.index({ action: 1, createdAt: -1 });
adminLogSchema.index({ targetUser: 1, createdAt: -1 });
adminLogSchema.index({ performedBy: 1, createdAt: -1 });
adminLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AdminLog', adminLogSchema);
