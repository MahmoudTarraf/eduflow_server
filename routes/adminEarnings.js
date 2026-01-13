const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getEarningsSummary,
  listEarnings,
  getEarningsByCourse,
  getEarningsByInstructor,
  exportEarnings
} = require('../controllers/adminEarnings');

// All routes require admin authentication
router.use(protect);
router.use(authorize('admin'));

router.get('/summary', getEarningsSummary);
router.post('/list', listEarnings);
router.get('/by-course', getEarningsByCourse);
router.get('/by-instructor', getEarningsByInstructor);
router.post('/export', exportEarnings);

module.exports = router;
