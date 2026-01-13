const mongoose = require('mongoose');

const instructorAgreementSchema = new mongoose.Schema({
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Instructor is required'],
    unique: true,
    index: true
  },
  
  // Agreement details
  agreedToTerms: {
    type: Boolean,
    required: [true, 'Must agree to terms'],
    validate: {
      validator: function(v) {
        return v === true;
      },
      message: 'Must accept terms to proceed'
    }
  },
  instructorPercentage: {
    type: Number,
    required: true,
    default: 80,
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  agreementText: {
    type: String,
    required: [true, 'Agreement text snapshot is required']
  },
  agreementVersion: {
    type: String,
    default: 'v1.0'
  },
  agreedAt: {
    type: Date,
    default: Date.now
  },
  
  // Introduction video
  introductionVideo: {
    originalName: {
      type: String,
      required: [true, 'Video original name is required']
    },
    storageType: {
      type: String,
      enum: ['local', 'youtube'],
      default: 'local'
    },
    storedName: {
      type: String,
      required: [true, 'Video stored name is required'],
      unique: true
    },
    url: {
      type: String,
      required: [true, 'Video URL is required']
    },
    youtubeVideoId: {
      type: String,
      default: null
    },
    youtubeUrl: {
      type: String,
      default: null
    },
    mimeType: {
      type: String,
      required: true
    },
    size: {
      type: Number,
      required: true,
      max: [524288000, 'Video size cannot exceed 500MB'] // 500MB in bytes
    },
    duration: {
      type: Number, // in seconds
      min: [240, 'Video must be at least 4 minutes'],
      max: [360, 'Video cannot exceed 6 minutes']
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    thumbnailUrl: String
  },
  
  // Approval status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    maxlength: [2000, 'Rejection reason cannot exceed 2000 characters']
  },
  allowResubmission: {
    type: Boolean,
    default: true
  },
  reuploadAttempts: {
    type: Number,
    default: 0,
    min: 0
  },
  // Archive flag for audit continuity (do not delete)
  archived: {
    type: Boolean,
    default: false,
    index: true
  },
  archivedAt: {
    type: Date,
    default: null
  },
  
  // Processing
  submittedAt: {
    type: Date,
    default: Date.now
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Admin notes
  adminNotes: {
    type: String,
    maxlength: [5000, 'Admin notes cannot exceed 5000 characters']
  }
}, {
  timestamps: true
});

// Index for admin review queue
instructorAgreementSchema.index({ status: 1, submittedAt: -1 });
instructorAgreementSchema.index({ archived: 1, updatedAt: -1 });

// Validation: Cannot resubmit if rejected and resubmission not allowed
instructorAgreementSchema.pre('save', function(next) {
  if (this.status === 'rejected' && !this.allowResubmission && this.isModified('introductionVideo')) {
    return next(new Error('Resubmission not allowed for this rejection'));
  }
  next();
});

// Static method to check if instructor has pending or approved agreement
instructorAgreementSchema.statics.getInstructorAgreementStatus = async function(instructorId) {
  const agreement = await this.findOne({ instructor: instructorId });
  if (!agreement) return 'not_submitted';
  return agreement.status;
};

// Static method to get all pending agreements for admin review
instructorAgreementSchema.statics.getPendingAgreements = async function() {
  return this.find({ status: 'pending' })
    .populate('instructor', 'name email phone')
    .sort({ submittedAt: 1 }); // Oldest first
};

module.exports = mongoose.model('InstructorAgreement', instructorAgreementSchema);
