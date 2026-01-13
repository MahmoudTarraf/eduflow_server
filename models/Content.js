const mongoose = require('mongoose');

const contentSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Content title is required'],
    trim: true,
    maxlength: [200, 'Title cannot be more than 200 characters']
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  type: {
    type: String,
    enum: ['lecture', 'assignment', 'project'],
    required: [true, 'Content type is required']
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: [true, 'Content must belong to a section']
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group',
    required: [true, 'Content must belong to a group']
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: [true, 'Content must belong to a course']
  },
  // For videos (lectures and projects) - full metadata
  video: {
    // Local storage fields
    originalName: String,
    storedName: String,
    path: String,
    localPath: String, // Explicit local path
    mimeType: String,
    size: Number,
    duration: Number, // in seconds
    
    // Cloud storage fields
    youtubeUrl: String, // Full YouTube URL
    youtubeVideoId: String, // YouTube video ID (extracted from URL)
    cloudinaryUrl: String, // Cloudinary video URL
    cloudinaryPublicId: String, // Cloudinary public ID for management
    
    // Storage type indicator
    storageType: {
      type: String,
      enum: ['local', 'youtube', 'cloudinary'],
      default: 'local'
    },
    
    // Metadata
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  },
  // For files (assignments and projects) - full metadata
  file: {
    // Local storage fields
    originalName: String,
    storedName: String,
    path: String,
    localPath: String,
    mimeType: String,
    size: Number,
    
    // Cloud storage fields (Cloudinary)
    cloudinaryUrl: String,
    cloudinaryPublicId: String,
    
    // Telegram storage fields
    telegramFileId: String,
    telegramFileName: String,
    
    // Storage type
    storageType: {
      type: String,
      enum: ['local', 'cloudinary', 'telegram'],
      default: 'local'
    },
    
    // Metadata
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  },
  // Solution file for assignments/projects - shown only after grading
  solution: {
    // Local storage fields
    originalName: String,
    storedName: String,
    path: String,
    localPath: String,
    mimeType: String,
    size: Number,
    
    // Cloud storage fields (Cloudinary)
    cloudinaryUrl: String,
    cloudinaryPublicId: String,
    
    // Telegram storage fields
    telegramFileId: String,
    telegramFileName: String,
    
    // Storage type
    storageType: {
      type: String,
      enum: ['local', 'cloudinary', 'telegram'],
      default: 'local'
    },
    
    // Metadata
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  },
  // Legacy fields for backward compatibility
  videoPath: String,
  videoFileName: String,
  videoDuration: Number,
  filePath: String,
  fileName: String,
  fileSize: Number,
  starterFilePath: String,
  starterFileName: String,
  // Materials and useful links for students
  materials: [{
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [200, 'Material title cannot exceed 200 characters']
    },
    url: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Material description cannot exceed 500 characters']
    },
    type: {
      type: String,
      enum: ['link', 'document', 'video', 'other'],
      default: 'link'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  maxScore: {
    type: Number,
    default: 100
  },
  dueDate: {
    type: Date
  },
  order: {
    type: Number,
    default: 0
  },
  isPublished: {
    type: Boolean,
    default: true
  },
  deletionStatus: {
    type: String,
    enum: ['active', 'pending_deletion', 'deleted'],
    default: 'active',
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    default: null
  },
  version: {
    type: Number,
    default: 1
  },
  parentContent: {
    type: mongoose.Schema.ObjectId,
    ref: 'Content'
  },
  isLatestVersion: {
    type: Boolean,
    default: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes
contentSchema.index({ section: 1, order: 1 });
contentSchema.index({ group: 1, type: 1 });
contentSchema.index({ course: 1 });

// Virtual for full video URL
contentSchema.virtual('videoUrl').get(function() {
  if (this.videoPath) {
    return `/uploads/videos/${this.videoPath}`;
  }
  return '';
});

// Virtual for full file URL
contentSchema.virtual('fileUrl').get(function() {
  if (this.filePath) {
    return `/uploads/files/${this.filePath}`;
  }
  return '';
});

module.exports = mongoose.model('Content', contentSchema);
