const Enrollment = require('../models/Enrollment');
const Course = require('../models/Course');
const Group = require('../models/Group');
const Section = require('../models/Section');
const SectionPayment = require('../models/SectionPayment');
const User = require('../models/User');
const StudentProgress = require('../models/StudentProgress');
const Message = require('../models/Message');
const { sendEmail } = require('../utils/sendEmail');
const { constructUploadPath } = require('../utils/urlHelper');

// @desc    Enroll student in a course through a specific group
// @route   POST /api/enroll
// @access  Private (Student)
exports.enrollStudent = async (req, res) => {
  try {
    const { courseId, groupId } = req.body;
    const studentId = req.user.id;

    // Validate course and group
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Check if already enrolled in this course
    const existingEnrollment = await Enrollment.findOne({ student: studentId, course: courseId });
    if (existingEnrollment) {
      return res.status(400).json({ success: false, message: 'Already enrolled in this course' });
    }

    // Check if already enrolled in this group
    const alreadyInGroup = group.students.find(s => s.student.toString() === studentId.toString());
    if (alreadyInGroup) {
      return res.status(400).json({ success: false, message: 'Already enrolled in this group' });
    }

    // Create enrollment record
    const enrollment = await Enrollment.create({
      student: studentId,
      course: courseId,
      group: groupId
    });

    // Add student to group's students array with 'enrolled' status (instant enrollment)
    group.students.push({
      student: studentId,
      enrollmentDate: new Date(),
      status: 'enrolled', // Instant enrollment - no approval needed
      paymentStatus: 'pending'
    });
    await group.save();

    // Add course to student's enrolledCourses array in User model
    const user = await User.findById(studentId);
    user.enrolledCourses.push({
      course: courseId,
      group: groupId,
      status: 'enrolled',
      enrollmentDate: new Date()
    });
    await user.save();

    // Send notification to instructor
    const io = req.app.get('io');
    if (io) {
      // Get instructor socket ID and notify
      io.to(`user:${group.instructor}`).emit('student_enrolled', {
        studentId,
        studentName: user.name,
        courseId,
        courseName: course.name,
        groupId,
        groupName: group.name
      });
    }

    res.status(201).json({
      success: true,
      message: 'Successfully enrolled in course',
      enrollment
    });
  } catch (error) {
    console.error('Enroll student error:', error);
    
    // Handle duplicate key error (E11000)
    if (error.code === 11000) {
      return res.status(400).json({ 
        success: false, 
        message: 'You are already enrolled in this course' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
};

// @desc    Submit payment for a section
// @route   POST /api/payments
// @access  Private (Student)
exports.submitSectionPayment = async (req, res) => {
  try {
    const { 
      sectionId, 
      paymentMethod, 
      useBalance, 
      balanceUsed, 
      finalAmountCents,
      balanceDiscountPercentage,
      baseAmountSYP,
      currency,
      amountCents,
      exchangeRate
    } = req.body;
    const studentId = req.user.id;

    // Validate section and load course with allowPointsDiscount and instructor for earnings split
    const section = await Section.findById(sectionId).populate('course', 'name allowPointsDiscount instructor');
    if (!section) {
      return res.status(404).json({ success: false, message: 'Section not found' });
    }

    // Check if section is paid
    if (section.isFree) {
      return res.status(400).json({ success: false, message: 'This section is free and does not require payment' });
    }

    // Validate balance usage if requested
    let validatedBalanceUsed = 0; // stored in cents (SYP-based discount amount)
    let pointsUsedForPayment = 0; // how many gamification points are ultimately consumed
    let balanceStudent = null;
    let pendingPointsToDeduct = 0;
    if (useBalance === 'true' || useBalance === true) {
      // Get student's current balance and points
      const student = await User.findById(studentId).select('gamification');
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }

      // Get conversion settings
      const GamificationSettings = require('../models/GamificationSettings');
      const settings = await GamificationSettings.findOne();
      const conversionRate = settings?.conversionSettings;
      
      if (!conversionRate) {
        return res.status(400).json({ success: false, message: 'Balance conversion not configured' });
      }

      const studentPoints = student.gamification?.points || 0;

      // Calculate maximum wallet balance from current points (in SYP)
      let totalBalanceSYP = 0;
      if (conversionRate.pointsRequired > 0) {
        totalBalanceSYP = Math.floor((studentPoints / conversionRate.pointsRequired) * conversionRate.sypValue);
      }
      const availableBalanceCents = totalBalanceSYP * 100;

      // balanceUsed comes from the frontend in CENTS (always SYP-based discount amount)
      const requestedBalanceCents = parseInt(balanceUsed) || 0;

      if (requestedBalanceCents <= 0) {
        return res.status(400).json({ success: false, message: 'Requested balance amount must be greater than zero' });
      }

      // Validate against what the student actually has (in cents)
      if (requestedBalanceCents > availableBalanceCents) {
        return res.status(400).json({ 
          success: false, 
          message: `Insufficient balance. Available: ${Math.floor(availableBalanceCents / 100)} SYP, Requested: ${(requestedBalanceCents / 100).toFixed(0)} SYP` 
        });
      }

      const courseTotalCents = parseInt(baseAmountSYP) || section.priceCents; // base section price in cents (SYP)

      // Determine how much of the wallet can be applied based on allowPointsDiscount
      const allowPointsDiscount = section.course?.allowPointsDiscount !== false;

      if (allowPointsDiscount) {
        // Discount can apply to the full course price; clamp by course total and available balance
        const maxByCourse = courseTotalCents > 0 ? courseTotalCents : requestedBalanceCents;
        validatedBalanceUsed = Math.min(requestedBalanceCents, availableBalanceCents, maxByCourse);
      } else {
        // Discount can only reduce the platform share (instructor earnings must be protected)
        // Use actual instructor/platform agreement instead of a hardcoded percentage
        const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
        const earningsSplit = await InstructorEarningsAgreement.getEarningsSplit(section.course.instructor);
        const platformPercentage = earningsSplit.platformPercentage;

        const platformShareCents = Math.round(courseTotalCents * (platformPercentage / 100));
        const maxUsableCents = Math.min(requestedBalanceCents, platformShareCents, availableBalanceCents);
        validatedBalanceUsed = maxUsableCents;
      }

      // If nothing usable after clamping, skip balance usage
      if (validatedBalanceUsed <= 0) {
        validatedBalanceUsed = 0;
      } else {
        // Convert the monetary discount back into points and remember the deduction to apply later
        const balanceUsedSYP = validatedBalanceUsed / 100;
        const pointsToDeduct = Math.ceil((balanceUsedSYP / conversionRate.sypValue) * conversionRate.pointsRequired);

        if (pointsToDeduct <= 0) {
          return res.status(400).json({ success: false, message: 'Could not convert balance usage into points' });
        }

        if (pointsToDeduct > studentPoints) {
          return res.status(400).json({ 
            success: false, 
            message: 'Insufficient points to cover requested wallet usage' 
          });
        }

        balanceStudent = student;
        pendingPointsToDeduct = pointsToDeduct;
      }
    }

    // Check if student already has a pending payment for this section
    const existingPendingPayment = await SectionPayment.findOne({
      student: studentId,
      section: sectionId,
      status: 'pending'
    });

    if (existingPendingPayment) {
      return res.status(400).json({ 
        success: false, 
        message: `You already have a pending payment for "${section.name}". Please wait for admin approval before submitting another payment for this section. If you were trying to pay for multiple sections, payment was skipped for this section but may have been submitted for other sections that don't have pending payments.` 
      });
    }

    // Check if student already has approved access
    const approvedPayment = await SectionPayment.findOne({
      student: studentId,
      section: sectionId,
      status: 'approved'
    });

    if (approvedPayment) {
      return res.status(400).json({ 
        success: false, 
        message: `You already have access to "${section.name}". If you were trying to pay for multiple sections, payment was skipped for this section but may have been submitted for other sections.` 
      });
    }

    // Validate payment method
    try {
      const AdminSettings = require('../models/AdminSettings');
      const adminSettings = await AdminSettings.getSettings();
      const providers = Array.isArray(adminSettings.paymentProviders)
        ? adminSettings.paymentProviders.filter((p) => p && p.key && p.isActive !== false)
        : [];

      if (providers.length > 0) {
        const keys = providers.map((p) => String(p.key));
        if (!keys.includes(paymentMethod)) {
          return res.status(400).json({ success: false, message: 'Invalid payment method' });
        }
      }
    } catch (_) {
      // If we cannot load providers, keep legacy behavior (do not block payments).
    }

    // Handle file upload
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Payment receipt is required' });
    }

    // Use provided currency and amounts from frontend, with fallbacks
    let normalizedCurrency = currency || section.currency || 'SYP';
    if (normalizedCurrency === 'SYR') {
      normalizedCurrency = 'SYP';
    }

    // Ensure currency is in valid enum
    const validCurrencies = ['USD', 'SYP', 'EUR', 'GBP'];
    if (!validCurrencies.includes(normalizedCurrency)) {
      normalizedCurrency = 'SYP'; // Default to SYP
    }

    // Use provided amounts or fallback to section amounts
    const finalBaseAmountSYP = parseInt(baseAmountSYP) || section.priceCents;
    const processedAmountCents = parseInt(amountCents) || section.priceCents;
    const finalExchangeRate = parseFloat(exchangeRate) || 1;
    const calculatedFinalAmount = processedAmountCents;

    // Apply points deduction only after all validation passes and just before creating the payment
    if (balanceStudent && pendingPointsToDeduct > 0) {
      if (!balanceStudent.gamification) {
        balanceStudent.gamification = { points: 0 };
      }
      balanceStudent.gamification.points = Math.max(0, (balanceStudent.gamification.points || 0) - pendingPointsToDeduct);
      await balanceStudent.save();
      pointsUsedForPayment = pendingPointsToDeduct;
    }

    // Create payment record
    const payment = await SectionPayment.create({
      student: studentId,
      course: section.course._id,
      group: section.group,
      section: sectionId,
      baseAmountSYP: finalBaseAmountSYP,
      amountCents: calculatedFinalAmount,
      currency: normalizedCurrency,
      exchangeRate: finalExchangeRate,
      paymentMethod,
      // Balance usage fields
      useBalance: useBalance === 'true' || useBalance === true,
      balanceUsed: validatedBalanceUsed,
      pointsUsed: pointsUsedForPayment,
      finalAmountCents: parseInt(finalAmountCents) || calculatedFinalAmount,
      balanceDiscountPercentage: parseInt(balanceDiscountPercentage) || 0,
      originalCoursePrice: finalBaseAmountSYP,
      receipt: {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        url: constructUploadPath('receipts', req.file.filename),
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date(),
        uploadedBy: studentId
      },
      status: 'pending'
    });

    // Send notification to instructor and admin
    const io = req.app.get('io');
    if (io) {
      // Notify instructor
      const group = await Group.findById(section.group);
      if (group && group.instructor) {
        io.to(`user:${group.instructor}`).emit('payment_submitted', {
          paymentId: payment._id,
          studentId,
          sectionId,
          sectionName: section.name,
          amount: calculatedFinalAmount / 100,
          originalAmount: finalBaseAmountSYP / 100,
          balanceUsed: validatedBalanceUsed / 100,
          currency: normalizedCurrency,
          hasBalanceDiscount: validatedBalanceUsed > 0
        });
      }
      
      // Notify admin
      io.to('admin').emit('payment_submitted', {
        paymentId: payment._id,
        studentId,
        sectionId,
        sectionName: section.name,
        amount: calculatedFinalAmount / 100,
        originalAmount: finalBaseAmountSYP / 100,
        balanceUsed: validatedBalanceUsed / 100,
        currency: normalizedCurrency,
        hasBalanceDiscount: validatedBalanceUsed > 0
      });

      // Also notify admins that pending counts may have changed
      try {
        const { emitPendingSummaryUpdate } = require('./adminDashboard');
        await emitPendingSummaryUpdate(io);
      } catch (e) {
        console.error('Failed to emit pending summary update after payment submission:', e.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Payment submitted successfully. Awaiting verification.',
      payment
    });
  } catch (error) {
    console.error('Submit payment error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// @desc    Get pending payments for admin/instructor
// @route   GET /api/payments
// @access  Private (Admin/Instructor)
exports.getPendingPayments = async (req, res) => {
  try {
    let query = { status: 'pending' };
    
    // If instructor, only show payments for their courses
    if (req.user.role === 'instructor') {
      const courses = await Course.find({ instructor: req.user.id }).select('_id');
      query.course = { $in: courses.map(c => c._id) };
    }
    
    const payments = await SectionPayment.find(query)
      .populate('student', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .sort({ submittedAt: -1 });
    
    res.json({
      success: true,
      count: payments.length,
      payments
    });
  } catch (error) {
    console.error('Get pending payments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Approve or reject payment
// @route   PUT /api/payments/:id
// @access  Private (Admin/Instructor)
exports.processPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, rejectionReason } = req.body; // action: 'approve' or 'reject'
    
    // Validate payment ID
    if (!id || id === 'undefined') {
      return res.status(400).json({ success: false, message: 'Invalid payment ID' });
    }
    
    const payment = await SectionPayment.findById(id)
      .populate('student', 'name email')
      .populate('course', 'name instructor')
      .populate('section', 'name');
    
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    // Check permissions for instructor
    if (req.user.role === 'instructor') {
      const instructorId = payment.course?.instructor?._id || payment.course?.instructor;
      const userId = req.user.id || req.user._id;
      if (instructorId && instructorId.toString() !== userId.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to process this payment' });
      }
    }
    
    // Validate action
    if (!action || (action !== 'approve' && action !== 'reject')) {
      return res.status(400).json({ success: false, message: 'Invalid action. Must be approve or reject' });
    }
    
    // Process action
    if (action === 'approve') {
      payment.status = 'approved';
      payment.processedAt = new Date();
      payment.processedBy = req.user.id || req.user._id;
    } else if (action === 'reject') {
      payment.status = 'rejected';
      payment.processedAt = new Date();
      payment.processedBy = req.user.id || req.user._id;
      payment.rejectionReason = rejectionReason || 'Payment rejected';
    }
    
    await payment.save();
    
    // Update enrollment to include this section
    if (action === 'approve') {
      try {
        const studentId = payment.student._id || payment.student;
        const courseId = payment.course._id || payment.course;
        const sectionId = payment.section._id || payment.section;
        
        await Enrollment.findOneAndUpdate(
          { student: studentId, course: courseId },
          { $addToSet: { enrolledSections: sectionId } },
          { upsert: false }
        );
      } catch (enrollError) {
        console.error('Error updating enrollment:', enrollError);
        // Continue even if enrollment update fails
      }
    }
    
    // Send notification to student
    try {
      const io = req.app.get('io');
      if (io) {
        const studentId = payment.student._id || payment.student;
        const sectionName = payment.section?.name || 'this section';
        const message = action === 'approve' 
          ? `Your payment for section "${sectionName}" has been approved. You can now access the content.`
          : `Your payment for section "${sectionName}" has been rejected. Reason: ${rejectionReason || 'Payment rejected'}`;
          
        io.to(`user:${studentId}`).emit('payment_processed', {
          paymentId: payment._id,
          action,
          message
        });
      }
    } catch (ioError) {
      console.error('Error sending socket notification:', ioError);
      // Continue even if notification fails
    }
    
    // Create in-app message
    try {
      const studentId = payment.student._id || payment.student;
      const studentName = payment.student?.name || 'Student';
      const sectionName = payment.section?.name || 'this section';
      const courseName = payment.course?.name || 'this course';
      
      const messageContent = action === 'approve'
        ? `Hi ${studentName}, your payment for section "${sectionName}" in course "${courseName}" has been approved. You can now access the content.`
        : `Hi ${studentName}, your payment for section "${sectionName}" in course "${courseName}" has been rejected. Reason: ${rejectionReason || 'Payment rejected'}`;
        
      const subject = action === 'approve'
        ? `Payment Approved for ${sectionName}`
        : `Payment Rejected for ${sectionName}`;
      
      const attachments = [];
      if (payment.receipt && payment.receipt.url) {
        attachments.push({
          filename: payment.receipt.storedName || 'receipt',
          originalName: payment.receipt.originalName || 'receipt.jpg',
          fileUrl: payment.receipt.url,
          fileSize: payment.receipt.size || 0
        });
      }
      
      await Message.create({
        sender: req.user.id || req.user._id,
        recipient: studentId,
        conversationType: 'direct',
        subject,
        content: messageContent,
        attachments
      });
    } catch (msgError) {
      console.error('Error creating message:', msgError);
      // Continue even if message creation fails
    }
    
    res.json({
      success: true,
      message: `Payment ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      payment
    });
  } catch (error) {
    console.error('Process payment error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while processing payment', 
      error: error.message 
    });
  }
};

// @desc    Get course details after enrollment
// @route   GET /api/enroll/:courseId
// @access  Private (Student)
exports.getEnrolledCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const studentId = req.user.id;
    
    // Validate courseId
    if (!courseId || courseId === 'undefined') {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid course ID' 
      });
    }
    
    // Check enrollment
    const enrollment = await Enrollment.findOne({ 
      student: studentId, 
      course: courseId 
    }).populate('group', 'name');
    
    if (!enrollment) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }
    
    // Get course details (include instructor and originalInstructor for orphaned courses)
    const course = await Course.findById(courseId)
      .populate('instructor', 'name avatar')
      .populate('originalInstructor', 'name');
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    
    // Get sections for this group (only active sections)
    const sections = await Section.find({ group: enrollment.group._id, isActive: true })
      .sort('order');
    
    // Get section access status for each section
    const Content = require('../models/Content');
    const sectionsWithAccess = await Promise.all(
      sections.map(async (section) => {
        // Check if student has access to this section
        let hasAccess = section.isFree;
        
        if (!section.isFree) {
          // Check if payment is approved
          const payment = await SectionPayment.findOne({
            student: studentId,
            section: section._id,
            status: 'approved'
          });
          
          hasAccess = !!payment;
        }
        
        // Get content counts for this section
        // Only count active/latest content so deleted items don't inflate counts (certificate/progress calculations).
        const baseCountFilter = {
          section: section._id,
          deletionStatus: 'active',
          isLatestVersion: true
        };
        const lectureCount = await Content.countDocuments({ ...baseCountFilter, type: 'lecture' });
        const assignmentCount = await Content.countDocuments({ ...baseCountFilter, type: 'assignment' });
        const projectCount = await Content.countDocuments({ ...baseCountFilter, type: 'project' });
        
        return {
          ...section.toObject({ virtuals: true }),
          hasAccess,
          contentCounts: {
            lectures: lectureCount,
            assignments: assignmentCount,
            projects: projectCount
          }
        };
      })
    );
    
    res.json({
      success: true,
      course: {
        ...course.toObject(),
        sections: sectionsWithAccess,
        groupName: enrollment.group.name,
        groupId: enrollment.group._id
      }
    });
  } catch (error) {
    console.error('Get enrolled course error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// @desc    Remove student from course (instructor/admin only)
// @route   DELETE /api/enroll/remove
// @access  Private (Instructor/Admin)
exports.removeStudentFromCourse = async (req, res) => {
  try {
    const { studentId, courseId } = req.body;
    const requesterId = req.user.id;
    const requesterRole = req.user.role;

    // Validate course
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    // Check if requester has permission
    if (requesterRole === 'instructor' && course.instructor.toString() !== requesterId) {
      return res.status(403).json({ 
        success: false, 
        message: 'You can only remove students from your own courses' 
      });
    }

    // Find and delete enrollment
    const enrollment = await Enrollment.findOne({ student: studentId, course: courseId });
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }

    const groupId = enrollment.group;

    // Remove student from group
    const group = await Group.findById(groupId);
    if (group) {
      group.students = group.students.filter(
        s => s.student.toString() !== studentId.toString()
      );
      await group.save();
    }

    // Remove course from user's enrolledCourses
    const user = await User.findById(studentId);
    if (user) {
      user.enrolledCourses = user.enrolledCourses.filter(
        ec => ec.course.toString() !== courseId.toString()
      );
      await user.save();
    }

    // Delete related data
    const Certificate = require('../models/Certificate');
    const Progress = require('../models/Progress');
    const Submission = require('../models/Submission');

    await Promise.all([
      // Delete enrollment
      enrollment.deleteOne(),
      // Delete certificates for this course
      Certificate.deleteMany({ student: studentId, course: courseId }),
      // Delete progress for this course
      Progress.deleteOne({ user: studentId, course: courseId }),
      // Delete section payments for this course
      SectionPayment.deleteMany({ student: studentId, course: courseId }),
      // Delete submissions for this course
      Submission.deleteMany({ student: studentId, course: courseId })
    ]);

    // Send notification to student
    try {
      const studentEmail = user?.email;
      if (studentEmail) {
        await sendEmail({
          email: studentEmail,
          subject: `Removed from ${course.name}`,
          html: `
            <h2>Course Enrollment Removed</h2>
            <p>You have been removed from the course: <strong>${course.name}</strong></p>
            <p>All your progress, certificates, and submissions for this course have been deleted.</p>
            <p>If you have any questions, please contact your instructor or administrator.</p>
          `
        });
      }
    } catch (emailError) {
      console.error('Failed to send removal notification email:', emailError);
    }

    res.json({
      success: true,
      message: 'Student successfully removed from course'
    });
  } catch (error) {
    console.error('Remove student from course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to remove student from course', 
      error: error.message 
    });
  }
};
