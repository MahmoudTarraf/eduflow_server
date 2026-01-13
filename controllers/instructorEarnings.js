const mongoose = require('mongoose');
const InstructorEarning = require('../models/InstructorEarning');
const Course = require('../models/Course');
const PayoutAuditLog = require('../models/PayoutAuditLog');

// @desc    Get instructor earnings summary
// @route   GET /api/instructor-earnings/summary
// @access  Private (Instructor)
exports.getEarningsSummary = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const InstructorPayoutRequest = require('../models/InstructorPayoutRequest');
    
    // Get total student payments (earnings) - only accrued and paid matter
    const earningsSummary = await InstructorEarning.getSummary(instructorId);
    
    // Calculate available balance from accrued earnings only
    const totalEarningsAmount = earningsSummary.accrued?.amount || 0;
    
    // Get all payout requests
    const [pendingPayouts, rejectedPayouts, approvedPayouts] = await Promise.all([
      InstructorPayoutRequest.find({ instructor: instructorId, status: 'pending' }).select('requestedAmount currency createdAt'),
      InstructorPayoutRequest.find({ instructor: instructorId, status: 'rejected' }).select('requestedAmount currency createdAt rejectionReason'),
      InstructorPayoutRequest.find({ instructor: instructorId, status: 'approved' }).select('requestedAmount currency processedAt payoutProof')
    ]);
    
    // ✅ Calculate amounts from PAYOUT REQUESTS (not from earnings status)
    const pendingAmount = pendingPayouts.reduce((sum, p) => sum + p.requestedAmount, 0);
    const rejectedAmount = rejectedPayouts.reduce((sum, p) => sum + p.requestedAmount, 0);
    const paidAmount = approvedPayouts.reduce((sum, p) => sum + p.requestedAmount, 0); // ← From APPROVED PAYOUT REQUESTS
    
    // Available = Total Accrued Earnings - Pending Requests - Paid Requests
    const availableAmount = totalEarningsAmount - pendingAmount - paidAmount;
    
    // ✅ Enhanced summary based on PAYOUT REQUESTS, not earning status
    const enhancedSummary = {
      // Student payments earned (total from student payments)
      studentPayments: {
        total: totalEarningsAmount + paidAmount, // Include both available and already paid out
        count: (earningsSummary.accrued?.count || 0) + (earningsSummary.paid?.count || 0)
      },
      
      // Available balance for new payout requests
      available: {
        amount: availableAmount > 0 ? availableAmount : 0,
        currency: 'SYP'
      },
      
      // Pending payout requests (waiting for admin approval)
      pending: {
        amount: pendingAmount,
        count: pendingPayouts.length,
        requests: pendingPayouts
      },
      
      // Rejected payout requests (can request again)
      rejected: {
        amount: rejectedAmount,
        count: rejectedPayouts.length,
        requests: rejectedPayouts
      },
      
      // Approved/Paid payout requests (money sent to instructor)
      paid: {
        amount: paidAmount, // ← Sum of APPROVED payout request amounts
        count: approvedPayouts.length, // ← Count of APPROVED payout requests
        requests: approvedPayouts
      },
      
      // Keep original for backward compatibility
      accrued: earningsSummary.accrued,
      requested: { amount: pendingAmount, count: pendingPayouts.length }
    };
    
    console.log('📊 Instructor Summary (NEW ARCHITECTURE):', {
      instructorId,
      totalEarnings: (totalEarningsAmount / 100).toLocaleString(),
      available: (availableAmount / 100).toLocaleString(),
      pending: (pendingAmount / 100).toLocaleString(),
      rejected: (rejectedAmount / 100).toLocaleString(),
      paid: (paidAmount / 100).toLocaleString()
    });
    
    res.json({
      success: true,
      data: enhancedSummary
    });
  } catch (error) {
    console.error('Get earnings summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings summary'
    });
  }
};

// @desc    Get instructor earnings list with filters
// @route   POST /api/instructor-earnings/list
// @access  Private (Instructor)
exports.listEarnings = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { status, courseId, startDate, endDate, page = 1, limit = 50, sortBy = '-accruedAt' } = req.body;
    
    // Build query
    const query = { instructor: instructorId };
    
    if (status) {
      query.status = status;
    }
    
    if (courseId) {
      query.course = courseId;
    }
    
    if (startDate || endDate) {
      query.accruedAt = {};
      if (startDate) query.accruedAt.$gte = new Date(startDate);
      if (endDate) query.accruedAt.$lte = new Date(endDate);
    }
    
    // Execute query with pagination
    const skip = (page - 1) * limit;
    const [earnings, total] = await Promise.all([
      InstructorEarning.find(query)
        .populate('student', 'name email')
        .populate('course', 'name')
        .populate('section', 'name')
        .populate('payoutRequestId', 'status requestedAt')
        .sort(sortBy)
        .skip(skip)
        .limit(limit),
      InstructorEarning.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: earnings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('List earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings'
    });
  }
};

// @desc    Get earnings breakdown by course
// @route   GET /api/instructor-earnings/by-course
// @access  Private (Instructor)
exports.getEarningsByCourse = async (req, res) => {
  try {
    const instructorId = req.user.id;
    
    const breakdown = await InstructorEarning.aggregate([
      {
        $match: { instructor: new mongoose.Types.ObjectId(instructorId) }
      },
      {
        $group: {
          _id: '$course',
          totalEarnings: { $sum: '$instructorEarningAmount' },
          totalStudentPayments: { $sum: '$studentPaidAmount' },
          totalAdminCommission: { $sum: '$adminCommissionAmount' },
          studentCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'courses',
          localField: '_id',
          foreignField: '_id',
          as: 'courseInfo'
        }
      },
      {
        $unwind: '$courseInfo'
      },
      {
        $project: {
          courseName: '$courseInfo.name',
          totalEarnings: 1,
          totalStudentPayments: 1,
          totalAdminCommission: 1,
          studentCount: 1
        }
      },
      {
        $sort: { totalEarnings: -1 }
      }
    ]);
    
    res.json({
      success: true,
      data: breakdown
    });
  } catch (error) {
    console.error('Get earnings by course error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch course breakdown'
    });
  }
};

// @desc    Get available balance for instructor
// @route   GET /api/instructor-earnings/available-balance
// @access  Private (Instructor)
exports.getAvailableBalance = async (req, res) => {
  try {
    const instructorId = req.user.id;
    
    const balance = await InstructorEarning.getAvailableBalance(instructorId);
    
    // Get minimum payout from user settings
    const User = require('../models/User');
    const user = await User.findById(instructorId);
    const minimumPayout = user.instructorPayoutSettings?.minimumPayout || 1000;
    
    res.json({
      success: true,
      data: {
        availableAmount: balance.totalAmount,
        earnningsCount: balance.count,
        minimumPayout,
        canRequestPayout: balance.totalAmount >= minimumPayout
      }
    });
  } catch (error) {
    console.error('Get available balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available balance'
    });
  }
};

// @desc    Get earnings details by student
// @route   GET /api/instructor-earnings/by-student/:courseId
// @access  Private (Instructor)
exports.getEarningsByStudent = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { courseId } = req.params;
    
    const earnings = await InstructorEarning.find({
      instructor: instructorId,
      course: courseId
    })
      .populate('student', 'name email avatar')
      .populate('section', 'name')
      .sort({ accruedAt: -1 });
    
    // Group by student
    const byStudent = {};
    earnings.forEach(earning => {
      const studentId = earning.student._id.toString();
      if (!byStudent[studentId]) {
        byStudent[studentId] = {
          student: earning.student,
          totalPaid: 0,
          totalEarned: 0,
          sectionsCount: 0,
          sections: []
        };
      }
      byStudent[studentId].totalPaid += earning.studentPaidAmount;
      byStudent[studentId].totalEarned += earning.instructorEarningAmount;
      byStudent[studentId].sectionsCount += 1;
      byStudent[studentId].sections.push({
        section: earning.section,
        amount: earning.instructorEarningAmount,
        status: earning.status,
        date: earning.accruedAt
      });
    });
    
    res.json({
      success: true,
      data: Object.values(byStudent)
    });
  } catch (error) {
    console.error('Get earnings by student error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch student earnings'
    });
  }
};

// @desc    Export earnings to CSV
// @route   POST /api/instructor-earnings/export
// @access  Private (Instructor)
exports.exportEarnings = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { status, courseId, startDate, endDate } = req.body;
    
    // Build query
    const query = { instructor: instructorId };
    if (status) query.status = status;
    if (courseId) query.course = courseId;
    if (startDate || endDate) {
      query.accruedAt = {};
      if (startDate) query.accruedAt.$gte = new Date(startDate);
      if (endDate) query.accruedAt.$lte = new Date(endDate);
    }
    
    const earnings = await InstructorEarning.find(query)
      .populate('student', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .sort({ accruedAt: -1 });
    
    // Convert to CSV
    const csvRows = [];
    csvRows.push('Date,Student,Email,Course,Section,Student Paid,Your Share %,Your Amount,Admin Commission,Status,Payment Method');
    
    earnings.forEach(earning => {
      const row = [
        new Date(earning.accruedAt).toISOString().split('T')[0],
        earning.student?.name || 'N/A',
        earning.student?.email || 'N/A',
        earning.course?.name || 'N/A',
        earning.section?.name || 'N/A',
        (earning.studentPaidAmount / 100).toFixed(2),
        earning.instructorPercentage,
        (earning.instructorEarningAmount / 100).toFixed(2),
        (earning.adminCommissionAmount / 100).toFixed(2),
        earning.status,
        earning.paymentMethod || 'N/A'
      ];
      csvRows.push(row.join(','));
    });
    
    const csv = csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=earnings_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export earnings'
    });
  }
};

// @desc    Get detailed earnings list for admin (with instructor, student, course, agreement info)
// @route   POST /api/instructor-earnings/admin/detailed-list
// @access  Private (Admin)
exports.getDetailedEarningsForAdmin = async (req, res) => {
  try {
    const { instructorId, courseId, startDate, endDate, page = 1, limit = 50 } = req.body;
    
    // Build query
    const query = {};
    
    if (instructorId) query.instructor = instructorId;
    if (courseId) query.course = courseId;
    
    if (startDate || endDate) {
      query.accruedAt = {};
      if (startDate) query.accruedAt.$gte = new Date(startDate);
      if (endDate) query.accruedAt.$lte = new Date(endDate);
    }
    
    // Execute query with full population
    const skip = (page - 1) * limit;
    const [earningsRaw, total, summaryData] = await Promise.all([
      InstructorEarning.find(query)
        .populate('instructor', 'name email phone')
        .populate('student', 'name email')
        .populate('course', 'name')
        .populate('section', 'name')
        .populate('sectionPayment', 'receipt')
        .populate('agreementId', 'version agreementType platformPercentage instructorPercentage')
        .sort({ accruedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InstructorEarning.countDocuments(query),
      InstructorEarning.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalPayments: { $sum: 1 },
            totalRevenue: { $sum: '$studentPaidAmount' },
            platformEarnings: { $sum: '$adminCommissionAmount' },
            instructorEarnings: { $sum: '$instructorEarningAmount' }
          }
        }
      ])
    ]);
    
    // Ensure platformPercentage is always present (calculate if missing)
    const earnings = earningsRaw.map(earning => ({
      ...earning,
      platformPercentage: earning.platformPercentage || (100 - earning.instructorPercentage)
    }));
    
    const summary = summaryData.length > 0 ? summaryData[0] : {
      totalPayments: 0,
      totalRevenue: 0,
      platformEarnings: 0,
      instructorEarnings: 0
    };
    
    console.log('📊 Admin Detailed Earnings fetched:', {
      query,
      total,
      earningsCount: earnings.length,
      summary
    });
    
    res.json({
      success: true,
      data: earnings,
      summary,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get detailed earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch detailed earnings'
    });
  }
};

// @desc    Export detailed earnings to CSV (Admin)
// @route   POST /api/instructor-earnings/admin/export-detailed
// @access  Private (Admin)
exports.exportDetailedEarnings = async (req, res) => {
  try {
    const { instructorId, courseId, startDate, endDate } = req.body;
    
    // Build query
    const query = {};
    if (instructorId) query.instructor = instructorId;
    if (courseId) query.course = courseId;
    if (startDate || endDate) {
      query.accruedAt = {};
      if (startDate) query.accruedAt.$gte = new Date(startDate);
      if (endDate) query.accruedAt.$lte = new Date(endDate);
    }
    
    const earnings = await InstructorEarning.find(query)
      .populate('instructor', 'name email')
      .populate('student', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('agreementId', 'version agreementType')
      .sort({ accruedAt: -1 });
    
    // Convert to CSV
    const csvRows = [];
    csvRows.push('Date,Instructor,Instructor Email,Student,Student Email,Course,Section,Student Paid,Currency,Instructor %,Platform %,Instructor Earned,Platform Earned,Status,Agreement Type,Agreement Version,Payment Method');
    
    earnings.forEach(earning => {
      const row = [
        new Date(earning.accruedAt).toISOString().split('T')[0],
        earning.instructor?.name || 'N/A',
        earning.instructor?.email || 'N/A',
        earning.student?.name || 'N/A',
        earning.student?.email || 'N/A',
        earning.course?.name || 'N/A',
        earning.section?.name || 'N/A',
        (earning.studentPaidAmount / 100).toFixed(2),
        earning.currency || 'USD',
        earning.instructorPercentage,
        earning.platformPercentage || (100 - earning.instructorPercentage),
        (earning.instructorEarningAmount / 100).toFixed(2),
        (earning.adminCommissionAmount / 100).toFixed(2),
        earning.status,
        earning.agreementId?.agreementType || earning.agreementType || 'legacy',
        earning.agreementId?.version || earning.agreementVersion || 1,
        earning.paymentMethod || 'N/A'
      ];
      csvRows.push(row.join(','));
    });
    
    const csv = csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=detailed-earnings_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export detailed earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export detailed earnings'
    });
  }
};

module.exports = exports;
