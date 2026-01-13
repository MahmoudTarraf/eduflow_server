const express = require('express');
const { protectAllowQuery } = require('../middleware/auth');
const { streamVideo } = require('../controllers/videoController');

const router = express.Router();

router.get('/:videoId', protectAllowQuery, streamVideo);

module.exports = router;
