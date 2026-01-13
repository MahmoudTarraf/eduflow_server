const mongoose = require('mongoose');

const payoutAuditLogSchema = new mongoose.Schema({
  // Context
  entityType: {
    type: String,
    enum: ['earning', 'payout_request', 'user_settings', 'agreement'],
    required: [true, 'Entity type is required'],
    index: true
  },
  entityId: {
    type: mongoose.Schema.ObjectId,
    required: [true, 'Entity ID is required'],
    index: true
  },
  
  // Action
  action: {
    type: String,
    enum: ['create', 'update', 'approve', 'reject', 'cancel', 'upload_proof', 'status_change', 'delete'],
    required: [true, 'Action is required'],
    index: true
  },
  actor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'Actor is required'],
    index: true
  },
  actorRole: {
    type: String,
    enum: ['admin', 'instructor', 'system'],
    required: true
  },
  
  // Details
  previousState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  newState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  changedFields: [{
    type: String
  }],
  
  // Metadata
  ipAddress: {
    type: String,
    trim: true
  },
  userAgent: {
    type: String,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    immutable: true,
    index: true
  },
  reason: {
    type: String,
    maxlength: [2000, 'Reason cannot exceed 2000 characters']
  }
}, {
  timestamps: false // We use timestamp field instead
});

// Compound indexes for efficient queries
payoutAuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
payoutAuditLogSchema.index({ actor: 1, timestamp: -1 });
payoutAuditLogSchema.index({ timestamp: -1 });

// Prevent any updates or deletes (immutable log)
payoutAuditLogSchema.pre('save', function(next) {
  if (!this.isNew) {
    return next(new Error('Audit logs cannot be modified'));
  }
  next();
});

payoutAuditLogSchema.pre('remove', function(next) {
  next(new Error('Audit logs cannot be deleted'));
});

payoutAuditLogSchema.pre('deleteOne', function(next) {
  next(new Error('Audit logs cannot be deleted'));
});

payoutAuditLogSchema.pre('deleteMany', function(next) {
  next(new Error('Audit logs cannot be deleted'));
});

// Static method to log action
payoutAuditLogSchema.statics.logAction = async function(data) {
  try {
    const log = new this(data);
    await log.save();
    return log;
  } catch (error) {
    console.error('Failed to create audit log:', error);
    // Don't throw - audit logging should not break main functionality
    return null;
  }
};

// Static method to get audit trail for entity
payoutAuditLogSchema.statics.getAuditTrail = async function(entityType, entityId, limit = 50) {
  return this.find({
    entityType,
    entityId
  })
  .populate('actor', 'name email role')
  .sort({ timestamp: -1 })
  .limit(limit);
};

// Static method to get recent actions by user
payoutAuditLogSchema.statics.getUserActions = async function(userId, limit = 100) {
  return this.find({ actor: userId })
    .sort({ timestamp: -1 })
    .limit(limit);
};

// Static method for security analysis - detect suspicious patterns
payoutAuditLogSchema.statics.detectSuspiciousActivity = async function(instructorId, timeWindowHours = 24) {
  const cutoffTime = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000);
  
  const recentActions = await this.find({
    actor: instructorId,
    entityType: 'payout_request',
    action: 'create',
    timestamp: { $gte: cutoffTime }
  });
  
  // Flag if more than 3 payout requests in 24 hours
  if (recentActions.length > 3) {
    return {
      suspicious: true,
      reason: 'Multiple payout requests in short time',
      count: recentActions.length
    };
  }
  
  // Check for rapid requests from same IP
  const ipCounts = {};
  recentActions.forEach(action => {
    if (action.ipAddress) {
      ipCounts[action.ipAddress] = (ipCounts[action.ipAddress] || 0) + 1;
    }
  });
  
  const maxFromSingleIP = Math.max(...Object.values(ipCounts), 0);
  if (maxFromSingleIP > 2) {
    return {
      suspicious: true,
      reason: 'Multiple requests from same IP',
      count: maxFromSingleIP
    };
  }
  
  return { suspicious: false };
};

module.exports = mongoose.model('PayoutAuditLog', payoutAuditLogSchema);
