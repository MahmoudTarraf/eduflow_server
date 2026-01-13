const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Course = require('../models/Course');
const { protect, authorize } = require('../middleware/auth');

// @desc    Get user's wishlist
// @route   GET /api/wishlist
// @access  Private (Student)
router.get('/', protect, authorize('student'), async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate({
        path: 'wishlist',
        populate: {
          path: 'instructor',
          select: 'name avatar'
        }
      });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      wishlist: user.wishlist || []
    });
  } catch (error) {
    console.error('Get wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Add course to wishlist
// @route   POST /api/wishlist/:courseId
// @access  Private (Student)
router.post('/:courseId', protect, authorize('student'), async (req, res) => {
  try {
    const { courseId } = req.params;

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Get user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if already in wishlist
    if (user.wishlist && user.wishlist.includes(courseId)) {
      return res.status(400).json({
        success: false,
        message: 'Course already in wishlist'
      });
    }

    // Add to wishlist
    if (!user.wishlist) {
      user.wishlist = [];
    }
    user.wishlist.push(courseId);
    await user.save();

    res.json({
      success: true,
      message: 'Course added to wishlist',
      wishlist: user.wishlist
    });
  } catch (error) {
    console.error('Add to wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Remove course from wishlist
// @route   DELETE /api/wishlist/:courseId
// @access  Private (Student)
router.delete('/:courseId', protect, authorize('student'), async (req, res) => {
  try {
    const { courseId } = req.params;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove from wishlist
    if (user.wishlist) {
      user.wishlist = user.wishlist.filter(id => id.toString() !== courseId);
      await user.save();
    }

    res.json({
      success: true,
      message: 'Course removed from wishlist',
      wishlist: user.wishlist
    });
  } catch (error) {
    console.error('Remove from wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @desc    Check if course is in wishlist
// @route   GET /api/wishlist/check/:courseId
// @access  Private (Student)
router.get('/check/:courseId', protect, authorize('student'), async (req, res) => {
  try {
    const { courseId } = req.params;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isInWishlist = user.wishlist && user.wishlist.some(id => id.toString() === courseId);

    res.json({
      success: true,
      isInWishlist
    });
  } catch (error) {
    console.error('Check wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
