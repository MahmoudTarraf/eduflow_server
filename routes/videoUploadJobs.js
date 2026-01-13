const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getJob,
  cancelJob,
  toPublicJob,
  createJob
} = require('../services/videoUploadJobs');

router.use(protect);

router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = getJob(jobId);

    if (!job) {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    const isOwner = String(job.ownerId) === String(req.user.id || req.user._id);
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    return res.json({ success: true, data: toPublicJob(job) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch upload status' });
  }
});

router.post('/:jobId/cancel', async (req, res) => {
  try {
    const { jobId } = req.params;
    let job = getJob(jobId);

    // If the job hasn't been created yet (client canceled very quickly), create a placeholder
    // job and cancel it immediately. This prevents the later upload handler from starting.
    if (!job) {
      try {
        createJob({ id: jobId, ownerId: req.user.id || req.user._id, totalBytes: null, replaceIfExists: true });
      } catch (_) {}
      job = getJob(jobId);
    }

    if (!job) {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    const isOwner = String(job.ownerId) === String(req.user.id || req.user._id);
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const canceled = await cancelJob(jobId);
    return res.json({ success: true, data: toPublicJob(canceled) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to cancel upload' });
  }
});

module.exports = router;
