const mongoose = require('mongoose');

const adminEarningSchema = new mongoose.Schema({
  // Transaction reference
  sectionPayment: {
    type: mongoose.Schema.ObjectId,
    ref: 'SectionPayment',
    required: [true, 'Section payment reference is required'],
    unique: true,
    index: true
  },
  
  // Related entities
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Student is required']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Course is required'],
    index: true
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: [true, 'Section is required']
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Instructor is required'],
    index: true
  },
  
  // Financial details
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  currency: {
    type: String,
    required: true,
    default: 'USD',
    enum: ['USD', 'SYP', 'SYR', 'EUR']
  },
  instructorPercentage: {
    type: Number,
    required: [true, 'Instructor percentage is required'],
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  adminCommissionPercentage: {
    type: Number,
    required: [true, 'Admin commission percentage is required'],
    min: [0, 'Percentage cannot be negative'],
    max: [100, 'Percentage cannot exceed 100']
  },
  adminEarningAmount: {
    type: Number,
    required: [true, 'Admin earning amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  instructorEarningAmount: {
    type: Number,
    required: [true, 'Instructor earning amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  
  // Payment info
  paymentMethod: {
    type: String,
    trim: true
  },
  transactionDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Metadata
  notes: {
    type: String,
    maxlength: [1000, 'Notes cannot exceed 1000 characters']
  }
}, {
  timestamps: true
});

// Indexes for reporting queries
adminEarningSchema.index({ transactionDate: -1 });
adminEarningSchema.index({ course: 1, instructor: 1 });
adminEarningSchema.index({ instructor: 1, transactionDate: -1 });

// Validation: Ensure percentages add up to 100
adminEarningSchema.pre('save', function(next) {
  const totalPercentage = this.instructorPercentage + this.adminCommissionPercentage;
  if (Math.abs(totalPercentage - 100) > 0.01) { // Allow small floating point errors
    return next(new Error('Instructor and admin percentages must add up to 100'));
  }
  next();
});

// Validation: Ensure amounts match calculations
adminEarningSchema.pre('save', function(next) {
  const totalCalculated = this.adminEarningAmount + this.instructorEarningAmount;
  if (Math.abs(totalCalculated - this.totalAmount) > 1) { // Allow 1 cent difference due to rounding
    return next(new Error('Admin and instructor amounts must add up to total amount'));
  }
  next();
});

// Static method to get total admin earnings
adminEarningSchema.statics.getTotalEarnings = async function(filters = {}) {
  const matchStage = { ...filters };
  
  const result = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalEarnings: { $sum: '$adminEarningAmount' },
        transactionCount: { $sum: 1 }
      }
    }
  ]);
  
  return result.length > 0 ? result[0] : { totalEarnings: 0, transactionCount: 0 };
};

// Static method to get earnings breakdown by course
adminEarningSchema.statics.getEarningsByCourse = async function(filters = {}) {
  return this.aggregate([
    { $match: filters },
    {
      $group: {
        _id: '$course',
        totalEarnings: { $sum: '$adminEarningAmount' },
        totalRevenue: { $sum: '$totalAmount' },
        transactionCount: { $sum: 1 }
      }
    },
    {
      $lookup: {
        from: 'courses',
        localField: '_id',
        foreignField: '_id',
        as: 'courseInfo'
      }
    },
    {
      $unwind: '$courseInfo'
    },
    {
      $project: {
        courseName: '$courseInfo.name',
        totalEarnings: 1,
        totalRevenue: 1,
        transactionCount: 1
      }
    },
    { $sort: { totalEarnings: -1 } }
  ]);
};

// Static method to get earnings breakdown by instructor
adminEarningSchema.statics.getEarningsByInstructor = async function(filters = {}) {
  return this.aggregate([
    { $match: filters },
    {
      $group: {
        _id: '$instructor',
        totalAdminEarnings: { $sum: '$adminEarningAmount' },
        totalInstructorEarnings: { $sum: '$instructorEarningAmount' },
        totalRevenue: { $sum: '$totalAmount' },
        transactionCount: { $sum: 1 }
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'instructorInfo'
      }
    },
    {
      $unwind: '$instructorInfo'
    },
    {
      $project: {
        instructorName: '$instructorInfo.name',
        instructorEmail: '$instructorInfo.email',
        instructorStatus: '$instructorInfo.status',
        isDeleted: '$instructorInfo.isDeleted',
        totalAdminEarnings: 1,
        totalInstructorEarnings: 1,
        totalRevenue: 1,
        transactionCount: 1
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);
};

module.exports = mongoose.model('AdminEarning', adminEarningSchema);
