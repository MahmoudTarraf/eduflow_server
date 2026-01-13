const mongoose = require('mongoose');

const courseGradeSchema = new mongoose.Schema({
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
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group'
  },
  
  // Overall course grade
  overallGrade: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    min: 0,
    max: 100,
    get: (value) => (value ? parseFloat(value.toString()) : 0),
    set: (value) => {
      const num = parseFloat(value);
      return Math.min(100, Math.max(0, isNaN(num) ? 0 : num));
    }
  },
  
  // Section statistics
  sectionsCount: {
    type: Number,
    default: 0
  },
  sectionsCompleted: {
    type: Number,
    default: 0
  },
  
  // Content statistics
  lecturesTotal: {
    type: Number,
    default: 0
  },
  lecturesCompleted: {
    type: Number,
    default: 0
  },
  lecturesGrade: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    get: (value) => (value ? parseFloat(value.toString()) : 0)
  },
  
  assignmentsTotal: {
    type: Number,
    default: 0
  },
  assignmentsCompleted: {
    type: Number,
    default: 0
  },
  assignmentsGrade: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    get: (value) => (value ? parseFloat(value.toString()) : 0)
  },
  
  projectsTotal: {
    type: Number,
    default: 0
  },
  projectsCompleted: {
    type: Number,
    default: 0
  },
  projectsGrade: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    get: (value) => (value ? parseFloat(value.toString()) : 0)
  },
  
  // Completion status
  isComplete: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  },
  
  // Last calculation timestamp
  lastCalculated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true }
});

// Indexes for efficient queries
courseGradeSchema.index({ student: 1, course: 1 }, { unique: true });
courseGradeSchema.index({ course: 1, overallGrade: -1 });
courseGradeSchema.index({ student: 1, isComplete: 1 });
courseGradeSchema.index({ group: 1 });

// Update lastCalculated before saving
courseGradeSchema.pre('save', function(next) {
  this.lastCalculated = new Date();
  
  // Determine if course is complete
  if (this.sectionsCount > 0 && this.sectionsCompleted >= this.sectionsCount) {
    if (!this.isComplete) {
      this.isComplete = true;
      this.completedAt = new Date();
    }
  } else {
    this.isComplete = false;
    this.completedAt = null;
  }
  
  next();
});

// Virtual for completion percentage
courseGradeSchema.virtual('completionPercentage').get(function() {
  if (this.sectionsCount === 0) return 0;
  return Math.round((this.sectionsCompleted / this.sectionsCount) * 100);
});

// Method to check if student can request certificate
courseGradeSchema.methods.canRequestCertificate = function(passingGrade = 60) {
  return this.isComplete && this.overallGrade >= passingGrade;
};

module.exports = mongoose.model('CourseGrade', courseGradeSchema);
