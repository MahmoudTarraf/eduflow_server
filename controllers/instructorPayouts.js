const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs').promises;
const InstructorPayoutRequest = require('../models/InstructorPayoutRequest');
const InstructorEarning = require('../models/InstructorEarning');
const User = require('../models/User');
const Message = require('../models/Message');
const PayoutAuditLog = require('../models/PayoutAuditLog');
const { sendEmail } = require('../utils/sendEmail');
const { constructUploadPath } = require('../utils/urlHelper');
const { emitInstructorPendingSummaryUpdate } = require('./instructorDashboard');

// @desc    Create payout request
// @route   POST /api/payout-requests/create
// @access  Private (Instructor)
exports.createPayoutRequest = async (req, res) => {
  // Disable transactions for standalone MongoDB - they require a replica set
  // Transactions are not critical for this operation
  const useTransaction = false;
  const session = null;

  try {
    const instructorId = req.user.id;
    const { paymentMethod, receiverDetailsId, requestedAmount } = req.body;

    // 1. Check if instructor has pending request
    const hasPending = await InstructorPayoutRequest.hasPendingRequest(instructorId);
    if (hasPending) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'You already have a pending payout request. Please wait for it to be processed.'
      });
    }

    // 1b. Guard: if there is a rejected request, require re-request on the same record (do not create a new one)
    const existingRejected = await InstructorPayoutRequest.findOne({ instructor: instructorId, status: 'rejected' }).sort({ processedAt: -1 });
    if (existingRejected) {
      return res.status(400).json({
        success: false,
        message: 'You have a rejected payout request. Please re-request on the same record instead of creating a new one.'
      });
    }

    // 2. Get instructor details and validate receiver details
    const instructorQuery = User.findById(instructorId);
    const instructor = useTransaction ? await instructorQuery.session(session) : await instructorQuery;
    
    if (!instructor) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Instructor not found' });
    }

    // Check both paymentReceivers and instructorPayoutSettings for receiver details
    const receiverDetail = instructor.paymentReceivers?.find(
      rd => rd._id.toString() === receiverDetailsId
    ) || instructor.instructorPayoutSettings?.receiverDetails?.find(
      rd => rd._id.toString() === receiverDetailsId
    );

    if (!receiverDetail) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Receiver details not found. Please configure payout settings first.'
      });
    }

    // 3. Get all accrued and rejected earnings
    const earningsQuery = InstructorEarning.find({
      instructor: instructorId,
      status: { $in: ['accrued', 'rejected'] },
      payoutRequestId: null
    });
    const accruedEarnings = useTransaction ? await earningsQuery.session(session) : await earningsQuery;

    if (accruedEarnings.length === 0) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'No accrued or rejected earnings available for payout'
      });
    }

    // 4. Calculate total available balance and get currency from global settings
    const AdminSettings = require('../models/AdminSettings');
    const adminSettings = await AdminSettings.getSettings();
    const currency = adminSettings.defaultCurrency || 'SYP';
    
    const totalAvailableBalance = accruedEarnings.reduce((sum, e) => sum + e.instructorEarningAmount, 0);
    
    // Get minimum payout amount from admin settings (in smallest currency unit)
    // adminSettings.minimumPayoutAmountSYP is in SYP, multiply by 100 for smallest unit
    const minimumPayoutSYP = (adminSettings.minimumPayoutAmountSYP || 10000) * 100;
    
    // Currency-specific minimum payouts (in cents/smallest unit)
    const minimumPayoutsByCurrency = {
      'SYP': minimumPayoutSYP,
      'SYR': minimumPayoutSYP, // Same as SYP
      'USD': 1000,     // 10 USD (10 * 100 cents)
      'EUR': 1000,     // 10 EUR (10 * 100 cents)
      'GBP': 1000      // 10 GBP (10 * 100 pence)
    };

    const minimumPayout = minimumPayoutsByCurrency[currency] || 1000;

    // Determine the amount to request (custom or full balance)
    let finalRequestedAmount = requestedAmount ? parseInt(requestedAmount) : totalAvailableBalance;
    
    // Debug logging
    console.log('Payout request received:');
    console.log('- requestedAmount:', requestedAmount);
    console.log('- finalRequestedAmount:', finalRequestedAmount);
    console.log('- totalAvailableBalance:', totalAvailableBalance);
    
    // Validation: Check if requested amount is a valid number
    if (isNaN(finalRequestedAmount) || finalRequestedAmount <= 0) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Please enter a valid positive number.'
      });
    }
    
    // Validation: Check minimum payout
    if (finalRequestedAmount < minimumPayout) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Minimum payout amount is ${(minimumPayout / 100).toLocaleString()} ${currency}. Please enter at least this amount.`
      });
    }
    
    // Validation: Check if requested amount exceeds available balance
    if (finalRequestedAmount > totalAvailableBalance) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Requested amount (${(finalRequestedAmount / 100).toLocaleString()} ${currency}) exceeds your available balance (${(totalAvailableBalance / 100).toLocaleString()} ${currency})`
      });
    }
    
    // CUSTOM PAYOUT: Select earnings to cover the requested amount
    // IMPORTANT: The actual payout will be EXACTLY the requestedAmount, not the sum of earnings
    // Earnings are selected only for tracking purposes
    
    // Sort earnings by amount (smallest first) for selection
    const sortedEarnings = [...accruedEarnings].sort((a, b) => a.instructorEarningAmount - b.instructorEarningAmount);
    
    let selectedEarnings = [];
    let runningTotal = 0;
    
    // Select earnings until we have enough to cover the requested amount
    for (const earning of sortedEarnings) {
      selectedEarnings.push(earning);
      runningTotal += earning.instructorEarningAmount;
      
      if (runningTotal >= finalRequestedAmount) {
        break; // We have enough earnings selected
      }
    }
    
    // If we still don't have enough, use all available earnings
    if (runningTotal < finalRequestedAmount) {
      selectedEarnings = accruedEarnings;
      runningTotal = totalAvailableBalance;
    }
    
    // Ensure we have at least one earning
    if (selectedEarnings.length === 0 && accruedEarnings.length > 0) {
      selectedEarnings.push(sortedEarnings[0]);
    }
    
    const totalEarningsAmount = selectedEarnings.reduce((sum, e) => sum + e.instructorEarningAmount, 0);
    
    // Debug logging - EMPHASIZE that payout is for requested amount only
    console.log('✅ CUSTOM PAYOUT REQUEST:');
    console.log('- 💰 REQUESTED PAYOUT AMOUNT:', (finalRequestedAmount / 100).toLocaleString(), 'SYP');
    console.log('- 📊 Selected earnings count:', selectedEarnings.length);
    console.log('- 📈 Total of selected earnings:', (totalEarningsAmount / 100).toLocaleString(), 'SYP');
    console.log('- ⚠️  NOTE: Instructor will receive EXACTLY', (finalRequestedAmount / 100).toLocaleString(), 'SYP');
    console.log('- ℹ️  Selected earnings are for tracking only, not for calculating payout amount');

    // 5. Check for suspicious activity
    const suspiciousCheck = await PayoutAuditLog.detectSuspiciousActivity(instructorId, 24);
    const securityFlags = [];
    if (suspiciousCheck.suspicious) {
      securityFlags.push(suspiciousCheck.reason);
    }

    // 6. Create payout request with selected earnings
    // ⚠️  CRITICAL: requestedAmount is the EXACT amount instructor will receive
    // The selected earnings (earningIds) are ONLY for tracking which student payments are being paid out
    // DO NOT sum up earnings to calculate payout - use requestedAmount directly
    const payoutRequest = new InstructorPayoutRequest({
      instructor: instructorId,
      requestedAmount: finalRequestedAmount, // ← THIS is the exact payout amount
      currency: currency,
      earningIds: selectedEarnings.map(e => e._id), // ← These are for tracking only
      paymentMethod,
      receiverDetails: {
        receiverName: receiverDetail.receiverName,
        receiverPhone: receiverDetail.receiverPhone,
        receiverLocation: receiverDetail.receiverLocation || '',
        accountDetails: receiverDetail.accountDetails || ''
      },
      status: 'pending',
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      securityFlags
    });

    if (useTransaction) {
      await payoutRequest.save({ session });
    } else {
      await payoutRequest.save();
    }

    // Refresh instructor pending summary (available balance & payout eligibility)
    try {
      const io = req.app.get('io');
      if (io) {
        await emitInstructorPendingSummaryUpdate(io, instructorId);
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after payout create:', e.message);
    }

    // NOTE: We do NOT change the status of student payments (InstructorEarnings)
    // Student payments remain as 'accrued' and are separate from payout requests
    // Payout requests are tracked separately in InstructorPayoutRequest collection

    // 7. Create audit log
    await PayoutAuditLog.logAction({
      entityType: 'payout_request',
      entityId: payoutRequest._id,
      action: 'create',
      actor: instructorId,
      actorRole: 'instructor',
      newState: payoutRequest.toObject(),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    // 9. Notify admins
    const admins = await User.find({ role: 'admin' });
    const notificationMessage = `New payout request from ${instructor.name} for ${(finalRequestedAmount / 100).toLocaleString()} ${payoutRequest.currency}`;
    
    for (const admin of admins) {
      admin.notifications.push({
        message: notificationMessage,
        type: 'info',
        read: false
      });
      if (useTransaction) {
        await admin.save({ session });
      } else {
        await admin.save();
      }

      // Send email to admin
      try {
        await sendEmail({
          email: admin.email,
          subject: 'New Instructor Payout Request - EduFlow Academy',
          html: `
            <h2>New Payout Request</h2>
            <p>Dear Admin,</p>
            <p>A new payout request has been submitted:</p>
            <p><strong>Instructor:</strong> ${instructor.name} (${instructor.email})</p>
            <p><strong>Amount:</strong> ${(finalRequestedAmount / 100).toLocaleString()} ${payoutRequest.currency}</p>
            <p><strong>Payment Method:</strong> ${paymentMethod}</p>
            <p><strong>Status:</strong> Pending Review</p>
            <p>Please review this request in your admin dashboard.</p>
            <br>
            <p>Best regards,<br>EduFlow Academy System</p>
          `
        });
      } catch (emailError) {
        console.error('Admin email notification failed:', emailError);
      }
    }

    if (useTransaction) {
      await session.commitTransaction();
    }

    // Refresh instructor pending summary (available balance & eligibility may change)
    try {
      const io = req.app.get('io');
      if (io) {
        await emitInstructorPendingSummaryUpdate(io, payoutRequest.instructor.toString());
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after payout approval:', e.message);
    }

    // Notify admins that pending payout counts may have changed
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after payout request create:', e.message);
    }

    res.status(201).json({
      success: true,
      message: 'Payout request submitted successfully',
      data: payoutRequest
    });
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
    }
    console.error('Create payout request error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create payout request'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// @desc    Re-request a rejected payout on the same record
// @route   PUT /api/payout-requests/:id/re-request
// @access  Private (Instructor)
exports.reRequestPayout = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const instructorId = req.user.id;

    const requestQuery = InstructorPayoutRequest.findById(id);
    const payoutRequest = useTransaction ? await requestQuery.session(session) : await requestQuery;

    if (!payoutRequest) {
      return res.status(404).json({ success: false, message: 'Payout request not found' });
    }

    if (payoutRequest.instructor.toString() !== instructorId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (payoutRequest.status !== 'rejected') {
      return res.status(400).json({ success: false, message: 'Only rejected requests can be re-requested' });
    }

    // Move back to pending without changing locked amount or earningIds
    payoutRequest.status = 'pending';
    payoutRequest.rejectionReason = undefined;
    payoutRequest.processedAt = null;
    payoutRequest.processedBy = null;
    payoutRequest.requestedAt = new Date();
    await payoutRequest.save();

    // Audit log
    await PayoutAuditLog.logAction({
      entityType: 'payout_request',
      entityId: payoutRequest._id,
      action: 're_request',
      actor: instructorId,
      actorRole: 'instructor',
      previousState: { status: 'rejected' },
      newState: { status: 'pending' },
      ipAddress: req.ip
    });

    // Notify admins
    try {
      const admins = await User.find({ role: 'admin' });
      const note = `Payout re-request from ${req.user.name} for ${(payoutRequest.requestedAmount / 100).toLocaleString()} ${payoutRequest.currency}`;
      for (const admin of admins) {
        admin.notifications.push({ message: note, type: 'info', read: false });
        await admin.save();
      }
    } catch (e) {}

    // Notify admins and refresh instructor pending summary
    try {
      const io = req.app.get('io');
      if (io) {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
        await emitInstructorPendingSummaryUpdate(io, instructorId);
      }
    } catch (e) {
      console.error('Failed to emit pending summary update after payout re-request:', e.message);
    }

    res.json({ success: true, message: 'Payout re-requested successfully', data: payoutRequest });
  } catch (error) {
    console.error('Re-request payout error:', error);
    res.status(500).json({ success: false, message: 'Failed to re-request payout' });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// @desc    Get instructor's payout requests
// @route   GET /api/payout-requests/my-requests
// @access  Private (Instructor)
exports.getMyPayoutRequests = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { status, page = 1, limit = 20 } = req.query;

    const query = { instructor: instructorId };
    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [requests, total] = await Promise.all([
      InstructorPayoutRequest.find(query)
        .populate('processedBy', 'name email')
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      InstructorPayoutRequest.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: requests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get my payout requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payout requests'
    });
  }
};

// @desc    Cancel payout request (instructor)
// @route   PUT /api/payout-requests/:id/cancel
// @access  Private (Instructor)
exports.cancelPayoutRequest = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const { reason } = req.body;
    const instructorId = req.user.id;

    const payoutRequestQuery = InstructorPayoutRequest.findById(id);
    const payoutRequest = useTransaction ? await payoutRequestQuery.session(session) : await payoutRequestQuery;
    
    if (!payoutRequest) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Payout request not found' });
    }

    if (payoutRequest.instructor.toString() !== instructorId) {
      if (useTransaction) await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (payoutRequest.status !== 'pending') {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Can only cancel pending requests'
      });
    }

    if (!payoutRequest.canBeCancelled) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel request after 24 hours'
      });
    }

    // Update request
    payoutRequest.status = 'cancelled';
    payoutRequest.cancellationReason = reason;
    if (useTransaction) {
      await payoutRequest.save({ session });
    } else {
      await payoutRequest.save();
    }

    // Revert earnings to accrued
    const updateOptions = useTransaction ? { session } : {};
    await InstructorEarning.updateMany(
      { _id: { $in: payoutRequest.earningIds } },
      {
        $set: {
          status: 'accrued',
          requestedAt: null,
          payoutRequestId: null
        }
      },
      updateOptions
    );

    // Audit log
    await PayoutAuditLog.logAction({
      entityType: 'payout_request',
      entityId: payoutRequest._id,
      action: 'cancel',
      actor: instructorId,
      actorRole: 'instructor',
      reason,
      ipAddress: req.ip
    });

    if (useTransaction) {
      await session.commitTransaction();
    }

    res.json({
      success: true,
      message: 'Payout request cancelled successfully',
      data: payoutRequest
    });
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
    }
    console.error('Cancel payout request error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel payout request'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// @desc    Get all payout requests (admin)
// @route   GET /api/admin/payout-requests
// @access  Private (Admin)
exports.getAllPayoutRequests = async (req, res) => {
  try {
    const { status, instructorId, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (instructorId) query.instructor = instructorId;

    const skip = (page - 1) * limit;
    const [requests, total] = await Promise.all([
      InstructorPayoutRequest.find(query)
        .populate('instructor', 'name email phone instructorPercentage isDeleted status')
        .populate('processedBy', 'name email')
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      InstructorPayoutRequest.countDocuments(query)
    ]);

    // Enrich with earnings details (for reference only)
    const enrichedRequests = await Promise.all(
      requests.map(async (request) => {
        const earnings = await InstructorEarning.find({
          _id: { $in: request.earningIds }
        })
          .populate('student', 'name email')
          .populate('course', 'name')
          .populate('section', 'name');

        // Group earnings by course for informational purposes only
        const courseInfo = {};
        let totalStudentPaid = 0;
        let totalEarningsSum = 0;
        
        earnings.forEach(earning => {
          const courseId = earning.course._id.toString();
          if (!courseInfo[courseId]) {
            courseInfo[courseId] = {
              courseName: earning.course.name,
              studentCount: 0
            };
          }
          courseInfo[courseId].studentCount += 1;
          
          totalStudentPaid += earning.studentPaidAmount;
          totalEarningsSum += earning.instructorEarningAmount;
        });

        return {
          ...request.toObject(),
          earnings,
          // ✅ PAYOUT AMOUNT: This is what instructor receives
          payoutAmount: request.requestedAmount,
          // 📊 INFO ONLY: Course distribution (no amounts, just student count)
          courseInfo: Object.values(courseInfo),
          totalStudents: earnings.length,
          // 📝 REFERENCE: Sum of linked earnings (NOT the payout amount)
          linkedEarningsSum: totalEarningsSum,
          totalStudentPayments: totalStudentPaid
        };
      })
    );

    res.json({
      success: true,
      data: enrichedRequests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get all payout requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payout requests'
    });
  }
};

// @desc    Approve payout request (admin)
// @route   PUT /api/admin/payout-requests/:id/approve
// @access  Private (Admin)
exports.approvePayoutRequest = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const adminId = req.user.id;

    // Proof file should be uploaded via multer middleware
    if (!req.file) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Proof of payment file is required'
      });
    }

    const payoutRequestQuery = InstructorPayoutRequest.findById(id)
      .populate('instructor', 'name email');
    const payoutRequest = useTransaction ? await payoutRequestQuery.session(session) : await payoutRequestQuery;

    if (!payoutRequest) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Payout request not found' });
    }

    if (payoutRequest.status !== 'pending') {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be approved'
      });
    }

    // Store proof file
    const proofDir = path.join(__dirname, '../uploads/payout-proofs');
    await fs.mkdir(proofDir, { recursive: true });

    const ext = path.extname(req.file.originalname);
    const proofFileName = `${id}_proof_${Date.now()}${ext}`;
    const proofPath = path.join(proofDir, proofFileName);
    
    await fs.rename(req.file.path, proofPath);

    // Update payout request
    payoutRequest.status = 'approved';
    payoutRequest.processedAt = new Date();
    payoutRequest.processedBy = adminId;
    payoutRequest.payoutProof = {
      originalName: req.file.originalname,
      storedName: proofFileName,
      url: constructUploadPath('payout-proofs', proofFileName),
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: adminId
    };

    if (useTransaction) {
      await payoutRequest.save({ session });
    } else {
      await payoutRequest.save();
    }

    // ✅ CRITICAL FIX: Do NOT change earning status
    // Earnings represent STUDENT PAYMENTS (not instructor payouts)
    // They should remain 'accrued' to track total student revenue
    // Payout requests separately track what's been paid to instructors
    // Available balance = Total Accrued - Sum of Approved Payout Requests
    
    console.log(`✅ Payout approved - Amount: ${(payoutRequest.requestedAmount / 100).toLocaleString()} ${payoutRequest.currency}`);
    console.log(`📊 Linked earnings remain 'accrued' - they represent student payments, not instructor payouts`);

    // Audit log
    await PayoutAuditLog.logAction({
      entityType: 'payout_request',
      entityId: payoutRequest._id,
      action: 'approve',
      actor: adminId,
      actorRole: 'admin',
      previousState: { status: 'pending' },
      newState: { status: 'approved', proof: proofFileName },
      ipAddress: req.ip
    });

    // Notify instructor
    const instructorQuery = User.findById(payoutRequest.instructor._id);
    const instructor = useTransaction ? await instructorQuery.session(session) : await instructorQuery;
    instructor.notifications.push({
      message: `Your payout request for ${(payoutRequest.requestedAmount / 100).toFixed(2)} ${payoutRequest.currency} has been approved and sent.`,
      type: 'success',
      read: false
    });
    if (useTransaction) {
      await instructor.save({ session });
    } else {
      await instructor.save();
    }

    if (useTransaction) {
      await session.commitTransaction();
    }

    // ✅ CRITICAL FIX: Send email asynchronously to avoid blocking response
    // Don't await - send response immediately after payout is approved
    // Use Promise with timeout to prevent hanging
    const sendEmailAsync = async () => {
      try {
        console.log(`📧 Sending payout approval email to ${instructor.email}...`);
        
        // Add timeout protection (10 seconds)
        const emailPromise = sendEmail({
          email: instructor.email,
          subject: `Payout Approved - ${(payoutRequest.requestedAmount / 100).toFixed(2)} ${payoutRequest.currency}`,
          message: `Your payout request has been approved and processed. Please find the proof of payment attached. Amount: ${(payoutRequest.requestedAmount / 100).toFixed(2)} ${payoutRequest.currency}`,
          attachments: [{
            filename: req.file.originalname,
            path: proofPath
          }]
        });

        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Email timeout')), 10000)
        );

        await Promise.race([emailPromise, timeoutPromise]);
        console.log(`✅ Payout approval email sent successfully to ${instructor.email}`);
      } catch (emailError) {
        console.error(`❌ Payout approval email failed for ${instructor.email}:`, emailError.message);
        // Log to database for admin review
        try {
          await PayoutAuditLog.logAction({
            entityType: 'payout_request',
            entityId: payoutRequest._id,
            action: 'email_failed',
            actor: adminId,
            actorRole: 'admin',
            previousState: { emailSent: false },
            newState: { emailSent: false, error: emailError.message },
            notes: `Failed to send approval email: ${emailError.message}`,
            ipAddress: req.ip
          });
        } catch (logError) {
          console.error('Failed to log email error:', logError);
        }
      }
    };

    // Fire and forget - don't block the response
    sendEmailAsync();

    // Send response immediately
    res.json({
      success: true,
      message: 'Payout request approved successfully',
      data: payoutRequest
    });
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
    }
    console.error('Approve payout request error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to approve payout request'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// @desc    Reject payout request (admin)
// @route   PUT /api/admin/payout-requests/:id/reject
// @access  Private (Admin)
exports.rejectPayoutRequest = async (req, res) => {
  // Disable transactions for standalone MongoDB
  const useTransaction = false;
  const session = null;

  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    if (!reason || reason.trim().length < 20) {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required (minimum 20 characters)'
      });
    }

    const payoutRequestQuery = InstructorPayoutRequest.findById(id)
      .populate('instructor', 'name email');
    const payoutRequest = useTransaction ? await payoutRequestQuery.session(session) : await payoutRequestQuery;

    if (!payoutRequest) {
      if (useTransaction) await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Payout request not found' });
    }

    if (payoutRequest.status !== 'pending') {
      if (useTransaction) await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be rejected'
      });
    }

    // Update request
    payoutRequest.status = 'rejected';
    payoutRequest.rejectionReason = reason;
    payoutRequest.processedAt = new Date();
    payoutRequest.processedBy = adminId;
    if (useTransaction) {
      await payoutRequest.save({ session });
    } else {
      await payoutRequest.save();
    }

    // NOTE: We do NOT change student payment (InstructorEarnings) status
    // Student payments remain as 'accrued' regardless of payout request status
    // The rejected payout request itself tracks the rejection
    
    console.log(`Rejected payout request ${id} - Amount: ${(payoutRequest.requestedAmount / 100).toLocaleString()} ${payoutRequest.currency}`);

    // Audit log
    await PayoutAuditLog.logAction({
      entityType: 'payout_request',
      entityId: payoutRequest._id,
      action: 'reject',
      actor: adminId,
      actorRole: 'admin',
      previousState: { status: 'pending' },
      newState: { status: 'rejected' },
      reason,
      ipAddress: req.ip
    });

    // Notify instructor
    const instructorQuery = User.findById(payoutRequest.instructor._id);
    const instructor = useTransaction ? await instructorQuery.session(session) : await instructorQuery;
    instructor.notifications.push({
      message: `Your payout request has been rejected. Reason: ${reason}`,
      type: 'error',
      read: false
    });
    if (useTransaction) {
      await instructor.save({ session });
    } else {
      await instructor.save();
    }

    if (useTransaction) {
      await session.commitTransaction();
    }

    // Send email
    try {
      await sendEmail({
        email: instructor.email,
        subject: 'Payout Request Rejected - Funds Remain Available',
        message: `Your payout request for ${(payoutRequest.requestedAmount / 100).toFixed(2)} ${payoutRequest.currency} has been rejected.\n\nReason: ${reason}\n\nYour funds remain in your Available Balance, and you can submit a new payout request at any time.`
      });
    } catch (emailError) {
      console.error('Rejection email failed:', emailError);
    }

    res.json({
      success: true,
      message: 'Payout request rejected',
      data: payoutRequest
    });
  } catch (error) {
    if (useTransaction && session) {
      await session.abortTransaction();
    }
    console.error('Reject payout request error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject payout request'
    });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// @desc    Get instructor's payout settings
// @route   GET /api/instructor/settings
// @access  Private (Instructor)
exports.getInstructorSettings = async (req, res) => {
  try {
    const instructor = await User.findById(req.user.id).select('instructorPayoutSettings');
    
    if (!instructor) {
      return res.status(404).json({
        success: false,
        message: 'Instructor not found'
      });
    }

    res.json({
      success: true,
      data: instructor.instructorPayoutSettings || {
        minimumPayout: 1000,
        receiverDetails: []
      }
    });
  } catch (error) {
    console.error('Get instructor settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings'
    });
  }
};

module.exports = exports;
