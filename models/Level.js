const mongoose = require('mongoose');

const levelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Level name is required'],
    trim: true,
    unique: true,
    maxlength: [50, 'Level name cannot be more than 50 characters']
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    index: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: [200, 'Description cannot be more than 200 characters']
  },
  order: {
    type: Number,
    default: 0 // For ordering levels (e.g., beginner=1, intermediate=2, advanced=3)
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
  timestamps: true
});

// Pre-save middleware to generate slug from name
levelSchema.pre('save', function(next) {
  // Always generate slug if name exists and (slug doesn't exist or name was modified)
  if (this.name && (!this.slug || this.isModified('name'))) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/--+/g, '-') // Replace multiple hyphens with single
      .trim();
  }
  next();
});

module.exports = mongoose.model('Level', levelSchema);
