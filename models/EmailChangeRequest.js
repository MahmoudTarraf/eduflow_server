const mongoose = require('mongoose');

const emailChangeRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  newEmail: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  verificationCode: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  },
  attemptCount: {
    type: Number,
    default: 0
  },
  lastSentAt: {
    type: Date
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('EmailChangeRequest', emailChangeRequestSchema);
