const mongoose = require('mongoose');

const policySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['privacy', 'terms'],
    required: true,
    unique: true
  },
  content: {
    type: String,
    default: ''
  },
  updatedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Policy', policySchema);
