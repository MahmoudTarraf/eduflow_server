const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const pendingRegistrationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, unique: true },
  phone: { type: String, trim: true },
  country: {
    type: String,
    trim: true,
    maxlength: [20, 'Country cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'Country can only contain letters and spaces']
  },
  city: {
    type: String,
    trim: true,
    maxlength: [20, 'City cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'City can only contain letters and spaces']
  },
  school: {
    type: String,
    trim: true,
    maxlength: [20, 'School/University name cannot exceed 20 characters'],
    match: [/^[\p{L}\s]+$/u, 'School/University can only contain letters and spaces']
  },
  password: { type: String, required: true },
  role: { type: String, enum: ['student', 'instructor'], required: true },
  emailVerificationToken: { type: String, required: true, index: true },
  verificationResendCount: { type: Number, default: 0 },
  verificationResendWindowStart: Date,
  verificationResendBlockedUntil: Date,
}, { timestamps: true });

// TTL: auto-delete pending registrations after 24 hours to save space
pendingRegistrationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

pendingRegistrationSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
