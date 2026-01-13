const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/auth');
const { runCleanup, sendBackupReport, sendFullBackup, restoreFromBackup } = require('../controllers/adminMaintenance');

// Memory storage for restore uploads (no disk writes)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// All routes admin-only, manual trigger only
router.post('/maintenance/cleanup', protect, authorize('admin'), runCleanup);
router.post('/maintenance/backup-report', protect, authorize('admin'), sendBackupReport);

// Full backup (email attachment) and restore from uploaded JSON
router.post('/backup/full', protect, authorize('admin'), sendFullBackup);
router.post('/backup/restore', protect, authorize('admin'), upload.single('backup'), restoreFromBackup);

module.exports = router;
