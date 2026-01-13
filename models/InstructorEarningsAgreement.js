const mongoose = require('mongoose');

const instructorEarningsAgreementSchema = new mongoose.Schema({
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Instructor is required'],
    index: true
  },
  
  // Agreement type: 'global' uses platform defaults, 'custom' has dedicated percentages
  agreementType: {
    type: String,
    enum: ['global', 'custom'],
    default: 'global',
    required: true
  },
  
  // Revenue split percentages
  platformPercentage: {
    type: Number,
    required: true,
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  instructorPercentage: {
    type: Number,
    required: true,
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  
  // Agreement status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'expired'],
    default: 'pending',
    index: true
  },
  
  // Rejection details
  rejectionReason: {
    type: String,
    maxlength: [2000, 'Rejection reason cannot exceed 2000 characters']
  },
  rejectedAt: {
    type: Date
  },
  
  // Approval details
  approvedAt: {
    type: Date
  },
  approvedByInstructor: {
    type: Boolean,
    default: false
  },
  
  // PDF document
  pdfUrl: {
    type: String
  },
  pdfPublicId: {
    type: String // Cloudinary public ID for deletion
  },
  localPath: {
    type: String // Local file path for local storage
  },
  storage: {
    type: String,
    enum: ['local', 'cloudinary'],
    default: 'local'
  },
  pdfGeneratedAt: {
    type: Date
  },
  
  // Agreement text snapshot (for record keeping)
  agreementText: {
    type: String
  },
  
  // Version tracking
  version: {
    type: Number,
    default: 1
  },
  
  // Supersedes previous agreement
  previousAgreement: {
    type: mongoose.Schema.ObjectId,
    ref: 'InstructorEarningsAgreement'
  },
  
  // Admin notes
  adminNotes: {
    type: String,
    maxlength: [5000, 'Admin notes cannot exceed 5000 characters']
  },
  
  // Active agreement flag
  isActive: {
    type: Boolean,
    default: false
  },
  
  // Expiration (optional, for future use)
  expiresAt: {
    type: Date
  },
  
  // Email notification tracking
  emailSentToInstructor: {
    type: Boolean,
    default: false
  },
  emailSentAt: {
    type: Date
  },
  
  // Created/updated by
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
instructorEarningsAgreementSchema.index({ instructor: 1, status: 1 });
instructorEarningsAgreementSchema.index({ instructor: 1, isActive: 1 });
instructorEarningsAgreementSchema.index({ status: 1, createdAt: -1 });

// Validation: percentages must sum to 100
instructorEarningsAgreementSchema.pre('save', function(next) {
  const total = this.platformPercentage + this.instructorPercentage;
  if (Math.abs(total - 100) > 0.01) {
    return next(new Error('Platform and instructor percentages must sum to 100%'));
  }
  next();
});

// Static method to get active agreement for an instructor
instructorEarningsAgreementSchema.statics.getActiveAgreement = async function(instructorId) {
  return this.findOne({ 
    instructor: instructorId, 
    isActive: true,
    status: 'approved'
  }).sort({ createdAt: -1 });
};

// Static method to get current earnings split for an instructor
instructorEarningsAgreementSchema.statics.getEarningsSplit = async function(instructorId) {
  const agreement = await this.getActiveAgreement(instructorId);
  
  if (agreement) {
    return {
      platformPercentage: agreement.platformPercentage,
      instructorPercentage: agreement.instructorPercentage,
      agreementType: agreement.agreementType,
      agreementId: agreement._id,
      agreementVersion: agreement.version || 1
    };
  }
  
  // Fallback to global settings
  const AdminSettings = require('./AdminSettings');
  const settings = await AdminSettings.getSettings();
  
  return {
    platformPercentage: settings.platformRevenuePercentage || 30,
    instructorPercentage: settings.instructorRevenuePercentage || 70,
    agreementType: 'global',
    agreementId: null,
    agreementVersion: 1
  };
};

// Static method to deactivate previous agreements when a new one is approved
instructorEarningsAgreementSchema.statics.deactivatePreviousAgreements = async function(instructorId, currentAgreementId) {
  await this.updateMany(
    { 
      instructor: instructorId,
      _id: { $ne: currentAgreementId },
      isActive: true
    },
    { 
      isActive: false,
      status: 'expired'
    }
  );
};

// Static method to get all pending agreements for admin
instructorEarningsAgreementSchema.statics.getPendingAgreements = async function() {
  return this.find({ status: 'pending' })
    .populate('instructor', 'name email phone profilePicture')
    .sort({ createdAt: 1 });
};

// Static method to get agreements by status
instructorEarningsAgreementSchema.statics.getAgreementsByStatus = async function(status) {
  return this.find({ status })
    .populate('instructor', 'name email phone profilePicture')
    .sort({ createdAt: -1 });
};

// Instance method to mark as approved
instructorEarningsAgreementSchema.methods.approve = async function(approverId) {
  this.status = 'approved';
  this.approvedAt = new Date();
  this.approvedByInstructor = true;
  this.isActive = true;
  this.updatedBy = approverId;
  
  // Deactivate previous agreements
  await this.constructor.deactivatePreviousAgreements(this.instructor, this._id);
  
  await this.save();
  return this;
};

// Instance method to mark as rejected
instructorEarningsAgreementSchema.methods.reject = async function(reason, rejectorId) {
  this.status = 'rejected';
  this.rejectionReason = reason;
  this.rejectedAt = new Date();
  this.isActive = false;
  this.updatedBy = rejectorId;
  
  await this.save();
  return this;
};

module.exports = mongoose.model('InstructorEarningsAgreement', instructorEarningsAgreementSchema);
