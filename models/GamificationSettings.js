const mongoose = require('mongoose');

const gamificationSettingsSchema = new mongoose.Schema({
  // Point rewards for activities
  lesson: { type: Number, default: 5, min: 0 },
  quiz: { type: Number, default: 10, min: 0 },
  course: { type: Number, default: 50, min: 0 },
  assignment: { type: Number, default: 8, min: 0 },
  project: { type: Number, default: 12, min: 0 },
  
  // Points-to-Balance conversion settings
  conversionSettings: {
    pointsRequired: { 
      type: Number, 
      default: 500, 
      min: 1,
      validate: {
        validator: function(v) {
          return Number.isInteger(v) && v > 0;
        },
        message: 'Points required must be a positive integer'
      }
    },
    sypValue: { 
      type: Number, 
      default: 10000, 
      min: 1,
      validate: {
        validator: function(v) {
          return Number.isInteger(v) && v > 0;
        },
        message: 'SYP value must be a positive integer'
      }
    },
    // Minimum points threshold for using balance in payments
    minimumPointsThreshold: {
      type: Number,
      default: 500, // Same as pointsRequired by default
      min: 0,
      validate: {
        validator: function(v) {
          return Number.isInteger(v) && v >= 0;
        },
        message: 'Minimum points threshold must be a non-negative integer'
      }
    },
    enableBalancePayments: {
      type: Boolean,
      default: true
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    },
    updatedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User'
    }
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('GamificationSettings', gamificationSettingsSchema);
