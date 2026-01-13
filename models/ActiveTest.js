const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  questionText: {
    type: String,
    required: [true, 'Question text is required'],
    trim: true,
    maxlength: [1000, 'Question text cannot exceed 1000 characters']
  },
  options: [{
    optionText: {
      type: String,
      required: true,
      trim: true,
      maxlength: [500, 'Option text cannot exceed 500 characters']
    },
    isCorrect: {
      type: Boolean,
      default: false
    }
  }],
  points: {
    type: Number,
    default: 1,
    min: [0, 'Points cannot be negative']
  },
  order: {
    type: Number,
    default: 0
  }
});

const activeTestSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Test title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters'],
    default: ''
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: [true, 'Test must belong to a section']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Test must belong to a course']
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: [true, 'Test must belong to a group']
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Test must have an instructor']
  },
  questions: [questionSchema],
  timeLimitMinutes: {
    type: Number,
    required: [true, 'Time limit is required'],
    min: [1, 'Time limit must be at least 1 minute'],
    max: [300, 'Time limit cannot exceed 300 minutes']
  },
  passingScore: {
    type: Number,
    default: 60,
    min: [0, 'Passing score cannot be negative'],
    max: [100, 'Passing score cannot exceed 100']
  },
  maxAttempts: {
    type: Number,
    default: 1,
    min: [1, 'Must allow at least 1 attempt']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  startDate: {
    type: Date,
    default: null
  },
  endDate: {
    type: Date,
    default: null
  },
  shuffleQuestions: {
    type: Boolean,
    default: false
  },
  shuffleOptions: {
    type: Boolean,
    default: false
  },
  showResultsImmediately: {
    type: Boolean,
    default: true
  },
  showCorrectAnswers: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
activeTestSchema.index({ section: 1, isActive: 1 });
activeTestSchema.index({ course: 1, group: 1 });
activeTestSchema.index({ instructor: 1 });

// Virtual for total points
activeTestSchema.virtual('totalPoints').get(function() {
  return this.questions.reduce((sum, q) => sum + (q.points || 1), 0);
});

// Ensure virtuals are included in JSON
activeTestSchema.set('toJSON', { virtuals: true });
activeTestSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ActiveTest', activeTestSchema);
