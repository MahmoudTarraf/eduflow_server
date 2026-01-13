const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Group name is required'],
    trim: true,
    maxlength: [50, 'Group name cannot be more than 50 characters']
  },
  content: [{
    type: {
      type: String,
      enum: ['video', 'assignment', 'project'],
      required: true
    },
    title: {
      type: String,
      required: [true, 'Content title is required']
    },
    description: {
      type: String,
      default: ''
    },
    sourceType: {
      type: String,
      enum: ['url', 'upload'],
      default: 'url'
    },
    url: {
      type: String,
      required: [true, 'Content URL is required']
    },
    priceFlag: {
      type: String,
      enum: ['free', 'paid'],
      default: 'paid'
    },
    price: {
      type: Number,
      default: 0,
      min: [0, 'Price cannot be negative']
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Group must belong to a course']
  },
  level: {
    type: String,
    required: [true, 'Group level is required'],
    enum: ['beginner', 'intermediate', 'advanced', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']
  },
  maxStudents: {
    type: Number,
    default: 30,
    min: [1, 'Group must have at least 1 student capacity']
  },
  capacity: {
    type: Number,
    default: 30,
    min: [1, 'Group must have at least 1 student capacity']
  },
  description: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  currentStudents: {
    type: Number,
    default: 0
  },
  startDate: {
    type: Date,
    required: [true, 'Group start date is required']
  },
  endDate: {
    type: Date,
    required: [true, 'Group end date is required']
  },
  schedule: {
    days: [{
      type: String,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    }],
    time: {
      start: String, // Format: "09:00"
      end: String    // Format: "11:00"
    }
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Group must have an instructor']
  },
  enrollmentFee: {
    type: Number,
    default: 0,
    min: [0, 'Enrollment fee cannot be negative']
  },
  entryFee: {
    type: Number,
    default: 0,
    min: [0, 'Entry fee cannot be negative']
  },
  entryFeePercentage: {
    type: Number,
    default: 10,
    min: [0, 'Entry fee percentage cannot be negative'],
    max: [100, 'Entry fee percentage cannot exceed 100']
  },
  paymentType: {
    type: String,
    enum: ['free', 'monthly', 'per_section'],
    default: 'free'
  },
  sections: [{
    sectionId: mongoose.Schema.ObjectId,
    title: String,
    price: Number,
    order: Number
  }],
  students: [{
    student: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    },
    enrollmentDate: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'enrolled', 'completed', 'dropped'],
      default: 'pending'
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending'
    },
    paymentMethod: {
      type: String,
      default: 'none'
    },
    receiptUrl: {
      type: String
    },
    entryFeePaid: {
      type: Boolean,
      default: false
    },
    entryFeeReceiptUrl: String,
    entryFeeVerifiedAt: Date,
    paymentHistory: [{
      month: String, // Format: "2025-10" for October 2025
      amount: Number,
      paidAt: Date,
      verifiedAt: Date,
      verifiedBy: {
        type: mongoose.Schema.ObjectId,
        ref: 'User'
      },
      receiptUrl: String,
      status: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending'
      }
    }],
    sectionPayments: [{
      sectionId: mongoose.Schema.ObjectId,
      sectionTitle: String,
      amount: Number,
      paidAt: Date,
      verifiedAt: Date,
      verifiedBy: {
        type: mongoose.Schema.ObjectId,
        ref: 'User'
      },
      receiptUrl: String,
      paymentMethod: {
        type: String,
        trim: true
      },
      status: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending'
      }
    }],
    progress: [{
      contentId: {
        type: mongoose.Schema.ObjectId,
        required: true
      },
      contentType: {
        type: String,
        enum: ['video', 'assignment', 'project']
      },
      completed: {
        type: Boolean,
        default: false
      },
      completedAt: Date,
      viewedAt: Date,
      submissionId: {
        type: mongoose.Schema.ObjectId,
        ref: 'Submission'
      },
      grade: {
        score: Number,
        feedback: String,
        gradedAt: Date
      }
    }],
    completionRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  isArchived: {
    type: Boolean,
    default: false
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
  }
}, {
  timestamps: true
});

// Update currentStudents count when students are added/removed
groupSchema.pre('save', function(next) {
  this.currentStudents = this.students.filter(s => s.status === 'enrolled').length;
  next();
});

// Cascade delete middleware
groupSchema.pre('remove', async function(next) {
  try {
    const Section = require('./Section');
    const Content = require('./Content');
    const Enrollment = require('./Enrollment');
    const StudentProgress = require('./StudentProgress');
    const StudentContentGrade = require('./StudentContentGrade');
    const SectionPayment = require('./SectionPayment');
    const fs = require('fs').promises;
    const path = require('path');

    console.log(`Cascading delete for group: ${this._id}`);

    // Get all sections in this group
    const sections = await Section.find({ group: this._id });
    
    // Get all content in this group to delete files
    const contents = await Content.find({ group: this._id });
    
    // Delete video and file assets
    for (const content of contents) {
      try {
        if (content.video && content.video.path) {
          const videoPath = path.join(__dirname, '..', content.video.path);
          await fs.unlink(videoPath).catch(err => console.log('Video delete error:', err.message));
        }
        if (content.videoPath) {
          const videoPath = path.join(__dirname, '../uploads/videos', content.videoPath);
          await fs.unlink(videoPath).catch(err => console.log('Video delete error:', err.message));
        }
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
    await Content.deleteMany({ group: this._id });

    // Delete all sections
    await Section.deleteMany({ group: this._id });

    // Delete enrollments for this group
    await Enrollment.deleteMany({ group: this._id });

    // Delete progress records
    await StudentProgress.deleteMany({ group: this._id });
    
    // Delete grades for this group
    await StudentContentGrade.deleteMany({ section: { $in: sections.map(s => s._id) } });

    // Delete section payments
    await SectionPayment.deleteMany({ group: this._id });

    console.log(`Successfully cascaded delete for group: ${this._id}`);
    next();
  } catch (error) {
    console.error('Group cascade delete error:', error);
    next(error);
  }
});

groupSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
  try {
    console.log(`Cascading delete for group: ${this._id}`);
    
    // Get all sections in this group
    const Section = require('./Section');
    const sections = await Section.find({ group: this._id });
    
    // Delete all sections and their content
    for (const section of sections) {
      await section.deleteOne();
    }
    
    // Remove group from course
    const Course = require('./Course');
    await Course.updateOne(
      { _id: this.course },
      { $pull: { groups: this._id } }
    );
    
    // Clean up enrollments
    const Enrollment = require('./Enrollment');
    await Enrollment.deleteMany({ group: this._id });
    
    // Clean up progress
    const StudentProgress = require('./StudentProgress');
    await StudentProgress.deleteMany({ group: this._id });
    
    // Clean up payments
    const SectionPayment = require('./SectionPayment');
    await SectionPayment.deleteMany({ group: this._id });
    
    console.log(`Successfully cascaded delete for group: ${this._id}`);
    next();
  } catch (error) {
    console.error('Group deleteOne cascade error:', error);
    next(error);
  }
});

module.exports = mongoose.model('Group', groupSchema);
