const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: true
  },
  group: {
    type: mongoose.Schema.ObjectId,
    ref: 'Group'
  },
  enrolledSections: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Section'
  }],
  status: {
    type: String,
    enum: ['pending', 'approved', 'enrolled', 'completed', 'rejected'],
    default: 'enrolled'
  },
  enrolledAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
enrollmentSchema.index({ student: 1, group: 1 });

enrollmentSchema.methods.isSectionEnrolled = function(sectionId) {
  if (!sectionId) return false;
  return this.enrolledSections.some(
    (id) => id.toString() === sectionId.toString()
  );
};

module.exports = mongoose.model('Enrollment', enrollmentSchema);
