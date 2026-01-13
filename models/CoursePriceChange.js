const mongoose = require('mongoose');

const coursePriceChangeSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: true,
    index: true
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
    default: 'USD'
  },
  changedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  changedByRole: {
    type: String,
    enum: ['admin', 'instructor'],
    required: true
  },
  reason: {
    type: String,
    maxlength: 500
  },
  sectionsAdjusted: {
    type: Boolean,
    default: false
  },
  adjustmentDetails: {
    scaleFactor: Number,
    affectedSections: [{
      section: {
        type: mongoose.Schema.ObjectId,
        ref: 'Section'
      },
      oldPrice: Number,
      newPrice: Number
    }]
  },
  notificationsSent: {
    email: {
      type: Boolean,
      default: false
    },
    inApp: {
      type: Boolean,
      default: false
    }
  }
}, {
  timestamps: true
});

// Index for faster queries
coursePriceChangeSchema.index({ course: 1, createdAt: -1 });
coursePriceChangeSchema.index({ changedBy: 1, createdAt: -1 });

module.exports = mongoose.model('CoursePriceChange', coursePriceChangeSchema);
