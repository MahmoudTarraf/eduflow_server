const mongoose = require('mongoose');

const sectionPaymentSchema = new mongoose.Schema({
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
    ref: 'Group'
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: true
  },
  // Base amount in SYP (for internal tracking)
  baseAmountSYP: {
    type: Number,
    required: true,
    min: [0, 'Base amount must be non-negative']
  },
  // Actual paid amount (after currency conversion)
  amountCents: {
    type: Number,
    required: true,
    min: [0, 'Amount must be non-negative']
  },
  currency: {
    type: String,
    required: true,
    default: 'SYP',
    enum: ['USD', 'SYP', 'EUR', 'GBP']
  },
  // Exchange rate used at payment time
  exchangeRate: {
    type: Number,
    default: 1
  },
  paymentMethod: {
    type: String,
    trim: true,
    default: 'other'
  },
  // Points-to-Balance usage tracking
  useBalance: {
    type: Boolean,
    default: false,
    index: true
  },
  balanceUsed: {
    type: Number,
    default: 0,
    min: [0, 'Balance used must be non-negative'] // Amount in cents
  },
  pointsUsed: {
    type: Number,
    default: 0,
    min: [0, 'Points used must be non-negative']
  },
  finalAmountCents: {
    type: Number, // Final amount after balance discount
    min: [0, 'Final amount must be non-negative']
  },
  balanceDiscountPercentage: {
    type: Number,
    default: 0,
    min: [0, 'Discount percentage must be between 0 and 100'],
    max: [100, 'Discount percentage must be between 0 and 100']
  },
  originalCoursePrice: {
    type: Number, // Store original price for reference
    min: [0, 'Original course price must be non-negative']
  },
  receipt: {
    originalName: String,
    storedName: String,
    url: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  rejectionReason: String,
  submittedAt: {
    type: Date,
    default: Date.now
  },
  processedAt: Date,
  processedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  // Earnings calculation (set when approved by admin)
  instructorEarnings: {
    type: Number,
    default: 0,
    min: [0, 'Instructor earnings must be non-negative']
  },
  platformEarnings: {
    type: Number,
    default: 0,
    min: [0, 'Platform earnings must be non-negative']
  },
  instructorDiscount: {
    type: Number,
    default: 0,
    min: [0, 'Instructor discount must be non-negative']
  },
  platformDiscount: {
    type: Number,
    default: 0,
    min: [0, 'Platform discount must be non-negative']
  },
  instructorPercentage: {
    type: Number,
    min: [0, 'Percentage must be between 0 and 100'],
    max: [100, 'Percentage must be between 0 and 100']
  },
  platformPercentage: {
    type: Number,
    min: [0, 'Percentage must be between 0 and 100'],
    max: [100, 'Percentage must be between 0 and 100']
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

sectionPaymentSchema.index({ student: 1, section: 1 }, { unique: false });
sectionPaymentSchema.index({ status: 1, submittedAt: -1 });
sectionPaymentSchema.index({ student: 1, course: 1, section: 1, status: 1 });

module.exports = mongoose.model('SectionPayment', sectionPaymentSchema);
