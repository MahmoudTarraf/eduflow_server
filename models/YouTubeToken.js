const mongoose = require('mongoose');

const youtubeTokenSchema = new mongoose.Schema(
  {
    owner: {
      type: String,
      default: 'platform',
      unique: true,
      index: true
    },
    accessToken: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    refreshToken: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    expiryDate: {
      type: Number // Timestamp in milliseconds
    },
    tokenType: {
      type: String,
      default: 'Bearer'
    },
    scope: {
      type: String
    },
    channelId: {
      type: String
    },
    channelName: {
      type: String
    },
    connectedEmail: {
      type: String
    },
    connectedAt: {
      type: Date
    },
    connectionStatus: {
      type: String,
      enum: ['CONNECTED', 'DISCONNECTED', 'REAUTH_REQUIRED'],
      default: 'CONNECTED'
    },
    quotaDate: {
      type: String
    },
    quotaUsed: {
      type: Number,
      default: 0
    },
    lastUploadAt: {
      type: Date
    },
    lastUploadStatus: {
      type: String,
      enum: ['success', 'failed']
    },
    lastUploadError: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('YouTubeToken', youtubeTokenSchema);
