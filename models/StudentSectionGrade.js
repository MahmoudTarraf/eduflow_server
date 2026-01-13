const mongoose = require('mongoose');

const studentSectionGradeSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  section: {
    type: mongoose.Schema.ObjectId,
    ref: 'Section',
    required: true
  },
  gradePercent: {
    type: mongoose.Schema.Types.Decimal128,
    default: 0.0,
    get: (value) => (value ? parseFloat(value.toString()) : 0),
    set: (value) => parseFloat(value) || 0
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true }
});

studentSectionGradeSchema.index({ student: 1, section: 1 }, { unique: true });
studentSectionGradeSchema.index({ section: 1 });

module.exports = mongoose.model('StudentSectionGrade', studentSectionGradeSchema);
