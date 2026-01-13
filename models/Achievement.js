const mongoose = require('mongoose');

const achievementSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  type: { type: String, enum: ['points', 'badge', 'title'], required: true },
  message: { type: String, default: '' },
  points: { type: Number, default: 0 },
  badgeTitle: { type: String, default: null },
  badgeIcon: { type: String, default: null },
  titleName: { type: String, default: null },
  titleIcon: { type: String, default: null },
  meta: { type: Object, default: {} }
}, { timestamps: true });

achievementSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model('Achievement', achievementSchema);
