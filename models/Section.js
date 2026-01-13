const mongoose = require('mongoose');

const sectionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Section name is required'],
    trim: true,
    maxlength: [100, 'Section name cannot be more than 100 characters']
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: [true, 'Section must belong to a group']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Section must belong to a course']
  },
  isFree: {
    type: Boolean,
    default: false
  },
  // New pricing model: store smallest currency unit (e.g., cents)
  isPaid: {
    type: Boolean,
    default: false
  },
  priceCents: {
    type: Number,
    default: 0,
    min: [0, 'Price cannot be negative']
  },
  currency: {
    type: String,
    default: 'USD',
    maxlength: [10, 'Currency code too long']
  },
  // Legacy field kept for backward compatibility while migration completes
  priceSYR: {
    type: Number,
    default: 0,
    min: [0, 'Price cannot be negative']
  },
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual populate for content
sectionSchema.virtual('content', {
  ref: 'Content',
  localField: '_id',
  foreignField: 'section'
});

// Indexes
sectionSchema.index({ group: 1, order: 1 });
sectionSchema.index({ course: 1 });

sectionSchema.virtual('price').get(function() {
  if (typeof this.priceCents === 'number' && !Number.isNaN(this.priceCents)) {
    return this.priceCents / 100;
  }
  return 0;
});

sectionSchema.virtual('isUnlockedByDefault').get(function() {
  return this.isFree || !this.isPaid || this.priceCents === 0;
});

module.exports = mongoose.model('Section', sectionSchema);
