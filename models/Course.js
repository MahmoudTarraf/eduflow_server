const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Course name is required'],
    trim: true,
    maxlength: [100, 'Course name cannot be more than 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Course description is required'],
    maxlength: [1000, 'Description cannot be more than 1000 characters']
  },
  category: {
    type: String,
    required: [true, 'Course category is required']
    // Removed enum to allow dynamic categories
  },
  level: {
    type: String,
    required: [true, 'Course level is required'],
    trim: true
  },
  duration: {
    type: Number,
    required: [true, 'Course duration is required'],
    min: [1, 'Duration must be at least 1 week']
  },
  cost: {
    type: Number,
    required: [true, 'Course cost is required'],
    min: [0, 'Cost cannot be negative']
  },
  originalCost: {
    type: Number, // Stores original cost when discount is active
    default: null
  },
  currency: {
    type: String,
    default: 'SYP',
    enum: ['SYP', 'USD']
  },
  sections: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    price: {
      type: Number,
      required: true,
      min: [0, 'Section price cannot be negative']
    },
    order: {
      type: Number,
      required: true
    },
    lectures: [{
      type: mongoose.Schema.ObjectId,
      ref: 'lectures'
    }],
    assignments: [{
      type: mongoose.Schema.ObjectId,
      ref: 'assignments'
    }],
    isPublished: {
      type: Boolean,
      default: false
    }
  }],
  image: {
    type: String,
    default: ''
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Course must have an instructor']
  },
  groups: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Group'
  }],
  lectures: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    type: {
      type: String,
      enum: ['video', 'pdf'],
      required: true
    },
    fileUrl: {
      type: String,
      required: true
    },
    duration: Number, // in minutes for videos
    order: {
      type: Number,
      required: true
    },
    isPublished: {
      type: Boolean,
      default: false
    }
  }],
  assignments: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    fileUrl: String, // PDF or RAR file
    dueDate: Date,
    maxScore: {
      type: Number,
      default: 100
    },
    order: {
      type: Number,
      required: true
    },
    isPublished: {
      type: Boolean,
      default: false
    }
  }],
  projects: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    videos: [String], // Array of video URLs
    files: [String], // Array of file URLs
    maxScore: {
      type: Number,
      default: 100
    },
    order: {
      type: Number,
      required: true
    },
    isPublished: {
      type: Boolean,
      default: false
    }
  }],
  certificate: {
    template: String, // Certificate template URL
    isAvailable: {
      type: Boolean,
      default: false
    }
  },
  offersCertificate: {
    type: Boolean,
    default: true // Default to true to maintain backward compatibility
  },
  certificateMode: {
    type: String,
    enum: ['automatic', 'manual_instructor', 'disabled'],
    default: 'manual_instructor'
  },
  instructorCertificateRelease: {
    type: Boolean,
    default: false
  },
  allowRatingAfterCompletion: {
    type: Boolean,
    default: true
  },
  // Points-to-Balance discount system
  allowPointsDiscount: {
    type: Boolean,
    default: true, // Allow by default for better user experience
    index: true // Index for faster queries
  },
  // Telegram group link for course discussions
  telegramGroupLink: {
    type: String,
    trim: true,
    default: '',
    validate: {
      validator: function(v) {
        // Allow empty string or valid Telegram link
        if (!v) return true;
        return /^https?:\/\/(t\.me|telegram\.me)\/[\w\d_]+$/i.test(v);
      },
      message: 'Please enter a valid Telegram group link (e.g., https://t.me/groupname)'
    }
  },
  // Discount system
  discount: {
    price: {
      type: Number,
      min: 0,
      default: 0
    },
    percentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    timerDays: {
      type: Number,
      default: 7,
      min: 1
    },
    startDate: Date,
    endDate: Date,
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired', 'disabled'],
      default: 'disabled'
    },
    reasonReject: String,
    requestedAt: Date,
    approvedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    approvedAt: Date
  },
  requirements: [String],
  whatYouWillLearn: [String],
  isPublished: {
    type: Boolean,
    default: false
  },
  averageRating: {
    type: Number,
    min: [0, 'Rating cannot be negative'],
    max: [5, 'Rating cannot be more than 5'],
    default: 0
  },
  totalRatings: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Archiving flags: archived courses are hidden from catalog and cannot accept new enrollments
  isArchived: {
    type: Boolean,
    default: false,
    index: true
  },
  archivedAt: {
    type: Date
  },
  archivedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  archivedReason: {
    type: String,
    maxlength: [500, 'Archive reason cannot exceed 500 characters']
  },
  // Course approval workflow
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'approved' // Default to approved for admin-created courses
  },
  approvedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  approvedAt: Date,
  rejectionReason: String,
  // Orphaned course tracking (when instructor is deleted but courses are kept)
  isOrphaned: {
    type: Boolean,
    default: false
  },
  originalInstructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User' // Reference to deleted instructor
  }
}, {
  timestamps: true
});

// Cascade delete middleware
courseSchema.pre('remove', async function(next) {
  try {
    const Section = require('./Section');
    const Content = require('./Content');
    const Enrollment = require('./Enrollment');
    const StudentContentGrade = require('./StudentContentGrade');
    const StudentSectionGrade = require('./StudentSectionGrade');
    const CourseGrade = require('./CourseGrade');
    const CertificateRequest = require('./CertificateRequest');
    const SectionPayment = require('./SectionPayment');
    const fs = require('fs').promises;
    const path = require('path');

    console.log(`Cascading delete for course: ${this._id}`);

    // Get all sections
    const sections = await Section.find({ course: this._id });
    const sectionIds = sections.map(s => s._id);

    // Get all content to delete files
    const contents = await Content.find({ course: this._id });
    
    // Delete video and file assets
    for (const content of contents) {
      try {
        // Delete video file
        if (content.video && content.video.path) {
          const videoPath = path.join(__dirname, '..', content.video.path);
          await fs.unlink(videoPath).catch(err => console.log('Video delete error:', err.message));
        }
        if (content.videoPath) {
          const videoPath = path.join(__dirname, '../uploads/videos', content.videoPath);
          await fs.unlink(videoPath).catch(err => console.log('Video delete error:', err.message));
        }
        
        // Delete file
        if (content.file && content.file.path) {
          const filePath = path.join(__dirname, '..', content.file.path);
          await fs.unlink(filePath).catch(err => console.log('File delete error:', err.message));
        }
        if (content.filePath) {
          const filePath = path.join(__dirname, '../uploads/files', content.filePath);
          await fs.unlink(filePath).catch(err => console.log('File delete error:', err.message));
        }
      } catch (fileError) {
        console.error('Error deleting content files:', fileError.message);
      }
    }

    // Delete all content
    await Content.deleteMany({ course: this._id });

    // Delete all sections
    await Section.deleteMany({ course: this._id });

    // Delete all enrollments
    await Enrollment.deleteMany({ course: this._id });

    // Delete all grades
    await StudentContentGrade.deleteMany({ course: this._id });
    await StudentSectionGrade.deleteMany({ course: this._id });
    await CourseGrade.deleteMany({ course: this._id });

    // Delete certificate requests
    await CertificateRequest.deleteMany({ course: this._id });

    // Delete payments
    await SectionPayment.deleteMany({ course: this._id });

    console.log(`Successfully cascaded delete for course: ${this._id}`);
    next();
  } catch (error) {
    console.error('Cascade delete error:', error);
    next(error);
  }
});

// Handle both deleteOne and findOneAndDelete
courseSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
  try {
    console.log('deleteOne hook triggered for course:', this._id);
    
    // Get groups associated with this course
    const Group = require('./Group');
    const groups = await Group.find({ course: this._id });
    console.log(`Found ${groups.length} groups to delete`);
    
    // Delete all groups (will trigger their cascade deletes)
    for (const group of groups) {
      await group.deleteOne();
    }
    
    // Delete all related data
    const Section = require('./Section');
    const Content = require('./Content');
    const Enrollment = require('./Enrollment');
    const StudentProgress = require('./StudentProgress');
    const StudentContentGrade = require('./StudentContentGrade');
    const StudentSectionGrade = require('./StudentSectionGrade');
    const CourseGrade = require('./CourseGrade');
    const CertificateRequest = require('./CertificateRequest');
    const SectionPayment = require('./SectionPayment');
    
    await Section.deleteMany({ course: this._id });
    await Content.deleteMany({ course: this._id });
    await Enrollment.deleteMany({ course: this._id });
    await StudentProgress.deleteMany({ course: this._id });
    await StudentContentGrade.deleteMany({ course: this._id });
    await StudentSectionGrade.deleteMany({ course: this._id });
    await CourseGrade.deleteMany({ course: this._id });
    await CertificateRequest.deleteMany({ course: this._id });
    await SectionPayment.deleteMany({ course: this._id });
    
    next();
  } catch (error) {
    console.error('deleteOne cascade error:', error);
    next(error);
  }
});

module.exports = mongoose.model('Course', courseSchema);
