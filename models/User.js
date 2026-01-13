const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Fields that must only ever be present for instructor accounts
const INSTRUCTOR_ONLY_FIELDS = [
  'instructorStatus',
  'trustedInstructor',
  'expertise',
  'instructorPercentage',
  'instructorPayoutSettings',
  'instructorAgreementAccepted',
  'instructorVideoSubmitted',
  'isTrustedInstructor',
  'agreementPdfUrl',
  'trustedDevices',
  'twoFactorBackupCodes',
  'twoFactorEnabled',
  'paymentReceivers',
  'instructorSuspensionRestrictions'
];

function stripInstructorFieldsForNonInstructors(doc) {
  if (!doc || doc.role === 'instructor' || doc.role === 'admin') {
    return;
  }

  INSTRUCTOR_ONLY_FIELDS.forEach((field) => {
    if (typeof doc[field] !== 'undefined') {
      doc[field] = undefined;
    }
  });
}

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [50, 'Name cannot be more than 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    trim: true
  },
  emailChangeCount: {
    type: Number,
    default: 0,
    min: 0
  },
  phoneChangeCount: {
    type: Number,
    default: 0,
    min: 0
  },
  country: {
    type: String,
    trim: true,
    maxlength: [20, 'Country cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'Country can only contain letters and spaces']
  },
  city: {
    type: String,
    trim: true,
    maxlength: [20, 'City cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'City can only contain letters and spaces']
  },
  school: {
    type: String,
    trim: true,
    maxlength: [20, 'School/University name cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'School/University can only contain letters and spaces']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters']
  },
  role: {
    type: String,
    enum: ['student', 'instructor', 'admin'],
    default: 'student'
  },
  instructorStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'approved'
  },
  trustedInstructor: {
    type: Boolean,
    default: false,
    index: true
  },
  avatar: {
    type: String,
    default: ''
  },
  bio: {
    type: String,
    maxlength: [2000, 'Bio cannot exceed 2000 characters'],
    default: ''
  },
  aboutMe: {
    type: String,
    maxlength: [5000, 'About Me cannot exceed 5000 characters'],
    default: ''
  },
  jobRole: {
    type: String,
    maxlength: [100, 'Job Role cannot exceed 100 characters'],
    default: ''
  },
  expertise: [{
    type: String,
    trim: true
  }],
  socialLinks: {
    linkedin: String,
    github: String,
    twitter: String,
    website: String
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  agreementPdfUrl: {
    type: String,
    default: ''
  },
  emailVerificationToken: String,
  verificationResendCount: { type: Number, default: 0 },
  verificationResendWindowStart: Date,
  verificationResendBlockedUntil: Date,
  resetPasswordToken: String,
  resetPasswordOTP: String,
  resetPasswordExpire: Date,
  enrolledCourses: [{
    course: {
      type: mongoose.Schema.ObjectId,
      ref: 'Course'
    },
    group: {
      type: mongoose.Schema.ObjectId,
      ref: 'Group'
    },
    status: {
      type: String,
      enum: ['pending', 'enrolled', 'completed'],
      default: 'pending'
    },
    enrollmentDate: {
      type: Date,
      default: Date.now
    },
    progress: {
      lectures: {
        type: Number,
        default: 0
      },
      assignments: {
        type: Number,
        default: 0
      },
      projects: {
        type: Number,
        default: 0
      }
    }
  }],
  preferences: {
    language: {
      type: String,
      enum: ['en', 'ar'],
      default: 'en'
    },
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    },
    enablePendingActionsAnimations: {
      type: Boolean,
      default: true
    }
  },
  paymentReceivers: [{
    providerKey: {
      type: String,
      trim: true
    },
    paymentMethod: {
      type: String,
      trim: true
    },
    receiverName: String,
    receiverEmail: {
      type: String,
      trim: true,
      default: ''
    },
    receiverPhone: String,
    receiverLocation: String,
    accountDetails: String,
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  notifications: [{
    message: String,
    type: {
      type: String,
      enum: ['info', 'success', 'warning', 'error']
    },
    read: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Aggregated instructor rating
  ratingValue: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  ratingCount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Student wishlist (saved courses)
  wishlist: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Course'
  }],
  
  // Gamification (Students only)
  gamification: {
    points: {
      type: Number,
      default: 0,
      min: 0
    },
    badges: [{
      type: String // Badge IDs or titles
    }],
    title: {
      type: String,
      default: ''
    },
    streakDays: {
      type: Number,
      default: 0,
      min: 0
    },
    lastShownStreak: {
      type: Number,
      default: 0,
      min: 0
    },
    lastLogin: {
      type: Date
    },
    // Balance tracking for Points-to-Balance system
    walletBalance: {
      type: Number,
      default: 0,
      min: 0, // Balance in SYP cents (e.g., 1000000 = 10,000 SYP)
      index: true
    },
    lockedBalance: {
      type: Number,
      default: 0,
      min: 0 // Temporarily locked balance during payment processing
    },
    totalBalanceUsed: {
      type: Number,
      default: 0,
      min: 0 // Total balance used in all payments (for analytics)
    },
    // Activity counters
    lessonsCompleted: {
      type: Number,
      default: 0
    },
    quizzesCompleted: {
      type: Number,
      default: 0
    },
    coursesCompleted: {
      type: Number,
      default: 0
    }
  },
  
  // Instructor payment settings
  instructorPercentage: {
    type: Number,
    default: 80,
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  instructorPayoutSettings: {
    minimumPayout: {
      type: Number,
      default: 1000, // $10 in cents
      min: [0, 'Minimum payout cannot be negative']
    },
    preferredPaymentMethod: {
      type: String,
      trim: true
    },
    receiverDetails: [{
      providerKey: {
        type: String,
        trim: true
      },
      paymentMethod: {
        type: String,
        required: true,
        trim: true
      },
      receiverName: {
        type: String,
        required: true,
        trim: true,
        maxlength: [100, 'Receiver name cannot exceed 100 characters']
      },
      receiverEmail: {
        type: String,
        trim: true,
        default: ''
      },
      receiverPhone: {
        type: String,
        required: true,
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
      },
      isDefault: {
        type: Boolean,
        default: false
      }
    }]
  },
  instructorAgreementAccepted: {
    type: Boolean,
    default: false
  },
  instructorVideoSubmitted: {
    type: Boolean,
    default: false
  },
  isTrustedInstructor: {
    type: Boolean,
    default: false
  },
  trustedAt: {
    type: Date
  },
  trustedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  isBanned: {
    type: Boolean,
    default: false
  },
  bannedAt: {
    type: Date
  },
  isSuspended: {
    type: Boolean,
    default: false,
    index: true
  },
  suspendedAt: {
    type: Date
  },
  suspendedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  suspensionReason: {
    type: String,
    maxlength: [500, 'Suspension reason cannot exceed 500 characters']
  },
  // Fine-grained suspension restrictions for students
  suspensionRestrictions: {
    enrollNewCourses: { type: Boolean, default: false },
    continueCourses: { type: Boolean, default: false },
    accessCoursePages: { type: Boolean, default: false },
    requestCertificate: { type: Boolean, default: false },
    changeProfile: { type: Boolean, default: false },
    changeSettings: { type: Boolean, default: false },
    dashboardAccess: { type: Boolean, default: false }
  },
  // Fine-grained suspension restrictions for instructors
  instructorSuspensionRestrictions: {
    createEditDeleteLectures: { type: Boolean, default: false },
    createEditDeleteAssignments: { type: Boolean, default: false },
    manageActiveTests: { type: Boolean, default: false },
    manageGroupsSections: { type: Boolean, default: false },
    createEditDeleteCourses: { type: Boolean, default: false },
    createDisableDiscounts: { type: Boolean, default: false },
    removeStudents: { type: Boolean, default: false },
    gradeAssignments: { type: Boolean, default: false },
    issueCertificates: { type: Boolean, default: false },
    requestPayout: { type: Boolean, default: false }
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'banned', 'deleted'],
    default: 'active',
    index: true
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date
  },
  deletedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  deletedReason: {
    type: String,
    maxlength: [500, 'Delete reason cannot exceed 500 characters']
  },
  deletedEmail: {
    type: String
  },
  // 2FA (TOTP) and trusted devices for admin/instructor
  twoFactorEnabled: {
    type: Boolean,
    default: false
  },
  twoFactorSecret: {
    type: String
  },
  twoFactorBackupCodes: [String],
  trustedDevices: [{
    tokenHash: String,
    expiresAt: Date,
    deviceName: String,
    createdAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Ensure instructor-only fields are never persisted for non-instructor roles
userSchema.pre('save', function(next) {
  try {
    stripInstructorFieldsForNonInstructors(this);
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.statics.findActiveByEmail = function(email) {
  if (!email) {
    return this.findOne({ _id: null });
  }
  return this.findOne({
    email,
    isDeleted: { $ne: true },
    status: { $ne: 'deleted' }
  });
};

// Encrypt password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  // If password already appears to be a bcrypt hash, skip re-hashing
  const alreadyHashed = typeof this.password === 'string' && this.password.startsWith('$2');
  if (alreadyHashed) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Strip instructor-only fields when updating non-instructor users via findOneAndUpdate / findByIdAndUpdate
userSchema.pre('findOneAndUpdate', async function(next) {
  try {
    const update = this.getUpdate() || {};

    // Determine the target role after this update
    let targetRole = update.role || (update.$set && update.$set.role);
    if (!targetRole) {
      const current = await this.model.findOne(this.getQuery()).select('role').lean();
      targetRole = current && current.role;
    }

    if (targetRole && targetRole !== 'instructor' && targetRole !== 'admin') {
      const modifiedUpdate = { ...update };
      const unset = modifiedUpdate.$unset || {};

      INSTRUCTOR_ONLY_FIELDS.forEach((field) => {
        // Remove any attempts to set these fields
        if (Object.prototype.hasOwnProperty.call(modifiedUpdate, field)) {
          delete modifiedUpdate[field];
        }
        if (modifiedUpdate.$set && Object.prototype.hasOwnProperty.call(modifiedUpdate.$set, field)) {
          delete modifiedUpdate.$set[field];
        }
        // Ensure they are unset on the document
        unset[field] = 1;
      });

      modifiedUpdate.$unset = unset;
      this.setUpdate(modifiedUpdate);
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Match password
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
