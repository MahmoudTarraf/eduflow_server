const StudentPayment = require('../models/StudentPayment');
const Section = require('../models/Section');
const Group = require('../models/Group');
const Course = require('../models/Course');

// @desc    Record student payment
// @route   POST /api/payments/record
// @access  Private (Student/Instructor/Admin)
exports.recordPayment = async (req, res) => {
  try {
    const { studentId, courseId, sectionId, groupId, amountSYR, paymentMethod, receiptUrl, notes } = req.body;
    
    // Verify section exists
    const section = await Section.findById(sectionId);
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Students can only record their own payments
    const finalStudentId = req.user.role === 'student' ? req.user._id : studentId;
    
    const payment = await StudentPayment.create({
      student: finalStudentId,
      course: courseId,
      section: sectionId,
      group: groupId,
      amountSYR,
      status: 'pending',
      verified: false,
      paidAt: new Date(),
      paymentMethod: paymentMethod || 'other',
      receiptUrl: receiptUrl || '',
      notes: notes || ''
    });
    
    await payment.populate('student', 'name email');
    await payment.populate('section', 'name priceSYR');
    
    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully. Awaiting verification.',
      data: payment
    });
  } catch (error) {
    console.error('Error recording payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record payment',
      error: error.message
    });
  }
};

// @desc    Verify payment (instructor/admin)
// @route   PUT /api/payments/:paymentId/verify
// @access  Private (Instructor/Admin)
exports.verifyPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    
    const payment = await StudentPayment.findById(paymentId)
      .populate('course', 'instructor')
      .populate('student', 'name email');
      
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && payment.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to verify this payment'
      });
    }
    
    payment.status = 'paid';
    payment.verified = true;
    payment.verifiedAt = new Date();
    payment.verifiedBy = req.user._id;
    
    await payment.save();
    
    res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      data: payment
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message
    });
  }
};

// @desc    Get payments for a group
// @route   GET /api/groups/:groupId/payments
// @access  Private (Instructor/Admin)
exports.getGroupPayments = async (req, res) => {
  try {
    const { groupId } = req.params;
    
    const payments = await StudentPayment.find({ group: groupId })
      .populate('student', 'name email')
      .populate('section', 'name priceSYR isFree')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: payments.length,
      data: payments
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
      error: error.message
    });
  }
};

// @desc    Check section access for student
// @route   GET /api/sections/:sectionId/access
// @access  Private (Student)
exports.checkSectionAccess = async (req, res) => {
  try {
    const { sectionId } = req.params;
    
    const section = await Section.findById(sectionId);
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Free sections are accessible to all enrolled students
    if (section.isFree) {
      return res.status(200).json({
        success: true,
        hasAccess: true,
        reason: 'free_section'
      });
    }
    
    // Check if student has verified payment for this section
    const payment = await StudentPayment.findOne({
      student: req.user._id,
      section: sectionId,
      status: 'paid',
      verified: true
    });
    
    if (payment) {
      return res.status(200).json({
        success: true,
        hasAccess: true,
        reason: 'payment_verified',
        payment: {
          amountSYR: payment.amountSYR,
          verifiedAt: payment.verifiedAt
        }
      });
    }
    
    // Check if there's a pending payment
    const pendingPayment = await StudentPayment.findOne({
      student: req.user._id,
      section: sectionId,
      status: 'pending'
    });
    
    return res.status(200).json({
      success: true,
      hasAccess: false,
      reason: pendingPayment ? 'payment_pending' : 'payment_required',
      sectionPrice: section.priceSYR,
      pendingPayment: pendingPayment ? {
        amountSYR: pendingPayment.amountSYR,
        submittedAt: pendingPayment.paidAt
      } : null
    });
  } catch (error) {
    console.error('Error checking access:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check access',
      error: error.message
    });
  }
};

module.exports = exports;
