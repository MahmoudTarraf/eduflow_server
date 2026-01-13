const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getSupportedCurrencies,
  convertCurrencyAmount,
  getCurrencyCacheStats
} = require('../controllers/currency');

// Public routes
router.get('/supported', getSupportedCurrencies);
router.post('/convert', convertCurrencyAmount);

// Admin only routes
router.get('/cache-stats', protect, authorize('admin'), getCurrencyCacheStats);

module.exports = router;
