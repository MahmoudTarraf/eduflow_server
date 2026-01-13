const mongoose = require('mongoose');

const PendingCourseCostChangeSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
    index: true
  },
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  oldCost: {
    type: Number,
    required: true
  },
  newCost: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'SYP'
  },
  totalPaidSections: {
    type: Number,
    required: true
  },
  scaleFactor: {
    type: Number,
    required: true
  },
  affectedSections: [{
    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section'
    },
    sectionName: String,
    oldPrice: Number,
    newPrice: Number
  }],
  status: {
    type: String,
    enum: ['pending', 'approved_auto', 'approved_manual', 'cancelled'],
    default: 'pending'
  },
  reason: {
    type: String
  },
  confirmedAt: Date,
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  },
  adminNotified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index for cleanup of expired changes
PendingCourseCostChangeSchema.index({ expiresAt: 1, status: 1 });

module.exports = mongoose.model('PendingCourseCostChange', PendingCourseCostChangeSchema);
