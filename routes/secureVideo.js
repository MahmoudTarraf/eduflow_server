const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { createPlaybackSession } = require('../controllers/secureVideoController');

// Create a secure playback session for a YouTube-based lecture
// POST /api/secure/video/:contentId/session
router.post('/video/:contentId/session', protect, createPlaybackSession);

module.exports = router;
