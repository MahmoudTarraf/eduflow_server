const SectionPayment = require('../models/SectionPayment');
const Section = require('../models/Section');
const Course = require('../models/Course');
const User = require('../models/User');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const AdminSettings = require('../models/AdminSettings');
const InstructorEarning = require('../models/InstructorEarning');
const AdminEarning = require('../models/AdminEarning');
const Message = require('../models/Message');
const { sendEmail } = require('../utils/sendEmail');

/**
 * Get all pending student payments for admin approval
 * @route GET /api/admin/student-payments
 * @access Private/Admin
 */
exports.getPendingPayments = async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 50 } = req.query;
    
    const query = status === 'all' ? {} : { status };
    
    const payments = await SectionPayment.find(query)
      .populate('student', 'name email profilePicture')
      .populate('course', 'name')
      .populate('section', 'title')
      .populate('instructor', 'name email')
      .populate('processedBy', 'name')
      .sort({ submittedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await SectionPayment.countDocuments(query);

    res.json({
      success: true,
      data: payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
      error: error.message
    });
  }
};

/**
 * Approve a payment and calculate earnings
 * @route POST /api/admin/student-payments/:id/approve
 * @access Private/Admin
 */
exports.approvePayment = async (req, res) => {
  let session = null;
  let useTransaction = false;
  
  try {
    session = await mongoose.startSession();
    await session.startTransaction();
    useTransaction = true;
  } catch (transactionError) {
    console.log('⚠️  Transactions not supported (not a replica set). Running without transactions.');
    session = null;
    useTransaction = false;
  }

  try {
    const { id } = req.params;
    
    const paymentQuery = SectionPayment.findById(id)
      .populate('section')
      .populate('course')
      .populate('student', 'name email');
    const payment = useTransaction ? await paymentQuery.session(session) : await paymentQuery;

    if (!payment) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.status !== 'pending') {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Payment is already ${payment.status}`
      });
    }

    // Get instructor from course
    const courseQuery = Course.findById(payment.course._id);
    const course = useTransaction ? await courseQuery.session(session) : await courseQuery;
    if (!course || !course.instructor) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Course or instructor not found'
      });
    }

    // Get instructor's active agreement to determine percentage
    let instructorPercentage = 70; // default
    let platformPercentage = 30; // default
    let agreementSource = 'default';

    const agreementQuery = InstructorEarningsAgreement.findOne({
      instructor: course.instructor,
      status: 'approved',
      isActive: true
    }).sort({ createdAt: -1 });
    const agreement = useTransaction ? await agreementQuery.session(session) : await agreementQuery;

    if (agreement) {
      instructorPercentage = agreement.instructorPercentage;
      platformPercentage = agreement.platformPercentage;
      agreementSource = `${agreement.agreementType} agreement v${agreement.version || 1}`;
      console.log(`✅ Using ACTIVE agreement for instructor ${course.instructor}:`, {
        agreementId: agreement._id,
        type: agreement.agreementType,
        version: agreement.version,
        instructorPercentage: agreement.instructorPercentage,
        platformPercentage: agreement.platformPercentage,
        isActive: agreement.isActive
      });
    } else {
      // Fallback to global settings
      const settings = await AdminSettings.getSettings();
      instructorPercentage = settings.instructorRevenuePercentage || 70;
      platformPercentage = settings.platformRevenuePercentage || 30;
      agreementSource = 'global settings';
      console.log(`ℹ️  No active agreement found. Using global settings:`, {
        instructorPercentage,
        platformPercentage
      });
    }

    // Calculate earnings
    const totalAmount = payment.amountCents;
    const instructorEarnings = Math.floor((totalAmount * instructorPercentage) / 100);
    const platformEarnings = totalAmount - instructorEarnings;

    console.log('💰 Payment Approval Calculation:', {
      source: agreementSource,
      totalAmount,
      instructorPercentage,
      platformPercentage,
      instructorEarnings,
      platformEarnings,
      paymentId: payment._id
    });

    // Update payment
    payment.status = 'approved';
    payment.processedAt = new Date();
    payment.processedBy = req.user.id;
    payment.instructor = course.instructor;
    payment.instructorEarnings = instructorEarnings;
    payment.platformEarnings = platformEarnings;
    payment.instructorPercentage = instructorPercentage;
    payment.platformPercentage = platformPercentage;
    
    if (useTransaction) {
      await payment.save({ session });
    } else {
      await payment.save();
    }

    console.log('✅ Payment saved with earnings:', {
      paymentId: payment._id,
      instructorEarnings: payment.instructorEarnings,
      platformEarnings: payment.platformEarnings
    });

    // Create InstructorEarning record for instructor's earnings dashboard
    const instructorEarningData = {
      instructor: course.instructor,
      student: payment.student,
      course: payment.course._id,
      section: payment.section._id,
      sectionPayment: payment._id,
      studentPaidAmount: totalAmount,
      currency: payment.currency,
      instructorPercentage: instructorPercentage,
      instructorEarningAmount: instructorEarnings,
      adminCommissionAmount: platformEarnings,
      status: 'accrued',
      paymentMethod: payment.paymentMethod,
      accruedAt: new Date()
    };
    const instructorEarningRecord = useTransaction 
      ? await InstructorEarning.create([instructorEarningData], { session })
      : await InstructorEarning.create([instructorEarningData]);

    console.log('✅ InstructorEarning record created:', {
      earningId: instructorEarningRecord[0]._id,
      instructor: course.instructor,
      instructorEarningAmount: instructorEarnings,
      adminCommissionAmount: platformEarnings
    });

    // Create AdminEarning record for platform earnings tracking
    const adminEarningData = {
      sectionPayment: payment._id,
      student: payment.student,
      course: payment.course._id,
      section: payment.section._id,
      instructor: course.instructor,
      totalAmount: totalAmount,
      currency: payment.currency,
      instructorPercentage: instructorPercentage,
      adminCommissionPercentage: platformPercentage,
      adminEarningAmount: platformEarnings,
      instructorEarningAmount: instructorEarnings,
      paymentMethod: payment.paymentMethod,
      transactionDate: new Date()
    };
    const adminEarningRecord = useTransaction
      ? await AdminEarning.create([adminEarningData], { session })
      : await AdminEarning.create([adminEarningData]);

    console.log('✅ AdminEarning record created:', {
      earningId: adminEarningRecord[0]._id,
      adminEarningAmount: platformEarnings,
      instructorEarningAmount: instructorEarnings
    });

    // Notify instructor about the approved payment and their earnings
    try {
      const instructorUser = await User.findById(course.instructor);

      if (instructorUser) {
        const studentName = payment.student?.name || 'a student';
        const courseName = payment.course?.name || 'a course';
        const sectionName = payment.section?.title || payment.section?.name || '';
        const currency = payment.currency || 'SYP';
        const earnedAmountFormatted = (instructorEarnings / 100).toFixed(2);

        const baseText = `You earned ${earnedAmountFormatted} ${currency} from ${studentName} for ${courseName}`;
        const fullText = sectionName ? `${baseText} — ${sectionName}.` : `${baseText}.`;

        // In-app notification
        if (!Array.isArray(instructorUser.notifications)) {
          instructorUser.notifications = [];
        }
        instructorUser.notifications.push({
          message: fullText,
          type: 'success',
          read: false
        });
        await instructorUser.save();

        // Direct message in the internal inbox
        await Message.create({
          sender: req.user.id,
          recipient: course.instructor,
          conversationType: 'direct',
          subject: `Student payment approved for ${courseName}`,
          content: fullText,
          course: payment.course._id,
          section: payment.section._id
        });

        // Email notification
        await sendEmail({
          email: instructorUser.email,
          subject: 'Student payment approved and earnings added to your balance',
          message: fullText,
          html: `<p>${fullText}</p>`
        });

        // Optional Socket.IO notification to instructor
        try {
          const io = req.app.get('io');
          if (io) {
            io.to(`user:${course.instructor.toString()}`).emit('instructor.payment-approved', {
              instructorId: course.instructor.toString(),
              amount: instructorEarnings,
              currency,
              studentName,
              courseName,
              sectionName,
              sectionPaymentId: payment._id
            });
          }
        } catch (socketError) {
          console.error('Failed to emit instructor payment-approved event:', socketError.message);
        }
      }
    } catch (notifyError) {
      console.error('Failed to notify instructor after payment approval:', notifyError);
    }

    if (useTransaction) {
      await session.commitTransaction();
    }

    // Notify admins that pending student payment counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after payment approval:', e.message);
    }

    // Populate for response
    await payment.populate([
      { path: 'student', select: 'name email' },
      { path: 'course', select: 'name' },
      { path: 'section', select: 'title' },
      { path: 'instructor', select: 'name email' },
      { path: 'processedBy', select: 'name' }
    ]);

    res.json({
      success: true,
      message: 'Payment approved successfully',
      data: payment
    });

  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
    }
    console.error('Error approving payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve payment',
      error: error.message
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

/**
 * Reject a payment
 * @route POST /api/admin/student-payments/:id/reject
 * @access Private/Admin
 */
exports.rejectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const payment = await SectionPayment.findById(id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Payment is already ${payment.status}`
      });
    }

    payment.status = 'rejected';
    payment.rejectionReason = reason || 'Invalid or unverifiable payment';
    payment.processedAt = new Date();
    payment.processedBy = req.user.id;
    
    await payment.save();

    // Notify admins that pending student payment counts changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after payment rejection:', e.message);
    }

    await payment.populate([
      { path: 'student', select: 'name email' },
      { path: 'course', select: 'name' },
      { path: 'section', select: 'title' },
      { path: 'processedBy', select: 'name' }
    ]);

    res.json({
      success: true,
      message: 'Payment rejected',
      data: payment
    });

  } catch (error) {
    console.error('Error rejecting payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject payment',
      error: error.message
    });
  }
};

/**
 * Get admin earnings summary
 * @route GET /api/admin/my-earnings
 * @access Private/Admin
 */
exports.getAdminEarnings = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const query = { status: 'approved' };
    
    if (startDate || endDate) {
      query.processedAt = {};
      if (startDate) query.processedAt.$gte = new Date(startDate);
      if (endDate) query.processedAt.$lte = new Date(endDate);
    }

    // Get all approved payments
    const payments = await SectionPayment.find(query);

    console.log(`📊 Admin Earnings: Found ${payments.length} approved payments`);
    
    // Log first payment for debugging
    if (payments.length > 0) {
      console.log('Sample payment:', {
        id: payments[0]._id,
        amountCents: payments[0].amountCents,
        platformEarnings: payments[0].platformEarnings,
        instructorEarnings: payments[0].instructorEarnings,
        instructorPercentage: payments[0].instructorPercentage,
        platformPercentage: payments[0].platformPercentage
      });
    }

    // Calculate totals - MULTI-CURRENCY SUPPORT
    // Group by currency instead of summing all together
    const currencyTotals = {};
    payments.forEach(payment => {
      const curr = payment.currency || 'SYP';
      if (!currencyTotals[curr]) {
        currencyTotals[curr] = {
          studentPayments: 0,
          platformEarnings: 0,
          instructorEarnings: 0,
          count: 0
        };
      }
      currencyTotals[curr].studentPayments += payment.amountCents || 0;
      currencyTotals[curr].platformEarnings += payment.platformEarnings || 0;
      currencyTotals[curr].instructorEarnings += payment.instructorEarnings || 0;
      currencyTotals[curr].count += 1;
    });

    console.log('💰 Admin Earnings by Currency:', currencyTotals);

    // Group by month for chart data
    const monthlyData = {};
    payments.forEach(payment => {
      const month = new Date(payment.processedAt).toISOString().slice(0, 7); // YYYY-MM
      if (!monthlyData[month]) {
        monthlyData[month] = {
          studentPayments: 0,
          platformEarnings: 0,
          instructorEarnings: 0,
          count: 0
        };
      }
      monthlyData[month].studentPayments += payment.amountCents;
      monthlyData[month].platformEarnings += payment.platformEarnings;
      monthlyData[month].instructorEarnings += payment.instructorEarnings;
      monthlyData[month].count += 1;
    });

    // Get pending payments count
    const pendingCount = await SectionPayment.countDocuments({ status: 'pending' });

    // Calculate backward-compatible totals (SYP only for compatibility)
    const totalStudentPayments = currencyTotals['SYP']?.studentPayments || 0;
    const totalPlatformEarnings = currencyTotals['SYP']?.platformEarnings || 0;
    const totalInstructorEarnings = currencyTotals['SYP']?.instructorEarnings || 0;

    res.json({
      success: true,
      data: {
        summary: {
          // Legacy fields (SYP only for backward compatibility)
          totalStudentPayments,
          totalPlatformEarnings,
          totalInstructorEarnings,
          totalPayments: payments.length,
          pendingPayments: pendingCount,
          averagePayment: payments.length > 0 ? Math.floor(totalStudentPayments / payments.length) : 0,
          // NEW: Multi-currency breakdown
          currencyBreakdown: currencyTotals
        },
        monthlyData: Object.keys(monthlyData).sort().map(month => ({
          month,
          ...monthlyData[month]
        })),
        recentPayments: await SectionPayment.find({ status: 'approved' })
          .populate('student', 'name email')
          .populate('course', 'name')
          .populate('section', 'title')
          .populate('instructor', 'name')
          .sort({ processedAt: -1 })
          .limit(10)
      }
    });

  } catch (error) {
    console.error('Error fetching admin earnings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings',
      error: error.message
    });
  }
};

/**
 * Get student payment history
 * @route GET /api/student/payment-history
 * @access Private/Student
 */
exports.getStudentPaymentHistory = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const payments = await SectionPayment.find({ student: studentId })
      .populate('course', 'name instructor')
      .populate('section', 'title priceCents')
      .populate('processedBy', 'name')
      .sort({ submittedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Ensure receipt URLs are properly formatted
    const paymentsWithUrls = payments.map(payment => {
      const paymentObj = payment.toObject();
      if (paymentObj.receipt && paymentObj.receipt.storedName) {
        // Construct full URL if not already set
        if (!paymentObj.receipt.url || !paymentObj.receipt.url.startsWith('http')) {
          paymentObj.receipt.url = `${req.protocol}://${req.get('host')}/uploads/receipts/${paymentObj.receipt.storedName}`;
        }
      }
      return paymentObj;
    });

    const total = await SectionPayment.countDocuments({ student: studentId });

    // Calculate totals using the effective paid amount (finalAmountCents when available)
    const getEffectiveAmountCents = (payment) => {
      if (typeof payment.finalAmountCents === 'number' && !Number.isNaN(payment.finalAmountCents) && payment.finalAmountCents > 0) {
        return payment.finalAmountCents;
      }
      if (typeof payment.amountCents === 'number' && !Number.isNaN(payment.amountCents) && payment.amountCents > 0) {
        return payment.amountCents;
      }
      return 0;
    };

    const totalSpent = paymentsWithUrls
      .filter(p => p.status === 'approved')
      .reduce((sum, p) => sum + getEffectiveAmountCents(p), 0);
    
    const pendingAmount = paymentsWithUrls
      .filter(p => p.status === 'pending')
      .reduce((sum, p) => sum + getEffectiveAmountCents(p), 0);

    res.json({
      success: true,
      data: {
        payments: paymentsWithUrls,
        summary: {
          totalPayments: total,
          totalSpent,
          pendingAmount,
          approvedCount: paymentsWithUrls.filter(p => p.status === 'approved').length,
          pendingCount: paymentsWithUrls.filter(p => p.status === 'pending').length,
          rejectedCount: paymentsWithUrls.filter(p => p.status === 'rejected').length
        }
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment history',
      error: error.message
    });
  }
};
