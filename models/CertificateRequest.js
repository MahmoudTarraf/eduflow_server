const mongoose = require('mongoose');

const certificateRequestSchema = new mongoose.Schema({
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
  status: {
    type: String,
    enum: ['requested', 'issued', 'rejected'],
    default: 'requested'
  },
  courseGrade: {
    type: mongoose.Schema.Types.Decimal128,
    get: (value) => (value ? parseFloat(value.toString()) : 0),
    set: (value) => parseFloat(value) || 0
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  issuedAt: Date,
  issuedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  certificateFile: {
    originalName: String,
    storedName: String,
    url: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date
  },
  rejectionReason: String
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true }
});

// Indexes for efficient queries
certificateRequestSchema.index({ student: 1, course: 1 });
certificateRequestSchema.index({ status: 1, requestedAt: -1 });

module.exports = mongoose.model('CertificateRequest', certificateRequestSchema);
