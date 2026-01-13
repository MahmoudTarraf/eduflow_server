const mongoose = require('mongoose');

const cloudinaryAssetSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  cloudinaryPublicId: {
    type: String,
    required: true,
    unique: true
  },
  cloudinaryUrl: {
    type: String,
    required: true
  },
  resourceType: {
    type: String,
    enum: ['image', 'video', 'raw', 'auto'],
    default: 'auto'
  },
  format: {
    type: String // pdf, jpg, png, zip, etc.
  },
  fileSize: {
    type: Number // in bytes
  },
  width: Number,
  height: Number,
  originalFilename: {
    type: String,
    required: true
  },
  mimeType: {
    type: String
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course'
  },
  section: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section'
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group'
  },
  content: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Content'
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster queries
cloudinaryAssetSchema.index({ uploadedBy: 1, course: 1 });
cloudinaryAssetSchema.index({ section: 1 });
cloudinaryAssetSchema.index({ cloudinaryPublicId: 1 });

module.exports = mongoose.model('CloudinaryAsset', cloudinaryAssetSchema);
