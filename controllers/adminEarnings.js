const AdminEarning = require('../models/AdminEarning');
const InstructorEarning = require('../models/InstructorEarning');

// @desc    Get admin earnings summary
// @route   GET /api/admin/earnings/summary
// @access  Private (Admin)
exports.getEarningsSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const filter = {};
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const summary = await AdminEarning.getTotalEarnings(filter);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Get admin earnings summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings summary'
    });
  }
};

// @desc    Get detailed admin earnings list
// @route   POST /api/admin/earnings/list
// @access  Private (Admin)
exports.listEarnings = async (req, res) => {
  try {
    const { startDate, endDate, courseId, instructorId, page = 1, limit = 50, sortBy = '-transactionDate' } = req.body;

    const query = {};
    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }
    if (courseId) query.course = courseId;
    if (instructorId) query.instructor = instructorId;

    const skip = (page - 1) * limit;
    const [earnings, total] = await Promise.all([
      AdminEarning.find(query)
        .populate('student', 'name email')
        .populate('course', 'name')
        .populate('section', 'name')
        .populate('instructor', 'name email isDeleted status')
        .populate('sectionPayment', 'status processedAt')
        .sort(sortBy)
        .skip(skip)
        .limit(limit),
      AdminEarning.countDocuments(query)
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
    console.error('List admin earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings'
    });
  }
};

// @desc    Get earnings breakdown by course
// @route   GET /api/admin/earnings/by-course
// @access  Private (Admin)
exports.getEarningsByCourse = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const filter = {};
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const breakdown = await AdminEarning.getEarningsByCourse(filter);

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

// @desc    Get earnings breakdown by instructor
// @route   GET /api/admin/earnings/by-instructor
// @access  Private (Admin)
exports.getEarningsByInstructor = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const filter = {};
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const breakdown = await AdminEarning.getEarningsByInstructor(filter);

    res.json({
      success: true,
      data: breakdown
    });
  } catch (error) {
    console.error('Get earnings by instructor error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch instructor breakdown'
    });
  }
};

// @desc    Export admin earnings to CSV
// @route   POST /api/admin/earnings/export
// @access  Private (Admin)
exports.exportEarnings = async (req, res) => {
  try {
    const { startDate, endDate, courseId, instructorId } = req.body;

    const query = {};
    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }
    if (courseId) query.course = courseId;
    if (instructorId) query.instructor = instructorId;

    const earnings = await AdminEarning.find(query)
      .populate('student', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('instructor', 'name email isDeleted status')
      .sort({ transactionDate: -1 });

    const csvRows = [];
    csvRows.push('Date,Student,Course,Section,Instructor,Total Amount,Instructor %,Instructor Amount,Admin %,Admin Amount,Payment Method');

    earnings.forEach(earning => {
      const row = [
        new Date(earning.transactionDate).toISOString().split('T')[0],
        earning.student?.name || 'N/A',
        earning.course?.name || 'N/A',
        earning.section?.name || 'N/A',
        earning.instructor?.name || 'N/A',
        (earning.totalAmount / 100).toFixed(2),
        earning.instructorPercentage,
        (earning.instructorEarningAmount / 100).toFixed(2),
        earning.adminCommissionPercentage,
        (earning.adminEarningAmount / 100).toFixed(2),
        earning.paymentMethod || 'N/A'
      ];
      csvRows.push(row.join(','));
    });

    const csv = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=admin_earnings_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export admin earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export earnings'
    });
  }
};

module.exports = exports;
