const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const SectionPayment = require('../models/SectionPayment');
const Section = require('../models/Section');
const Course = require('../models/Course');
const Group = require('../models/Group');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Message = require('../models/Message');
const InstructorEarning = require('../models/InstructorEarning');
const AdminEarning = require('../models/AdminEarning');
const PayoutAuditLog = require('../models/PayoutAuditLog');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const GamificationSettings = require('../models/GamificationSettings');
const { constructUploadPath } = require('../utils/urlHelper');
const { sendEmail } = require('../utils/sendEmail');
const { receiptsDir } = require('../middleware/upload');

const buildPaymentResponse = (payment) => {
  const obj = payment.toObject({ virtuals: true });
  if (obj.receipt && obj.receipt.storedName && !obj.receipt.url) {
    obj.receipt.url = constructUploadPath('receipts', obj.receipt.storedName);
  }
  return obj;
};

// @desc    Get student's own payments
// @route   GET /api/section-payments/my-payments
// @access  Private (Student)
exports.getMyPayments = async (req, res) => {
  try {
    const payments = await SectionPayment.find({ student: req.user.id })
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('group', 'name')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      count: payments.length,
      data: payments
    });
  } catch (error) {
    console.error('Get my payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
};

exports.submitSectionPayment = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { amount, amountCents, currency, paymentMethod, baseAmountSYP, exchangeRate } = req.body;

    const section = await Section.findById(sectionId).populate('course group');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    if (section.isFree || section.priceCents === 0) {
      return res.status(400).json({
        success: false,
        message: 'Payments are not required for free sections'
      });
    }

    const existingPayment = await SectionPayment.findOne({
      student: req.user.id,
      section: sectionId,
      status: { $in: ['pending', 'approved'] }
    });

    if (existingPayment) {
      return res.status(400).json({
        success: false,
        message: 'Payment already submitted for this section'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Receipt file is required'
      });
    }

    // Determine currency and amounts
    const resolvedCurrency = currency || 'SYP';
    const resolvedAmountCents = amountCents !== undefined
      ? Number(amountCents)
      : amount !== undefined
        ? Math.round(Number(amount) * 100)
        : section.priceCents;

    // Base amount in SYP (default to section price or provided value)
    const resolvedBaseAmountSYP = baseAmountSYP !== undefined
      ? Number(baseAmountSYP)
      : section.priceCents; // Section price is stored in SYP

    const resolvedExchangeRate = exchangeRate !== undefined
      ? Number(exchangeRate)
      : 1; // Default to 1 if no conversion

    if (!resolvedAmountCents || Number.isNaN(resolvedAmountCents) || resolvedAmountCents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than zero'
      });
    }

    console.log('💳 Payment Submission - Multi-Currency Details:', {
      baseAmountSYP: resolvedBaseAmountSYP,
      paidAmount: resolvedAmountCents,
      currency: resolvedCurrency,
      exchangeRate: resolvedExchangeRate,
      sectionPrice: section.priceCents
    });

    const payment = new SectionPayment({
      student: req.user.id,
      course: section.course._id,
      group: section.group,
      section: section._id,
      baseAmountSYP: resolvedBaseAmountSYP,
      amountCents: resolvedAmountCents,
      currency: resolvedCurrency,
      exchangeRate: resolvedExchangeRate,
      paymentMethod: paymentMethod || 'other'
    });

    const ext = path.extname(req.file.originalname) || '.dat';
    const newFileName = `${payment._id}${ext.toLowerCase()}`;
    const newPath = path.join(receiptsDir, newFileName);

    await fs.rename(req.file.path, newPath);

    payment.receipt = {
      originalName: req.file.originalname,
      storedName: newFileName,
      url: constructUploadPath('receipts', newFileName),
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user.id
    };

    await payment.save();

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('section_payment_submitted', {
        paymentId: payment._id,
        sectionName: section.name,
        studentId: req.user.id
      });
    }

    res.status(201).json({
      success: true,
      message: 'Payment submitted successfully and is pending review',
      data: buildPaymentResponse(payment)
    });
  } catch (error) {
    console.error('Submit section payment error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit payment'
    });
  }
};

exports.listSectionPayments = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    if (req.user.role === 'instructor') {
      const instructorCourses = await Course.find({ instructor: req.user.id }).select('_id');
      const ids = instructorCourses.map((c) => c._id);
      if (!ids.length) {
        return res.json({ success: true, count: 0, data: [] });
      }
      query.course = { $in: ids };
    }

    const payments = await SectionPayment.find(query)
      .populate('student', 'name email avatar')
      .populate({
        path: 'section',
        select: 'name group course priceCents currency',
        populate: [
          { path: 'group', select: 'name' },
          { path: 'course', select: 'name instructor' }
        ]
      })
      .sort({ submittedAt: -1 });

    res.json({
      success: true,
      count: payments.length,
      data: payments.map(buildPaymentResponse)
    });
  } catch (error) {
    console.error('List section payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
};

exports.approveSectionPayment = async (req, res) => {
  let session = null;
  let useTransaction = false;
  
  // Transactions are disabled for development (not using replica set)
  // try {
  //   session = await mongoose.startSession();
  //   await session.startTransaction();
  //   useTransaction = true;
  // } catch (transactionError) {
  //   console.log('⚠️  Transactions not supported (not a replica set). Running without transactions.');
  //   session = null;
  //   useTransaction = false;
  // }

  try {
    const { paymentId } = req.params;

    const paymentQuery = SectionPayment.findById(paymentId)
      .populate('student', 'name email gamification')
      .populate('section', 'name course group priceCents currency')
      .populate('course', 'name instructor allowPointsDiscount');
    const payment = useTransaction ? await paymentQuery.session(session) : await paymentQuery;

    if (!payment) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.status !== 'pending') {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Payment already processed' });
    }

    if (req.user.role === 'instructor' && payment.course.instructor.toString() !== req.user.id) {
      if (useTransaction) await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized to approve this payment' });
    }

    payment.status = 'approved';
    payment.processedAt = new Date();
    payment.processedBy = req.user.id;
    payment.rejectionReason = undefined;

    // Get earnings split from instructor's agreement
    const earningsSplit = await InstructorEarningsAgreement.getEarningsSplit(payment.course.instructor);
    const instructorPercentage = earningsSplit.instructorPercentage;
    const adminPercentage = earningsSplit.platformPercentage;

    // Determine base price, wallet discount, and final amount (all in cents)
    const baseAmountCents = payment.baseAmountSYP || payment.amountCents;
    const balanceUsedCents = payment.balanceUsed || 0; // wallet discount applied (if any)
    const rawFinalAmountCents = payment.finalAmountCents || payment.amountCents;
    const allowPointsDiscount = payment.course.allowPointsDiscount !== false;

    // Student actually paid (cash received by platform)
    let studentPaidAmount = rawFinalAmountCents;
    let instructorEarningAmount;
    let adminCommissionAmount;
    let instructorDiscountAmount = 0;
    let platformDiscountAmount = 0;

    if (baseAmountCents && balanceUsedCents > 0) {
      const instructorShareOnBase = Math.floor(baseAmountCents * instructorPercentage / 100);
      const platformShareOnBase = baseAmountCents - instructorShareOnBase;

      // For courses that do NOT allow points discount, the instructor's share is protected and
      // the discount can only come from the platform's share.
      const effectiveDiscountCents = allowPointsDiscount
        ? Math.min(balanceUsedCents, baseAmountCents)
        : Math.min(balanceUsedCents, platformShareOnBase);

      const expectedFinalCents = baseAmountCents - effectiveDiscountCents;

      if (Math.abs(expectedFinalCents - studentPaidAmount) <= 1) {
        studentPaidAmount = expectedFinalCents;

        if (allowPointsDiscount) {
          // New system: discount split proportionally between instructor and platform
          const totalSharePercent = instructorPercentage + adminPercentage || 100;
          platformDiscountAmount = Math.round(effectiveDiscountCents * (adminPercentage / totalSharePercent));
          instructorDiscountAmount = effectiveDiscountCents - platformDiscountAmount;

          instructorEarningAmount = Math.max(0, instructorShareOnBase - instructorDiscountAmount);
          adminCommissionAmount = Math.max(0, platformShareOnBase - platformDiscountAmount);
        } else {
          // Old system behaviour for opt-out courses: discount only reduces platform share
          instructorDiscountAmount = 0;
          platformDiscountAmount = effectiveDiscountCents;

          instructorEarningAmount = instructorShareOnBase;
          adminCommissionAmount = Math.max(0, platformShareOnBase - platformDiscountAmount);
        }
      } else {
        // Fallback: if amounts don't line up, split based on actual paid amount only
        instructorEarningAmount = Math.floor(studentPaidAmount * instructorPercentage / 100);
        adminCommissionAmount = studentPaidAmount - instructorEarningAmount;
      }
    } else {
      // No valid base/discount data: use simple split
      instructorEarningAmount = Math.floor(studentPaidAmount * instructorPercentage / 100);
      adminCommissionAmount = studentPaidAmount - instructorEarningAmount;
    }

    console.log('✅ Applying ACTIVE agreement percentages to new payment:', {
      instructor: payment.course.instructor,
      agreementType: earningsSplit.agreementType,
      agreementId: earningsSplit.agreementId,
      agreementVersion: earningsSplit.agreementVersion,
      instructorPercentage: instructorPercentage,
      platformPercentage: adminPercentage,
      studentPaidAmount,
      instructorEarningAmount,
      adminCommissionAmount
    });

    // Calculate discount percentage for reporting (0-100)
    const discountPercentage = baseAmountCents > 0
      ? Math.round((balanceUsedCents / baseAmountCents) * 100)
      : 0;

    // Persist earnings and discount split on the payment record for reporting
    payment.instructorEarnings = instructorEarningAmount;
    payment.platformEarnings = adminCommissionAmount;
    payment.instructorPercentage = instructorPercentage;
    payment.platformPercentage = adminPercentage;
    payment.instructorDiscount = instructorDiscountAmount;
    payment.platformDiscount = platformDiscountAmount;

    if (useTransaction) {
      await payment.save({ session });
    } else {
      await payment.save();
    }

    // Create InstructorEarning record with agreement tracking
    const instructorEarning = new InstructorEarning({
      instructor: payment.course.instructor,
      student: payment.student._id,
      course: payment.course._id,
      section: payment.section._id,
      sectionPayment: payment._id,
      studentPaidAmount,
      baseAmountSYP: baseAmountCents,
      balanceUsed: balanceUsedCents,
      balanceDiscountPercentage: discountPercentage,
      currency: payment.currency,
      instructorPercentage,
      platformPercentage: adminPercentage,
      instructorEarningAmount,
      adminCommissionAmount,
      // Agreement tracking
      agreementId: earningsSplit.agreementId,
      agreementType: earningsSplit.agreementType,
      agreementVersion: earningsSplit.agreementVersion || 1,
      status: 'accrued',
      paymentMethod: payment.paymentMethod,
      accruedAt: new Date()
    });
    if (useTransaction) {
      await instructorEarning.save({ session });
    } else {
      await instructorEarning.save();
    }
    
    console.log('✅ InstructorEarning created successfully:', {
      _id: instructorEarning._id,
      instructor: instructorEarning.instructor,
      status: instructorEarning.status,
      instructorEarningAmount: instructorEarning.instructorEarningAmount,
      currency: instructorEarning.currency
    });

    // Create AdminEarning record
    const adminEarning = new AdminEarning({
      sectionPayment: payment._id,
      student: payment.student._id,
      course: payment.course._id,
      section: payment.section._id,
      instructor: payment.course.instructor,
      totalAmount: studentPaidAmount,
      currency: payment.currency,
      instructorPercentage,
      adminCommissionPercentage: adminPercentage,
      adminEarningAmount: adminCommissionAmount,
      instructorEarningAmount,
      paymentMethod: payment.paymentMethod,
      transactionDate: new Date()
    });
    if (useTransaction) {
      await adminEarning.save({ session });
    } else {
      await adminEarning.save();
    }
    
    console.log('✅ AdminEarning created successfully:', {
      _id: adminEarning._id,
      instructor: adminEarning.instructor,
      adminEarningAmount: adminEarning.adminEarningAmount,
      currency: adminEarning.currency
    });

    // After approval, deduct points/balance used from the student's gamification wallet
    try {
      if (payment.useBalance && payment.balanceUsed > 0) {
        const student = await User.findById(payment.student._id || payment.student);
        if (student) {
          if (!student.gamification) {
            student.gamification = { points: 0, lockedBalance: 0, totalBalanceUsed: 0 };
          }

          const balanceUsedCents = payment.balanceUsed;
          student.gamification.totalBalanceUsed = (student.gamification.totalBalanceUsed || 0) + balanceUsedCents;

          // For legacy payments (created before points were deducted on submission), pointsUsed will be 0.
          // In that case, deduct the corresponding points now. For new payments, skip extra deduction.
          if (!payment.pointsUsed || payment.pointsUsed <= 0) {
            const settings = await GamificationSettings.findOne();
            const conversionRate = settings?.conversionSettings;

            if (conversionRate && conversionRate.pointsRequired > 0 && conversionRate.sypValue > 0) {
              const balanceUsedSYP = balanceUsedCents / 100;
              const pointsToDeduct = Math.ceil((balanceUsedSYP / conversionRate.sypValue) * conversionRate.pointsRequired);

              if (pointsToDeduct > 0) {
                student.gamification.points = Math.max(0, (student.gamification.points || 0) - pointsToDeduct);
                payment.pointsUsed = pointsToDeduct;
                await payment.save();
              }
            }
          }

          if (student.gamification.lockedBalance) {
            student.gamification.lockedBalance = Math.max(0, student.gamification.lockedBalance - balanceUsedCents);
          }

          await student.save();

          console.log('✅ Wallet balance accounting finalized after approval:', {
            student: student._id,
            balanceUsedCents,
            pointsUsed: payment.pointsUsed,
            remainingPoints: student.gamification.points,
            totalBalanceUsed: student.gamification.totalBalanceUsed
          });
        }
      }
    } catch (walletError) {
      console.error('⚠️ Failed to apply wallet balance accounting after payment approval:', walletError);
    }

    // Create audit log
    await PayoutAuditLog.logAction({
      entityType: 'earning',
      entityId: instructorEarning._id,
      action: 'create',
      actor: req.user.id,
      actorRole: req.user.role,
      newState: {
        instructorEarning: instructorEarning.toObject(),
        adminEarning: adminEarning.toObject()
      },
      ipAddress: req.ip
    });

    const enrollmentQuery = Enrollment.findOne({
      student: payment.student._id,
      course: payment.course._id
    });
    let enrollment = useTransaction ? await enrollmentQuery.session(session) : await enrollmentQuery;

    if (!enrollment) {
      const enrollmentData = [
        {
          student: payment.student._id,
          course: payment.course._id,
          group: payment.section.group,
          enrolledSections: [payment.section._id],
          enrolledAt: new Date()
        }
      ];
      if (useTransaction) {
        enrollment = await Enrollment.create(enrollmentData, { session });
        enrollment = enrollment[0];
      } else {
        enrollment = await Enrollment.create(enrollmentData);
        enrollment = enrollment[0];
      }
    } else {
      if (payment.section.group && (!enrollment.group || enrollment.group.toString() !== payment.section.group.toString())) {
        enrollment.group = payment.section.group;
      }
      const alreadyEnrolled = enrollment.enrolledSections.some((id) => id.toString() === payment.section._id.toString());
      if (!alreadyEnrolled) {
        enrollment.enrolledSections.push(payment.section._id);
      }
      enrollment.enrolledAt = enrollment.enrolledAt || new Date();
      if (useTransaction) {
        await enrollment.save({ session });
      } else {
        await enrollment.save();
      }
    }

    if (useTransaction) {
      await session.commitTransaction();
      session.endSession();
      console.log('✅ Transaction committed successfully for payment:', payment._id);
    } else {
      console.log('✅ Changes saved without transaction for payment:', payment._id);
    }

    const messageContent = `Hi ${payment.student.name}, your payment for section "${payment.section.name}" has been approved. You now have full access to the section content.`;
    const subject = `Payment approved — Section unlocked for ${payment.section.name}`;

    await Message.create({
      sender: req.user.id,
      recipient: payment.student._id,
      conversationType: 'direct',
      subject,
      content: messageContent,
      course: payment.course._id,
      group: payment.section.group
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${payment.student._id}`).emit('section_payment_approved', {
        paymentId: payment._id,
        sectionId: payment.section._id
      });
    }

    try {
      await sendEmail({
        email: payment.student.email,
        subject,
        message: messageContent
      });
    } catch (emailError) {
      console.error('Payment approval email failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Payment approved and section unlocked',
      data: buildPaymentResponse(payment)
    });
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
      session.endSession();
    }
    console.error('Approve section payment error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to approve payment' });
  }
};

exports.rejectSectionPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { reason } = req.body;

    const payment = await SectionPayment.findById(paymentId)
      .populate('student', 'name email')
      .populate('section', 'name course')
      .populate('course', 'name instructor');

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Payment already processed' });
    }

    if (req.user.role === 'instructor' && payment.course.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to reject this payment' });
    }

    payment.status = 'rejected';
    payment.rejectionReason = reason || 'Payment rejected';
    payment.processedAt = new Date();
    payment.processedBy = req.user.id;
    await payment.save();

    try {
      if (payment.useBalance && payment.pointsUsed && payment.pointsUsed > 0) {
        const student = await User.findById(payment.student._id || payment.student);
        if (student) {
          if (!student.gamification) {
            student.gamification = { points: 0, lockedBalance: 0, totalBalanceUsed: 0 };
          }
          student.gamification.points = (student.gamification.points || 0) + payment.pointsUsed;
          await student.save();
        }
      }
    } catch (refundError) {
      console.error('⚠️ Failed to refund wallet points after payment rejection:', refundError);
    }

    const messageContent = `Hi ${payment.student.name}, your payment for section "${payment.section.name}" has been rejected. Reason: ${payment.rejectionReason}. Please resubmit a valid receipt or contact support.`;
    const subject = `Payment rejected — Action required for ${payment.section.name}`;

    await Message.create({
      sender: req.user.id,
      recipient: payment.student._id,
      conversationType: 'direct',
      subject,
      content: messageContent,
      course: payment.course._id,
      group: payment.section.group
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${payment.student._id}`).emit('section_payment_rejected', {
        paymentId: payment._id,
        reason: payment.rejectionReason
      });
    }

    try {
      await sendEmail({
        email: payment.student.email,
        subject,
        message: messageContent
      });
    } catch (emailError) {
      console.error('Payment rejection email failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Payment rejected and student notified',
      data: buildPaymentResponse(payment)
    });
  } catch (error) {
    console.error('Reject section payment error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to reject payment' });
  }
};

// @desc    Get student's payment status for course sections
// @route   GET /api/section-payments/course/:courseId/status
// @access  Private (Student)
exports.getSectionPaymentStatus = async (req, res) => {
  try {
    const { courseId } = req.params;
    const studentId = req.user.id;

    // Get all payments for this student and course
    const payments = await SectionPayment.find({
      student: studentId,
      course: courseId
    }).select('section status rejectionReason amountCents currency submittedAt processedAt');

    // Create a map of section ID to payment status
    const statusMap = {};
    payments.forEach(payment => {
      const sectionId = payment.section.toString();
      // Keep only the most recent payment for each section
      if (!statusMap[sectionId] || new Date(payment.submittedAt) > new Date(statusMap[sectionId].submittedAt)) {
        statusMap[sectionId] = {
          paymentId: payment._id,
          status: payment.status,
          rejectionReason: payment.rejectionReason,
          amountCents: payment.amountCents,
          currency: payment.currency,
          submittedAt: payment.submittedAt,
          processedAt: payment.processedAt
        };
      }
    });

    res.json({
      success: true,
      data: statusMap
    });
  } catch (error) {
    console.error('Get section payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment status'
    });
  }
};
