const mongoose = require('mongoose');

const instructorPayoutRequestSchema = new mongoose.Schema({
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Instructor is required'],
    index: true
  },
  
  // Financial details
  requestedAmount: {
    type: Number,
    required: [true, 'Requested amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  currency: {
    type: String,
    required: true,
    default: 'USD',
    enum: ['USD', 'SYP', 'SYR', 'EUR']
  },
  earningIds: [{
    type: mongoose.Schema.ObjectId,
    ref: 'InstructorEarning',
    required: true
  }],
  
  // Payment method & receiver details
  paymentMethod: {
    type: String,
    required: [true, 'Payment method is required']
  },
  receiverDetails: {
    receiverName: {
      type: String,
      required: [true, 'Receiver name is required'],
      trim: true,
      maxlength: [100, 'Receiver name cannot exceed 100 characters']
    },
    receiverPhone: {
      type: String,
      required: [true, 'Receiver phone is required'],
      trim: true,
      maxlength: [20, 'Phone cannot exceed 20 characters']
    },
    receiverLocation: {
      type: String,
      trim: true,
      maxlength: [200, 'Location cannot exceed 200 characters']
    },
    accountDetails: {
      type: String,
      trim: true,
      maxlength: [500, 'Account details cannot exceed 500 characters']
    }
  },
  
  // Status & processing
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    maxlength: [1000, 'Rejection reason cannot exceed 1000 characters']
  },
  cancellationReason: {
    type: String,
    maxlength: [1000, 'Cancellation reason cannot exceed 1000 characters']
  },
  
  // Proof of payment (uploaded by admin on approval)
  payoutProof: {
    originalName: String,
    storedName: String,
    url: String,
    mimeType: {
      type: String,
      enum: ['image/jpeg', 'image/png', 'application/pdf', 'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed', '']
    },
    size: {
      type: Number,
      max: [10485760, 'File size cannot exceed 10MB'] // 10MB in bytes
    },
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  },
  
  // Processing details
  requestedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  processedAt: {
    type: Date,
    default: null
  },
  processedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Audit & security
  ipAddress: {
    type: String,
    trim: true
  },
  userAgent: {
    type: String,
    trim: true
  },
  securityFlags: [{
    type: String,
    trim: true
  }]
}, {
  timestamps: true
});

// Compound indexes for queries
instructorPayoutRequestSchema.index({ instructor: 1, status: 1, requestedAt: -1 });
instructorPayoutRequestSchema.index({ status: 1, requestedAt: -1 });

// Validation: Ensure earningIds array is not empty
instructorPayoutRequestSchema.pre('save', function(next) {
  if (!this.earningIds || this.earningIds.length === 0) {
    return next(new Error('Payout request must include at least one earning'));
  }
  next();
});

// Prevent changing locked amount/earnings when re-requesting a rejected payout
instructorPayoutRequestSchema.pre('save', function(next) {
  if (!this.isNew && this._original) {
    const wasRejected = this._original.status === 'rejected';
    const isNowPending = this.status === 'pending';
    if (wasRejected && isNowPending) {
      // Disallow changes to requestedAmount and earningIds
      if (this.isModified('requestedAmount') || this.isModified('earningIds')) {
        return next(new Error('Cannot change locked payout amount or earnings when re-requesting.'));
      }
    }
  }
  next();
});

// Prevent modification after approval
instructorPayoutRequestSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew && this._original?.status === 'approved') {
    // Allow only specific fields to be modified after approval
    const allowedModifications = ['payoutProof', 'updatedAt'];
    const modifiedPaths = this.modifiedPaths();
    const unauthorizedMods = modifiedPaths.filter(path => !allowedModifications.includes(path));
    
    if (unauthorizedMods.length > 0) {
      return next(new Error('Cannot modify approved payout request'));
    }
  }
  next();
});

// Store original for validation
instructorPayoutRequestSchema.post('init', function() {
  this._original = this.toObject();
});

// Virtual for checking if can be cancelled
instructorPayoutRequestSchema.virtual('canBeCancelled').get(function() {
  if (this.status !== 'pending') return false;
  const hoursSinceRequest = (Date.now() - this.requestedAt) / (1000 * 60 * 60);
  return hoursSinceRequest <= 24;
});

// Static method to get pending requests count for instructor
instructorPayoutRequestSchema.statics.hasPendingRequest = async function(instructorId) {
  const count = await this.countDocuments({
    instructor: instructorId,
    status: 'pending'
  });
  return count > 0;
};

module.exports = mongoose.model('InstructorPayoutRequest', instructorPayoutRequestSchema);
