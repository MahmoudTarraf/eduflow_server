const express = require('express');
const router = express.Router();

const { protect, authorize } = require('../middleware/auth');

const {
  getTelegramFiles,
  getTelegramFilesSummary,
  downloadTelegramFile,
  updateTelegramFile,
  softDeleteTelegramFile,
  physicalDeleteTelegramFile
} = require('../controllers/adminTelegramFiles');

router.get('/', protect, authorize('admin'), getTelegramFiles);
router.get('/summary', protect, authorize('admin'), getTelegramFilesSummary);
router.get('/:id/download', protect, authorize('admin'), downloadTelegramFile);
router.patch('/:id', protect, authorize('admin'), updateTelegramFile);
router.post('/:id/soft-delete', protect, authorize('admin'), softDeleteTelegramFile);
router.delete('/:id', protect, authorize('admin'), physicalDeleteTelegramFile);

module.exports = router;
