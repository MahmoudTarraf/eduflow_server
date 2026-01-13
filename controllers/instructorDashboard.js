const Course = require('../models/Course');
const CertificateRequest = require('../models/CertificateRequest');
const StudentContentGrade = require('../models/StudentContentGrade');
const InstructorEarning = require('../models/InstructorEarning');
const InstructorPayoutRequest = require('../models/InstructorPayoutRequest');
const AdminSettings = require('../models/AdminSettings');

// Helper: compute all pending counters used by the instructor pending strip
async function getInstructorPendingSummaryCounts(instructorId) {
  // Find this instructor's courses
  const courses = await Course.find({ instructor: instructorId }).select('_id');
  const courseIds = courses.map((c) => c._id);

  if (courseIds.length === 0) {
    const settings = await AdminSettings.getSettings();
    const minimumPayoutSYP = settings.minimumPayoutAmountSYP || 10000;

    return {
      pendingCertificates: 0,
      pendingAssignments: 0,
      canRequestPayout: false,
      availableAmountSYP: 0,
      minimumPayoutSYP,
      discounts: []
    };
  }

  const now = new Date();

  const [
    pendingCertificates,
    pendingAssignments,
    pendingReuploads,
    earningsSummary,
    pendingPayouts,
    approvedPayouts,
    adminSettings,
    discountedCourses
  ] = await Promise.all([
    CertificateRequest.countDocuments({
      course: { $in: courseIds },
      status: 'requested'
    }),
    StudentContentGrade.countDocuments({
      course: { $in: courseIds },
      status: 'submitted_ungraded'
    }),
    StudentContentGrade.countDocuments({
      course: { $in: courseIds },
      reuploadRequested: true,
      reuploadStatus: 'pending'
    }),
    InstructorEarning.getSummary(instructorId),
    InstructorPayoutRequest.find({ instructor: instructorId, status: 'pending' }).select('requestedAmount'),
    InstructorPayoutRequest.find({ instructor: instructorId, status: 'approved' }).select('requestedAmount'),
    AdminSettings.getSettings(),
    Course.find({
      _id: { $in: courseIds },
      'discount.status': 'approved',
      'discount.endDate': { $gt: now }
    }).select('name discount')
  ]);

  // Compute available earnings (in smallest currency unit, e.g. cents)
  const totalEarningsAmount = earningsSummary.accrued?.amount || 0;
  const pendingAmount = pendingPayouts.reduce((sum, p) => sum + (p.requestedAmount || 0), 0);
  const paidAmount = approvedPayouts.reduce((sum, p) => sum + (p.requestedAmount || 0), 0);
  const availableAmount = totalEarningsAmount - pendingAmount - paidAmount;

  const minimumPayoutSYP = adminSettings.minimumPayoutAmountSYP || 10000;
  const minimumPayoutCents = minimumPayoutSYP * 100;

  const canRequestPayout = availableAmount >= minimumPayoutCents;
  const availableAmountSYP = availableAmount > 0 ? Math.floor(availableAmount / 100) : 0;

  const discounts = discountedCourses.map((course) => {
    const end = course.discount?.endDate;
    return {
      courseId: course._id,
      courseName: course.name,
      percentage: course.discount?.percentage || 0,
      endsAt: end || null,
      remainingMs: end ? end.getTime() - now.getTime() : null
    };
  });

  return {
    pendingCertificates,
    pendingAssignments,
    pendingReuploads,
    canRequestPayout,
    availableAmountSYP,
    minimumPayoutSYP,
    discounts
  };
}

// @desc    Get instructor pending actions summary
// @route   GET /api/instructor/pending-summary
// @access  Private (Instructor)
exports.getPendingSummary = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const data = await getInstructorPendingSummaryCounts(instructorId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get instructor pending summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch instructor pending summary',
      error: error.message
    });
  }
};

// Emit Socket.IO update to a specific instructor with latest pending summary counts
// This can be called from other controllers when relevant entities change.
exports.emitInstructorPendingSummaryUpdate = async (io, instructorId) => {
  if (!io || !instructorId) return;
  try {
    const data = await getInstructorPendingSummaryCounts(instructorId);
    io.to(`user:${instructorId}`).emit('instructor.pending-updates', data);
  } catch (error) {
    console.error('Emit instructor pending summary update error:', error.message);
  }
};
