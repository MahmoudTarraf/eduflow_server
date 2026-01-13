const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getEarningsSummary,
  listEarnings,
  getEarningsByCourse,
  getAvailableBalance,
  getEarningsByStudent,
  exportEarnings,
  getDetailedEarningsForAdmin,
  exportDetailedEarnings
} = require('../controllers/instructorEarnings');

// Admin routes (must come before instructor routes)
router.post('/admin/detailed-list', protect, authorize('admin'), getDetailedEarningsForAdmin);
router.post('/admin/export-detailed', protect, authorize('admin'), exportDetailedEarnings);

// Instructor routes
router.use(protect);
router.use(authorize('instructor'));

router.get('/summary', getEarningsSummary);
router.post('/list', listEarnings);
router.get('/by-course', getEarningsByCourse);
router.get('/available-balance', getAvailableBalance);
router.get('/by-student/:courseId', getEarningsByStudent);
router.post('/export', exportEarnings);

module.exports = router;
