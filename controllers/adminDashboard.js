const InstructorPayoutRequest = require('../models/InstructorPayoutRequest');
const SectionPayment = require('../models/SectionPayment');
const DeleteRequest = require('../models/DeleteRequest');
const InstructorApplication = require('../models/InstructorApplication');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const AdminSettings = require('../models/AdminSettings');
const Course = require('../models/Course');

// Helper: compute all pending counters used by the admin pending strip
async function getPendingSummaryCounts() {
  const settings = await AdminSettings.getSettings();
  const rejectedAgreementsLastReadAt = settings?.rejectedAgreementsLastReadAt || null;

  const rejectedAgreementsQuery = {
    status: 'rejected'
  };

  if (rejectedAgreementsLastReadAt) {
    rejectedAgreementsQuery.rejectedAt = { $gt: rejectedAgreementsLastReadAt };
  }

  const [
    payouts,
    studentPayments,
    deleteRequests,
    applications,
    agreements,
    pendingCourses
  ] = await Promise.all([
    InstructorPayoutRequest.countDocuments({ status: 'pending' }),
    SectionPayment.countDocuments({ status: 'pending' }),
    DeleteRequest.countDocuments({ status: 'pending' }),
    InstructorApplication.countDocuments({ status: 'pending_review' }),
    InstructorEarningsAgreement.countDocuments(rejectedAgreementsQuery),
    Course.countDocuments({ approvalStatus: 'pending' })
  ]);

  return {
    payouts,
    studentPayments,
    deleteRequests,
    applications,
    agreements,
    pendingCourses,
    rejectedAgreementsLastReadAt
  };
}

// @desc    Get admin pending actions summary
// @route   GET /api/admin/pending-summary
// @access  Private (Admin)
exports.getPendingSummary = async (req, res) => {
  try {
    const data = await getPendingSummaryCounts();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get pending summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending summary',
      error: error.message
    });
  }
};

// Emit Socket.IO update to all admins with latest pending summary counts
// This is used by controllers whenever relevant entities change state.
exports.emitPendingSummaryUpdate = async (io) => {
  if (!io) return;
  try {
    const data = await getPendingSummaryCounts();
    // Use a dedicated event channel as requested: admin.pending-updates
    io.to('admin').emit('admin.pending-updates', data);
  } catch (error) {
    console.error('Emit pending summary update error:', error.message);
  }
};
