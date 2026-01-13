const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const InstructorAgreement = require('../models/InstructorAgreement');
const AdminSettings = require('../models/AdminSettings');
const User = require('../models/User');
const { generateAgreementPDF, deleteAgreementPDF } = require('../utils/pdfGenerator');
const { sendEmail } = require('../utils/sendEmail');
const { constructFileUrl } = require('../utils/urlHelper');

// Helper: create a new agreement for a specific instructor (PDF + DB + email)
const createAgreementForInstructor = async ({
  instructor,
  platformPercentage,
  instructorPercentage,
  agreementType = 'global',
  adminNotes,
  createdBy
}) => {
  const settings = await AdminSettings.getSettings();
  const platformName = settings.platformName || 'EduFlow Academy';
  // Use only the public-facing platform email from global settings.
  // Never fall back to internal admin emails or environment variables to avoid exposing them.
  const platformEmail = settings.platformEmail || '';
  const agreementText = settings.agreementText || '';

  const lastAgreement = await InstructorEarningsAgreement.findOne({ instructor: instructor._id })
    .sort({ version: -1, createdAt: -1 })
    .select('version status');

  const nextVersion = (lastAgreement?.version || 0) + 1;

  // If an admin sends a new agreement while a previous one is still pending,
  // expire the previous pending agreement(s). This keeps a single actionable
  // agreement for the instructor at a time.
  await InstructorEarningsAgreement.updateMany(
    {
      instructor: instructor._id,
      status: 'pending'
    },
    {
      status: 'expired',
      isActive: false,
      updatedBy: createdBy || null,
      expiresAt: new Date()
    }
  );

  const pdfResult = await generateAgreementPDF({
    instructorName: instructor.name,
    instructorEmail: instructor.email,
    instructorId: instructor._id.toString(),
    platformPercentage,
    instructorPercentage,
    agreementType,
    agreementVersion: String(nextVersion),
    platformName,
    platformEmail,
    platformSignerName: platformName,
    agreementText
  });

  const agreement = await InstructorEarningsAgreement.create({
    instructor: instructor._id,
    agreementType,
    platformPercentage,
    instructorPercentage,
    status: 'pending',
    agreementText,
    version: nextVersion,
    pdfUrl: pdfResult.pdfUrl,
    pdfPublicId: pdfResult.pdfPublicId,
    localPath: pdfResult.localPath,
    storage: pdfResult.storage,
    pdfGeneratedAt: new Date(),
    adminNotes: adminNotes || '',
    createdBy,
    previousAgreement: lastAgreement?._id || null
  });

  try {
    await sendEmail({
      email: instructor.email,
      subject: 'New Instructor Earnings Agreement',
      html:
        `<h2>New Earnings Agreement</h2>` +
        `<p>Dear ${instructor.name},</p>` +
        `<p>A new earnings agreement has been prepared for you on the ${platformName} platform.</p>` +
        `<p><strong>Your share:</strong> ${instructorPercentage}% &nbsp; | &nbsp; <strong>Platform share:</strong> ${platformPercentage}%</p>` +
        `<p>You can download and review the full agreement PDF here:</p>` +
        `<p><a href="${constructFileUrl(agreement.pdfUrl)}">Download Agreement PDF</a></p>` +
        `<p>Please log in to your instructor dashboard to approve or reject this agreement.</p>` +
        `<br/><p>Best regards,<br/>${platformName} Team</p>`
    });

    agreement.emailSentToInstructor = true;
    agreement.emailSentAt = new Date();
    await agreement.save();
  } catch (emailError) {
    console.error('Failed to send agreement email:', emailError.message);
  }

  return agreement;
};

// @desc    Get all earnings agreements (admin)
// @route   GET /api/instructor-agreements
// @access  Private (Admin)
exports.getAllAgreements = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (status && String(status).toLowerCase() !== 'all') {
      query.status = status;
    }

    const agreements = await InstructorEarningsAgreement.find(query)
      .populate('instructor', 'name email status isDeleted agreementPdfUrl')
      .sort({ createdAt: -1 });

    const data = agreements.map((a) => {
      const obj = a.toObject();

      let normalizedInstructor = null;
      if (obj.instructor && obj.instructor._id) {
        normalizedInstructor = {
          ...obj.instructor,
          agreementPdfUrl: constructFileUrl(obj.instructor.agreementPdfUrl)
        };
      } else if (obj.instructor) {
        const inferredId =
          typeof obj.instructor === 'string'
            ? obj.instructor
            : (typeof obj.instructor.toString === 'function' ? obj.instructor.toString() : String(obj.instructor));

        normalizedInstructor = {
          _id: inferredId,
          name: 'Unknown',
          email: '',
          status: 'deleted',
          isDeleted: true,
          agreementPdfUrl: null
        };
      }

      return {
        ...obj,
        pdfUrl: constructFileUrl(obj.pdfUrl),
        instructor: normalizedInstructor,
        isCustom: obj.agreementType === 'custom'
      };
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get all instructor agreements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch instructor agreements',
      error: error.message
    });
  }
};

// @desc    Get agreement stats for admin dashboard
// @route   GET /api/instructor-agreements/stats
// @access  Private (Admin)
exports.getAgreementStats = async (req, res) => {
  try {
    const [totalInstructors, counts, customCount] = await Promise.all([
      User.countDocuments({ role: 'instructor', isDeleted: { $ne: true }, status: { $ne: 'deleted' } }),
      InstructorEarningsAgreement.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      InstructorEarningsAgreement.countDocuments({ agreementType: 'custom' })
    ]);

    const stats = {
      totalInstructors,
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      customAgreements: customCount
    };

    counts.forEach((c) => {
      if (stats[c._id] !== undefined) {
        stats[c._id] = c.count;
      }
    });

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get instructor agreement stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agreement stats',
      error: error.message
    });
  }
};

// @desc    Get my earnings agreements (instructor)
// @route   GET /api/instructor-agreements/my-agreement
// @access  Private (Instructor)
exports.getMyAgreement = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const [agreements, currentSplit, approvedSignupAgreementDoc, latestSignupAgreementDoc, instructorUser] = await Promise.all([
      InstructorEarningsAgreement.find({ instructor: instructorId })
        .sort({ createdAt: -1 })
        .lean(),
      InstructorEarningsAgreement.getEarningsSplit(instructorId),
      InstructorAgreement.findOne({ instructor: instructorId, status: 'approved' })
        .sort({ reviewedAt: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      InstructorAgreement.findOne({ instructor: instructorId })
        .sort({ submittedAt: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      // Need full instructor context for on-demand agreement generation
      User.findById(instructorId).select('agreementPdfUrl createdAt name email role').lean()
    ]);

    const signupAgreementDoc = approvedSignupAgreementDoc || latestSignupAgreementDoc;

    // If the instructor has no earnings agreements yet, generate one on-the-fly
    // from current admin settings so the Agreements tab is never empty.
    let mutableAgreements = agreements;
    if (
      (!mutableAgreements || mutableAgreements.length === 0) &&
      !signupAgreementDoc &&
      !instructorUser?.agreementPdfUrl
    ) {
      try {
        const settings = await AdminSettings.getSettings();
        const instructor = await User.findById(instructorId).select('name email _id').lean();
        if (instructor) {
          const generated = await createAgreementForInstructor({
            instructor,
            platformPercentage: settings.platformRevenuePercentage ?? 30,
            instructorPercentage: settings.instructorRevenuePercentage ?? 70,
            agreementType: 'global',
            createdBy: null
          });
          mutableAgreements = [generated.toObject ? generated.toObject() : generated];
        }
      } catch (genErr) {
        console.error('Auto-generate instructor agreement failed:', genErr.message);
      }
    }

    // Ensure all agreement PDF URLs are absolute (works in dev/prod when client is a different origin)
    if (mutableAgreements && Array.isArray(mutableAgreements)) {
      mutableAgreements = mutableAgreements.map((agreement) => ({
        ...agreement,
        pdfUrl: constructFileUrl(agreement.pdfUrl)
      }));
    }

    if (mutableAgreements && Array.isArray(mutableAgreements) && mutableAgreements.length > 0) {
      const newestPending = mutableAgreements.find((a) => a && a.status === 'pending') || null;
      const activeApproved =
        mutableAgreements.find((a) => a && a.isActive && a.status === 'approved') ||
        mutableAgreements.find((a) => a && a.status === 'approved') ||
        null;

      if (newestPending || activeApproved) {
        const newestPendingId = newestPending?._id ? String(newestPending._id) : null;
        const approvedAnchorTime = activeApproved?.createdAt ? new Date(activeApproved.createdAt).getTime() : null;

        mutableAgreements = mutableAgreements.map((agreement) => {
          if (!agreement || agreement.status !== 'pending') return agreement;

          const agreementId = agreement._id ? String(agreement._id) : null;
          const createdTime = agreement.createdAt ? new Date(agreement.createdAt).getTime() : null;

          const isOlderPending = newestPendingId && agreementId && agreementId !== newestPendingId;
          const isBeforeApproved =
            Number.isFinite(approvedAnchorTime) && Number.isFinite(createdTime) && createdTime < approvedAnchorTime;

          if (isOlderPending || isBeforeApproved) {
            return {
              ...agreement,
              status: 'expired',
              isActive: false,
              expiresAt: agreement.expiresAt || new Date()
            };
          }

          return agreement;
        });
      }
    }

    const activeAgreement =
      (mutableAgreements || []).find((a) => a.isActive && a.status === 'approved') || null;

    let signupAgreement = null;
    if (signupAgreementDoc || instructorUser?.agreementPdfUrl) {
      const agreedAtFallback =
        signupAgreementDoc?.agreedAt ||
        signupAgreementDoc?.submittedAt ||
        instructorUser?.createdAt ||
        null;

      signupAgreement = {
        ...(signupAgreementDoc || {}),
        agreementPdfUrl: constructFileUrl(instructorUser?.agreementPdfUrl) || null,
        agreedAt: agreedAtFallback,
        status: signupAgreementDoc?.status || 'approved',
        reuploadAttempts: signupAgreementDoc?.reuploadAttempts || 0,
        introductionVideo: signupAgreementDoc?.introductionVideo || null
      };
    }

    const responseData = {
      signupAgreement,
      activeAgreement,
      recentAgreements: mutableAgreements || [],
      currentEarningsSplit: currentSplit || null
    };

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Get my agreements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch your agreements',
      error: error.message
    });
  }
};

// @desc    Update global earnings settings and send agreements
// @route   POST /api/instructor-agreements/update-global-settings
// @access  Private (Admin)
exports.updateGlobalSettings = async (req, res) => {
  try {
    const { platformPercentage, instructorPercentage, includeCustomInstructors } =
      req.body || {};

    const p = Number(platformPercentage);
    const i = Number(instructorPercentage);

    if (
      !Number.isFinite(p) ||
      !Number.isFinite(i) ||
      p < 0 ||
      i < 0 ||
      p + i !== 100
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Platform and instructor percentages must be valid numbers that sum to 100%'
      });
    }

    await AdminSettings.updateSettings(
      {
        platformRevenuePercentage: p,
        instructorRevenuePercentage: i
      },
      req.user && req.user.id
    );

    const instructorQuery = {
      role: 'instructor',
      isDeleted: { $ne: true },
      status: { $ne: 'deleted' }
    };

    if (!includeCustomInstructors) {
      const customIds = await InstructorEarningsAgreement.distinct('instructor', {
        agreementType: 'custom'
      });
      if (customIds && customIds.length > 0) {
        instructorQuery._id = { $nin: customIds };
      }
    }

    const instructors = await User.find(instructorQuery).select('name email');

    let successCount = 0;
    for (const instructor of instructors) {
      try {
        await createAgreementForInstructor({
          instructor,
          platformPercentage: p,
          instructorPercentage: i,
          agreementType: 'global',
          createdBy: req.user && req.user.id
        });
        successCount += 1;
      } catch (e) {
        console.error(
          `Failed to create global agreement for instructor ${instructor._id}:`,
          e.message
        );
      }
    }

    res.json({
      success: true,
      message: 'Global earnings settings updated and agreements generated',
      successCount,
      totalInstructors: instructors.length
    });
  } catch (error) {
    console.error('Update global earnings settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update global agreement settings',
      error: error.message
    });
  }
};

// @desc    Create a custom agreement for a single instructor
// @route   POST /api/instructor-agreements/create-custom
// @access  Private (Admin)
exports.createCustomAgreement = async (req, res) => {
  try {
    const { instructorId, platformPercentage, instructorPercentage, adminNotes } =
      req.body || {};

    if (!instructorId) {
      return res.status(400).json({
        success: false,
        message: 'Instructor ID is required'
      });
    }

    const p = Number(platformPercentage);
    const i = Number(instructorPercentage);

    if (
      !Number.isFinite(p) ||
      !Number.isFinite(i) ||
      p < 0 ||
      i < 0 ||
      p + i !== 100
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Platform and instructor percentages must be valid numbers that sum to 100%'
      });
    }

    const instructor = await User.findById(instructorId).select(
      'name email role isDeleted status'
    );
    if (
      !instructor ||
      instructor.role !== 'instructor' ||
      instructor.isDeleted ||
      instructor.status === 'deleted'
    ) {
      return res.status(404).json({
        success: false,
        message: 'Instructor not found or inactive'
      });
    }

    await createAgreementForInstructor({
      instructor,
      platformPercentage: p,
      instructorPercentage: i,
      agreementType: 'custom',
      adminNotes,
      createdBy: req.user && req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Custom agreement created and sent to instructor'
    });
  } catch (error) {
    console.error('Create custom agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create custom agreement',
      error: error.message
    });
  }
};

// @desc    Instructor approves an agreement
// @route   PUT /api/instructor-agreements/:agreementId/approve
// @access  Private (Instructor)
exports.approveAgreement = async (req, res) => {
  try {
    const { agreementId } = req.params;
    const instructorId = req.user.id;

    const agreement = await InstructorEarningsAgreement.findById(agreementId);
    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    if (agreement.instructor.toString() !== instructorId) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized to approve this agreement' });
    }

    if (agreement.status !== 'pending') {
      return res
        .status(400)
        .json({ success: false, message: 'Only pending agreements can be approved' });
    }

    await agreement.approve(instructorId);

    const currentSplit = await InstructorEarningsAgreement.getEarningsSplit(
      instructorId
    );

    res.json({
      success: true,
      message: 'Agreement approved successfully',
      data: {
        agreement,
        currentEarningsSplit: currentSplit
      }
    });
  } catch (error) {
    console.error('Approve instructor agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve agreement',
      error: error.message
    });
  }
};

// @desc    Instructor rejects an agreement
// @route   PUT /api/instructor-agreements/:agreementId/reject
// @access  Private (Instructor)
exports.rejectAgreement = async (req, res) => {
  try {
    const { agreementId } = req.params;
    const { reason } = req.body || {};
    const instructorId = req.user.id;

    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required (minimum 10 characters)'
      });
    }

    const agreement = await InstructorEarningsAgreement.findById(agreementId).populate(
      'instructor',
      'name email'
    );
    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    if (agreement.instructor._id.toString() !== instructorId) {
      return res
        .status(403)
        .json({ success: false, message: 'Not authorized to reject this agreement' });
    }

    if (agreement.status !== 'pending') {
      return res
        .status(400)
        .json({ success: false, message: 'Only pending agreements can be rejected' });
    }

    await agreement.reject(reason, instructorId);

    try {
      const admins = await User.find({
        role: 'admin',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      }).select('email name');

      const subject = 'Instructor rejected earnings agreement';
      const message = `Instructor ${agreement.instructor.name} (${agreement.instructor.email}) rejected an earnings agreement.\nReason: ${reason}`;

      for (const admin of admins) {
        try {
          await sendEmail({
            email: admin.email,
            subject,
            message
          });
        } catch (emailError) {
          console.error(
            'Failed to notify admin about rejected agreement:',
            emailError.message
          );
        }
      }
    } catch (notifyError) {
      console.error('Error notifying admins about rejected agreement:', notifyError.message);
    }

    res.json({
      success: true,
      message: 'Agreement rejected successfully'
    });
  } catch (error) {
    console.error('Reject instructor agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject agreement',
      error: error.message
    });
  }
};

// @desc    Resend an agreement email to instructor
// @route   POST /api/instructor-agreements/:agreementId/resend
// @access  Private (Admin)
exports.resendAgreement = async (req, res) => {
  try {
    const { agreementId } = req.params;

    const agreement = await InstructorEarningsAgreement.findById(agreementId).populate(
      'instructor',
      'name email'
    );

    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    const instructor = agreement.instructor;
    if (!instructor || !instructor.email) {
      return res
        .status(400)
        .json({ success: false, message: 'Instructor email not available' });
    }

    const settings = await AdminSettings.getSettings();
    const platformName = settings.platformName || 'EduFlow Academy';

    try {
      await sendEmail({
        email: instructor.email,
        subject: 'Instructor Earnings Agreement - Reminder',
        html:
          `<h2>Earnings Agreement Reminder</h2>` +
          `<p>Dear ${instructor.name},</p>` +
          `<p>This is a reminder about your pending earnings agreement with ${platformName}.</p>` +
          `<p><strong>Your share:</strong> ${agreement.instructorPercentage}% &nbsp; | &nbsp; <strong>Platform share:</strong> ${agreement.platformPercentage}%</p>` +
          `<p>You can download and review the agreement PDF here:</p>` +
          `<p><a href="${constructFileUrl(agreement.pdfUrl)}">Download Agreement PDF</a></p>` +
          `<p>Please log in to your instructor dashboard to approve or reject this agreement.</p>`
      });

      agreement.emailSentToInstructor = true;
      agreement.emailSentAt = new Date();
      await agreement.save();
    } catch (emailError) {
      console.error('Failed to resend agreement email:', emailError.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to resend agreement email',
        error: emailError.message
      });
    }

    res.json({
      success: true,
      message: 'Agreement email resent successfully'
    });
  } catch (error) {
    console.error('Resend instructor agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resend agreement email',
      error: error.message
    });
  }
};

// @desc    Delete a single agreement (admin)
// @route   DELETE /api/instructor-agreements/:id
// @access  Private (Admin)
exports.deleteAgreement = async (req, res) => {
  try {
    const { id } = req.params;

    const agreement = await InstructorEarningsAgreement.findById(id);
    if (!agreement) {
      return res.status(404).json({ success: false, message: 'Agreement not found' });
    }

    const localPath = agreement.localPath;
    await agreement.deleteOne();

    if (localPath) {
      try {
        await deleteAgreementPDF(localPath);
      } catch (err) {
        console.error('Failed to delete agreement PDF from disk:', err.message);
      }
    }

    res.json({
      success: true,
      message: 'Agreement deleted successfully'
    });
  } catch (error) {
    console.error('Delete instructor agreement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete agreement',
      error: error.message
    });
  }
};

// @desc    Delete all agreements (admin)
// @route   DELETE /api/instructor-agreements/all
// @access  Private (Admin)
exports.deleteAllAgreements = async (req, res) => {
  try {
    const agreements = await InstructorEarningsAgreement.find({});

    for (const agreement of agreements) {
      if (agreement.localPath) {
        try {
          await deleteAgreementPDF(agreement.localPath);
        } catch (err) {
          console.error('Failed to delete agreement PDF from disk:', err.message);
        }
      }
    }

    await InstructorEarningsAgreement.deleteMany({});

    res.json({
      success: true,
      message: 'All agreements deleted successfully'
    });
  } catch (error) {
    console.error('Delete all instructor agreements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete agreements',
      error: error.message
    });
  }
};

