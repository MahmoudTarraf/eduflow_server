const mongoose = require('mongoose');

const instructorEarningSchema = new mongoose.Schema({
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Instructor is required'],
    index: true
  },
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
  sectionPayment: {
    type: mongoose.Schema.ObjectId,
    ref: 'SectionPayment',
    required: [true, 'Section payment reference is required'],
    unique: true // Prevent duplicate earnings for same payment
  },
  
  // Agreement tracking - which agreement was active when this earning was created
  agreementId: {
    type: mongoose.Schema.ObjectId,
    ref: 'InstructorEarningsAgreement',
    default: null
  },
  agreementType: {
    type: String,
    enum: ['global', 'custom', 'legacy'],
    default: 'global'
  },
  agreementVersion: {
    type: Number,
    default: 1
  },
  
  // Financial details
  studentPaidAmount: {
    type: Number,
    required: [true, 'Student paid amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  // Original base amount in SYP cents (for wallet discount reporting)
  baseAmountSYP: {
    type: Number,
    min: [0, 'Base amount cannot be negative'],
    default: 0
  },
  // Wallet balance used for this payment (in SYP cents)
  balanceUsed: {
    type: Number,
    min: [0, 'Balance used cannot be negative'],
    default: 0
  },
  // Percentage discount applied via wallet balance (0-100)
  balanceDiscountPercentage: {
    type: Number,
    min: [0, 'Discount percentage cannot be negative'],
    max: [100, 'Discount percentage cannot exceed 100'],
    default: 0
  },
  currency: {
    type: String,
    required: true,
    default: 'USD',
    enum: ['USD', 'SYP', 'SYR', 'EUR', 'GBP']
  },
  instructorPercentage: {
    type: Number,
    required: [true, 'Instructor percentage is required'],
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100'],
    default: 80
  },
  instructorEarningAmount: {
    type: Number,
    required: [true, 'Instructor earning amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  adminCommissionAmount: {
    type: Number,
    required: [true, 'Admin commission amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['accrued', 'requested', 'paid', 'rejected'],
    default: 'accrued',
    index: true
  },
  payoutRequestId: {
    type: mongoose.Schema.ObjectId,
    ref: 'InstructorPayoutRequest',
    default: null
  },
  
  // Timestamp tracking
  accruedAt: {
    type: Date,
    default: Date.now
  },
  requestedAt: {
    type: Date,
    default: null
  },
  paidAt: {
    type: Date,
    default: null
  },
  rejectedAt: {
    type: Date,
    default: null
  },
  
  // Payment metadata
  // Platform percentage at time of payment (for audit trail)
  platformPercentage: {
    type: Number,
    required: [true, 'Platform percentage is required'],
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100'],
    default: 20
  },
  
  paymentMethod: {
    type: String,
    trim: true,
    default: 'other'
  },
  notes: {
    type: String,
    maxlength: [2000, 'Notes cannot exceed 2000 characters']
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
instructorEarningSchema.index({ instructor: 1, status: 1 });
instructorEarningSchema.index({ instructor: 1, course: 1 });
instructorEarningSchema.index({ payoutRequestId: 1 });
instructorEarningSchema.index({ accruedAt: -1 });

// Validation: Ensure amounts add up correctly
instructorEarningSchema.pre('save', function(next) {
  // For wallet-discounted payments, allow flexible splits as long as the
  // instructor and admin amounts together equal the studentPaidAmount.
  if (this.balanceUsed && this.balanceUsed > 0 && this.baseAmountSYP && this.baseAmountSYP > 0) {
    const total = (this.instructorEarningAmount || 0) + (this.adminCommissionAmount || 0);
    if (Math.abs(total - this.studentPaidAmount) > 1) {
      return next(new Error('Admin and instructor amounts must add up to student paid amount'));
    }
    return next();
  }

  const calculated = Math.floor(this.studentPaidAmount * this.instructorPercentage / 100);
  if (this.instructorEarningAmount !== calculated) {
    return next(new Error('Instructor earning amount does not match calculated value'));
  }
  
  const expectedCommission = this.studentPaidAmount - this.instructorEarningAmount;
  if (this.adminCommissionAmount !== expectedCommission) {
    return next(new Error('Admin commission amount does not match calculated value'));
  }
  
  next();
});

// Prevent status change from 'paid' to anything else (immutable)
instructorEarningSchema.pre('save', function(next) {
  if (this.isModified('status') && this._original?.status === 'paid') {
    return next(new Error('Cannot change status from paid'));
  }
  next();
});

// Store original status for validation
instructorEarningSchema.post('init', function() {
  this._original = this.toObject();
});

// Virtual to ensure platformPercentage is always calculated
instructorEarningSchema.virtual('calculatedPlatformPercentage').get(function() {
  return this.platformPercentage || (100 - this.instructorPercentage);
});

// Static method to calculate available balance for instructor
instructorEarningSchema.statics.getAvailableBalance = async function(instructorId) {
  const result = await this.aggregate([
    {
      $match: {
        instructor: new mongoose.Types.ObjectId(instructorId),
        status: 'accrued'
      }
    },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$instructorEarningAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  return result.length > 0 ? result[0] : { totalAmount: 0, count: 0 };
};

// Static method to get earnings summary (MULTI-CURRENCY SUPPORT)
instructorEarningSchema.statics.getSummary = async function(instructorId) {
  // Group by status and currency
  const summaryByCurrency = await this.aggregate([
    {
      $match: { instructor: new mongoose.Types.ObjectId(instructorId) }
    },
    {
      $group: {
        _id: { status: '$status', currency: '$currency' },
        totalAmount: { $sum: '$instructorEarningAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  // Group by status only (backward compatibility)
  const summaryByStatus = await this.aggregate([
    {
      $match: { instructor: new mongoose.Types.ObjectId(instructorId) }
    },
    {
      $group: {
        _id: '$status',
        totalAmount: { $sum: '$instructorEarningAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  const result = {
    accrued: { amount: 0, count: 0, byCurrency: {} },
    requested: { amount: 0, count: 0, byCurrency: {} },
    paid: { amount: 0, count: 0, byCurrency: {} },
    rejected: { amount: 0, count: 0, byCurrency: {} }
  };
  
  // Fill backward-compatible totals (primarily SYP)
  summaryByStatus.forEach(item => {
    result[item._id] = { 
      amount: item.totalAmount, 
      count: item.count,
      byCurrency: result[item._id]?.byCurrency || {}
    };
  });
  
  // Fill multi-currency breakdown
  summaryByCurrency.forEach(item => {
    const status = item._id.status;
    const currency = item._id.currency || 'SYP';
    if (!result[status].byCurrency[currency]) {
      result[status].byCurrency[currency] = { amount: 0, count: 0 };
    }
    result[status].byCurrency[currency] = {
      amount: item.totalAmount,
      count: item.count
    };
  });
  
  return result;
};

module.exports = mongoose.model('InstructorEarning', instructorEarningSchema);
