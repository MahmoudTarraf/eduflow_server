const User = require('../models/User');
const SectionPayment = require('../models/SectionPayment');
const GamificationSettings = require('../models/GamificationSettings');

// @desc    Lock balance temporarily during payment processing
// @route   POST /api/payments/lock-balance
// @access  Private (Student)
exports.lockBalance = async (req, res) => {
  try {
    const { amount, paymentId } = req.body;
    const studentId = req.user.id;

    // Validate inputs
    if (!amount || !paymentId || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount and payment ID are required'
      });
    }

    // Get student
    const student = await User.findById(studentId);
    if (!student || student.role !== 'student') {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    // Get conversion settings to calculate available balance
    const settings = await GamificationSettings.findOne();
    const conversionRate = settings?.conversionSettings;
    
    if (!conversionRate) {
      return res.status(400).json({
        success: false,
        message: 'Balance conversion not configured'
      });
    }

    // Calculate available balance from points
    const studentPoints = student.gamification?.points || 0;
    let availableBalance = 0;
    if (conversionRate.pointsRequired > 0) {
      availableBalance = Math.floor((studentPoints / conversionRate.pointsRequired) * conversionRate.sypValue);
    }

    // Check if enough balance is available (considering already locked balance)
    const currentLockedBalance = student.gamification?.lockedBalance || 0;
    const totalNeededBalance = currentLockedBalance + amount;

    if (totalNeededBalance > availableBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ${availableBalance - currentLockedBalance} SYP, Requested: ${amount} SYP`
      });
    }

    // Lock the balance
    if (!student.gamification) {
      student.gamification = {};
    }
    student.gamification.lockedBalance = (student.gamification.lockedBalance || 0) + amount;
    
    await student.save();

    res.json({
      success: true,
      message: 'Balance locked successfully',
      lockedAmount: amount,
      totalLockedBalance: student.gamification.lockedBalance,
      availableBalance: availableBalance - student.gamification.lockedBalance
    });

  } catch (error) {
    console.error('Lock balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Release locked balance if payment fails
// @route   POST /api/payments/release-balance
// @access  Private (Student)
exports.releaseLockedBalance = async (req, res) => {
  try {
    const { paymentId } = req.body;
    const studentId = req.user.id;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID is required'
      });
    }

    // Find the payment to get the locked amount
    const payment = await SectionPayment.findById(paymentId);
    if (!payment || payment.student.toString() !== studentId.toString()) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Get student
    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    // Release the locked balance
    const balanceToRelease = payment.balanceUsed || 0;
    if (balanceToRelease > 0 && student.gamification?.lockedBalance) {
      student.gamification.lockedBalance = Math.max(0, student.gamification.lockedBalance - balanceToRelease);
      await student.save();
    }

    res.json({
      success: true,
      message: 'Locked balance released successfully',
      releasedAmount: balanceToRelease,
      remainingLockedBalance: student.gamification?.lockedBalance || 0
    });

  } catch (error) {
    console.error('Release balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Confirm balance deduction after successful payment
// @route   POST /api/payments/confirm-balance-deduction
// @access  Private (Admin - called when payment is approved)
exports.confirmBalanceDeduction = async (req, res) => {
  try {
    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID is required'
      });
    }

    // Find the payment
    const payment = await SectionPayment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // New wallet system: points are already deducted at submission/approval time.
    // If pointsUsed is set, treat this endpoint as a no-op to avoid double deduction.
    if (payment.pointsUsed && payment.pointsUsed > 0) {
      return res.json({
        success: true,
        message: 'Balance for this payment has already been processed by the new wallet system',
        deductedBalance: 0,
        deductedPoints: 0
      });
    }

    // Get student
    const student = await User.findById(payment.student);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    const balanceUsed = payment.balanceUsed || 0;
    
    if (balanceUsed > 0) {
      // Get conversion settings to deduct points
      const settings = await GamificationSettings.findOne();
      const conversionRate = settings?.conversionSettings;
      
      if (conversionRate && conversionRate.sypValue > 0) {
        // Calculate points to deduct based on balance used
        const pointsToDeduct = Math.ceil((balanceUsed / conversionRate.sypValue) * conversionRate.pointsRequired);
        
        // Initialize gamification if not exists
        if (!student.gamification) {
          student.gamification = { points: 0 };
        }
        
        // Deduct points and update balance tracking
        student.gamification.points = Math.max(0, (student.gamification.points || 0) - pointsToDeduct);
        student.gamification.totalBalanceUsed = (student.gamification.totalBalanceUsed || 0) + balanceUsed;
        
        // Release locked balance
        if (student.gamification.lockedBalance) {
          student.gamification.lockedBalance = Math.max(0, student.gamification.lockedBalance - balanceUsed);
        }
        
        await student.save();
        
        res.json({
          success: true,
          message: 'Balance deduction confirmed successfully',
          deductedBalance: balanceUsed,
          deductedPoints: pointsToDeduct,
          remainingPoints: student.gamification.points,
          totalBalanceUsed: student.gamification.totalBalanceUsed
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Conversion settings not configured properly'
        });
      }
    } else {
      res.json({
        success: true,
        message: 'No balance was used in this payment',
        deductedBalance: 0,
        deductedPoints: 0
      });
    }

  } catch (error) {
    console.error('Confirm balance deduction error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get student's current balance information
// @route   GET /api/payments/balance-info
// @access  Private (Student)
exports.getBalanceInfo = async (req, res) => {
  try {
    const studentId = req.user.id;

    // Get student
    const student = await User.findById(studentId).select('gamification');
    if (!student || student.role !== 'student') {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    // Get conversion settings
    const settings = await GamificationSettings.findOne();
    const conversionRate = settings?.conversionSettings;
    
    if (!conversionRate) {
      return res.status(400).json({
        success: false,
        message: 'Balance conversion not configured'
      });
    }

    // Calculate available balance from points
    const studentPoints = student.gamification?.points || 0;
    let totalBalance = 0;
    if (conversionRate.pointsRequired > 0) {
      totalBalance = Math.floor((studentPoints / conversionRate.pointsRequired) * conversionRate.sypValue);
    }

    const lockedBalance = student.gamification?.lockedBalance || 0;
    const availableBalance = Math.max(0, totalBalance - lockedBalance);
    const totalBalanceUsed = student.gamification?.totalBalanceUsed || 0;

    res.json({
      success: true,
      balanceInfo: {
        points: studentPoints,
        totalBalance,
        lockedBalance,
        availableBalance,
        totalBalanceUsed,
        conversionRate
      }
    });

  } catch (error) {
    console.error('Get balance info error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
