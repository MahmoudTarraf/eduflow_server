const express = require('express');
const router = express.Router();

// public route to ping server
router.get('/', async (req, res) => {
    return res.status(200).json({
        success: true,
        message: 'server is up!'
    });
});


module.exports = router;