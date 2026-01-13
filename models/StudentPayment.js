const mongoose = require('mongoose');

const studentPaymentSchema = new mongoose.Schema({
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
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: [true, 'Section is required']
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: [true, 'Group is required']
  },
  amountSYR: {
    type: Number,
    required: [true, 'Payment amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'refunded'],
    default: 'pending'
  },
  verified: {
    type: Boolean,
    default: false
  },
  verifiedAt: {
    type: Date
  },
  verifiedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  paidAt: {
    type: Date
  },
  paymentMethod: {
    type: String,
    trim: true,
    default: 'other'
  },
  receiptUrl: {
    type: String
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
studentPaymentSchema.index({ student: 1, course: 1, section: 1 });
studentPaymentSchema.index({ group: 1, status: 1 });
studentPaymentSchema.index({ status: 1, verified: 1 });

module.exports = mongoose.model('StudentPayment', studentPaymentSchema);
