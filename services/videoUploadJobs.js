const { randomUUID } = require('crypto');

const jobs = new Map();

function now() {
  return new Date();
}

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function createJob({ id, ownerId, totalBytes, replaceIfExists = true }) {
  const jobId = id ? String(id) : randomUUID();

  const existing = jobs.get(jobId);
  if (existing) {
    if (existing.canceled || existing.status === 'canceled') {
      const err = new Error('Upload session was canceled');
      err.code = 'UPLOAD_SESSION_CANCELED';
      throw err;
    }

    const isInProgress =
      existing.status === 'queued' ||
      existing.status === 'uploading' ||
      existing.status === 'canceling';

    if (isInProgress || !replaceIfExists) {
      const err = new Error('Upload session already exists');
      err.code = 'UPLOAD_SESSION_EXISTS';
      throw err;
    }

    jobs.delete(jobId);
  }

  const job = {
    id: jobId,
    ownerId: ownerId ? String(ownerId) : null,
    status: 'queued',
    bytesUploaded: 0,
    totalBytes: typeof totalBytes === 'number' && totalBytes > 0 ? totalBytes : null,
    percent: 0,
    error: null,
    contentId: null,
    canceled: false,
    createdAt: now(),
    updatedAt: now(),
    _abortController: null,
    _cleanup: null
  };

  jobs.set(jobId, job);

  // Best-effort cleanup to avoid leaking memory if client never polls again.
  setTimeout(() => {
    const current = jobs.get(jobId);
    if (!current) return;
    if (current.status === 'uploading' || current.status === 'queued' || current.status === 'canceling') return;
    jobs.delete(jobId);
  }, 30 * 60 * 1000);

  return job;
}

function getJob(jobId) {
  return jobs.get(String(jobId)) || null;
}

function updateJob(jobId, patch) {
  const job = getJob(jobId);
  if (!job) return null;

  const isCanceled = job.canceled || job.status === 'canceled' || job.status === 'canceling';
  if (isCanceled) {
    const safePatch = {};
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'error')) {
      safePatch.error = patch.error;
    }
    if (patch && patch.status === 'canceled') {
      safePatch.status = 'canceled';
    }
    Object.assign(job, safePatch);
    job.updatedAt = now();
    return job;
  }

  Object.assign(job, patch);
  job.updatedAt = now();

  if (patch && Object.prototype.hasOwnProperty.call(patch, 'percent')) {
    job.percent = clampPercent(job.percent);
  }

  return job;
}

function attachJobRuntime(jobId, { abortController, cleanup }) {
  const job = getJob(jobId);
  if (!job) return null;
  job._abortController = abortController || null;
  job._cleanup = typeof cleanup === 'function' ? cleanup : null;
  return job;
}

async function cancelJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
    return job;
  }

  job.canceled = true;
  job.status = 'canceling';
  job.updatedAt = now();

  try {
    if (job._abortController) {
      job._abortController.abort();
    }
  } catch (_) {}

  try {
    if (job._cleanup) {
      await job._cleanup();
    }
  } catch (_) {}

  job.status = 'canceled';
  job.updatedAt = now();

  return job;
}

function toPublicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    percent: job.percent,
    bytesUploaded: job.bytesUploaded,
    totalBytes: job.totalBytes,
    error: job.error,
    contentId: job.contentId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  attachJobRuntime,
  cancelJob,
  toPublicJob
};
