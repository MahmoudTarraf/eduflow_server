const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Course = require('../models/Course');
const Rating = require('../models/Rating');

// @desc    Get platform statistics
// @route   GET /api/stats
// @access  Public
router.get('/', async (req, res) => {
  try {
    // Get counts from database
    const [studentsCount, coursesCount, instructorsCount, ratings] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      Course.countDocuments({ status: 'approved' }),
      // Exclude soft-deleted instructors from public stats
      User.countDocuments({ 
        role: 'instructor', 
        instructorStatus: 'approved',
        isDeleted: { $ne: true },
        status: { $ne: 'deleted' }
      }),
      Rating.find({}).select('rating')
    ]);

    // Calculate average rating as success rate
    let successRate = 92; // Default fallback
    if (ratings.length > 0) {
      const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
      successRate = Math.round((avgRating / 5) * 100); // Convert to percentage
    }

    // Apply minimum fallbacks
    const stats = {
      students: Math.max(studentsCount, 120),
      courses: Math.max(coursesCount, 15),
      instructors: Math.max(instructorsCount, 10),
      successRate: Math.max(successRate, 92)
    };

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
