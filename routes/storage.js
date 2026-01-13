const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getStorageConfig } = require('../controllers/storageConfigController');

// Expose current storage provider configuration to authenticated clients
router.get('/config', protect, getStorageConfig);

module.exports = router;
