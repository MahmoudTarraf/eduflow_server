const mongoose = require('mongoose');

const instructorApplicationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return /^09\d{8}$/.test(v);
      },
      message: 'Phone must start with 09 and be exactly 10 digits'
    }
  },
  country: {
    type: String,
    required: true
  },
  expertise: [{
    type: String,
    required: true
  }],
  profilePhoto: {
    type: String,
    default: null
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: String,
  emailVerificationOTP: String,
  emailVerificationExpires: Date,
  status: {
    type: String,
    enum: ['pending_review', 'approved', 'rejected'],
    default: 'pending_review'
  },
  agreementPdfUrl: {
    type: String,
    default: null
  },
  agreementSignedAt: {
    type: Date,
    default: null
  },
  signature: {
    type: String,
    default: null
  },
  introVideoUrl: {
    type: String,
    default: null
  },
  registrationProgress: {
    type: Number,
    default: 1,
    min: 1,
    max: 5
  },
  rejectionReason: {
    type: String,
    default: null
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  lastOtpSentAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for faster queries
instructorApplicationSchema.index({ email: 1 });
instructorApplicationSchema.index({ status: 1 });
instructorApplicationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('InstructorApplication', instructorApplicationSchema);
