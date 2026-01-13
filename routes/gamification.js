const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getPointSettings,
  updatePointSettings,
  awardPoints,
  updateStreak,
  getMyStats,
  getLeaderboard,
  getAllBadges,
  createBadge,
  updateBadge,
  deleteBadge,
  updateConversionSettings,
  getMyAchievements,
  updateLastShownStreak,
  getPublicStudentStats
} = require('../controllers/gamification');

// Point settings (Admin only)
router.get('/settings', protect, authorize('admin'), getPointSettings);
router.put('/settings', protect, authorize('admin'), updatePointSettings);

// Conversion settings (Admin only)
router.put('/conversion-settings', protect, authorize('admin'), updateConversionSettings);

// Award points (System use - can be called by instructors or automated)
router.post('/award-points', protect, awardPoints);

// Streak tracking (Student)
router.post('/update-streak', protect, authorize('student'), updateStreak);
router.post('/update-last-shown-streak', protect, authorize('student'), updateLastShownStreak);

// Student stats
router.get('/my-stats', protect, authorize('student'), getMyStats);
router.get('/my-achievements', protect, authorize('student'), getMyAchievements);

// Leaderboard (now accessible to students too)
router.get('/leaderboard', protect, authorize('admin', 'instructor', 'student'), getLeaderboard);

// Public student stats for leaderboard modal
router.get('/student/:id/public-stats', protect, authorize('admin', 'instructor', 'student'), getPublicStudentStats);

// Badge management (Admin only)
router.get('/badges', protect, authorize('admin'), getAllBadges);
router.post('/badges', protect, authorize('admin'), createBadge);
router.put('/badges/:id', protect, authorize('admin'), updateBadge);
router.delete('/badges/:id', protect, authorize('admin'), deleteBadge);

// Title-based gamification has been removed; corresponding routes are deprecated and deleted.

module.exports = router;
