const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const User = require('../models/User');

// @desc    Get instructor settings (payout settings)
// @route   GET /api/instructor/settings
// @access  Private (Instructor)
router.get('/settings', protect, authorize('instructor'), async (req, res) => {
  try {
    const instructor = await User.findById(req.user.id).select('instructorPayoutSettings paymentReceivers');
    
    if (!instructor) {
      return res.status(404).json({
        success: false,
        message: 'Instructor not found'
      });
    }

    // Combine both receiver systems for compatibility
    const payoutSettings = instructor.instructorPayoutSettings || {};
    const receiverDetails = instructor.paymentReceivers || payoutSettings.receiverDetails || [];

    res.json({
      success: true,
      data: {
        minimumPayout: payoutSettings.minimumPayout || 1000,
        receiverDetails: receiverDetails
      }
    });
  } catch (error) {
    console.error('Get instructor settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings'
    });
  }
});

// @desc    Get instructor payment receivers
// @route   GET /api/instructor/payment-receivers
// @access  Private (Instructor)
router.get('/payment-receivers', protect, authorize('instructor'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Return payment receivers from user profile
    // Note: You'll need to add a paymentReceivers field to the User model
    const receivers = user.paymentReceivers || [];
    
    res.json({
      success: true,
      data: receivers
    });
  } catch (error) {
    console.error('Get payment receivers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Update instructor payment receivers
// @route   PUT /api/instructor/payment-receivers
// @access  Private (Instructor)
router.put('/payment-receivers', protect, authorize('instructor'), async (req, res) => {
  try {
    const { paymentReceivers } = req.body;
    
    if (!Array.isArray(paymentReceivers)) {
      return res.status(400).json({
        success: false,
        message: 'paymentReceivers must be an array'
      });
    }

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Clean payment receivers: remove invalid _id fields (like timestamps)
    // Mongoose will auto-generate valid ObjectIds for subdocuments
    const cleanedReceivers = paymentReceivers.map(receiver => {
      const { _id, ...rest } = receiver;
      // Only keep _id if it's a valid 24-character hex string (MongoDB ObjectId format)
      if (_id && /^[0-9a-fA-F]{24}$/.test(_id.toString())) {
        return receiver;
      }
      // Remove invalid _id, let Mongoose generate a new one
      return rest;
    });

    // Update payment receivers
    user.paymentReceivers = cleanedReceivers;
    await user.save();
    
    res.json({
      success: true,
      message: 'Payment receivers updated successfully',
      data: user.paymentReceivers
    });
  } catch (error) {
    console.error('Update payment receivers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
