const fs = require('fs');
const { PassThrough } = require('stream');
const {
  extractYouTubeVideoId,
  normalizeYouTubeUrl
} = require('../../utils/youtubeHelper');
const {
  setCredentials,
  getYouTubeService
} = require('../../config/youtube');
const { ensureValidYouTubeToken } = require('../youtubeTokenService');
const YouTubeVideo = require('../../models/YouTubeVideo');

let undici = null;
try {
  undici = require('undici');
  if (undici?.setGlobalDispatcher && undici?.Agent) {
    undici.setGlobalDispatcher(
      new undici.Agent({
        connectTimeout: 30_000,
        headersTimeout: 300_000,
        bodyTimeout: 300_000
      })
    );
  }
} catch (_) {
  undici = null;
}

let fetchImpl = typeof fetch === 'function' ? fetch : null;
if (!fetchImpl) {
  try {
    fetchImpl = require('node-fetch');
  } catch (_) {
    fetchImpl = null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractGoogleApiReasons = (data) => {
  const reasons = [];
  const list = data?.error?.errors;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item?.reason) reasons.push(String(item.reason));
    }
  }
  const status = data?.error?.status;
  if (status) reasons.push(String(status));
  return reasons;
};

const isQuotaExceeded = (data) => {
  const reasons = extractGoogleApiReasons(data);
  const lowered = reasons.map((r) => r.toLowerCase());
  return lowered.some((r) =>
    r === 'quotaexceeded' ||
    r === 'dailylimitexceeded' ||
    r === 'userratelimitexceeded' ||
    r === 'ratelimitexceeded'
  );
};

const getUnderlyingError = (err) => {
  if (!err) return null;
  return err?.cause && typeof err.cause === 'object' ? err.cause : err;
};

const isAbortError = (err) => {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (msg.toLowerCase().includes('aborted')) return true;
  return err.code === 'ERR_CANCELED' || err.code === 'ABORT_ERR' || err.code === 'UPLOAD_CANCELED';
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 120_000) => {
  if (!fetchImpl) {
    throw new Error('Video upload failed');
  }

  const upstreamSignal = options.signal;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller ? controller.signal : upstreamSignal;

  let timeoutId;
  if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      try {
        controller.abort();
      } catch (_) {}
    }, timeoutMs);
  }

  const onAbort = () => {
    try {
      controller?.abort();
    } catch (_) {}
  };

  if (controller && upstreamSignal && typeof upstreamSignal.addEventListener === 'function') {
    if (upstreamSignal.aborted) {
      onAbort();
    } else {
      upstreamSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    return await fetchImpl(url, {
      ...options,
      signal
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (controller && upstreamSignal && typeof upstreamSignal.removeEventListener === 'function') {
      try {
        upstreamSignal.removeEventListener('abort', onAbort);
      } catch (_) {}
    }
  }
};

const RESUMABLE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const DEFAULT_CHUNK_SIZE_BYTES = 1 * 1024 * 1024;
const RESUMABLE_SESSION_TIMEOUT_MS = 120_000;
const RESUMABLE_CHUNK_TIMEOUT_MS = 180_000;

const parseRangeEnd = (rangeHeader) => {
  if (!rangeHeader) return null;
  const m = String(rangeHeader).match(/bytes=\s*(\d+)-(\d+)/i);
  if (!m) return null;
  const end = parseInt(m[2], 10);
  return Number.isFinite(end) ? end : null;
};

const safeJson = async (res) => {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
};

const requestResumableUploadSession = async ({ accessToken, totalBytes, mimeType, requestBody, abortSignal }) => {
  if (!fetchImpl) {
    throw new Error('Video upload failed');
  }

  let res;
  try {
    res = await fetchWithTimeout(RESUMABLE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        ...(Number.isFinite(totalBytes) && totalBytes > 0 ? { 'X-Upload-Content-Length': String(totalBytes) } : {})
      },
      body: JSON.stringify(requestBody),
      signal: abortSignal || undefined
    }, RESUMABLE_SESSION_TIMEOUT_MS);
  } catch (err) {
    if (isAbortError(err)) {
      const e = new Error('Upload canceled');
      e.code = 'UPLOAD_CANCELED';
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  }

  if (!res.ok) {
    const data = await safeJson(res);
    const upstreamMessage = data?.error?.message;
    const err = new Error('Video upload failed');
    if (isQuotaExceeded(data)) {
      err.code = 'YT_QUOTA_EXCEEDED';
    }
    err.status = res.status;
    err.response = { status: res.status, data };
    err.cause = upstreamMessage || data;
    throw err;
  }

  const location = res.headers.get('location');
  if (!location) {
    throw new Error('Video upload failed');
  }

  return location;
};

const putResumableChunk = async ({ uploadUrl, accessToken, chunk, start, end, totalBytes, mimeType, abortSignal }) => {
  if (!fetchImpl) {
    throw new Error('Video upload failed');
  }

  let res;
  try {
    res = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${totalBytes}`
      },
      body: chunk,
      signal: abortSignal || undefined
    }, RESUMABLE_CHUNK_TIMEOUT_MS);
  } catch (err) {
    if (isAbortError(err)) {
      const e = new Error('Upload canceled');
      e.code = 'UPLOAD_CANCELED';
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  }

  if (res.status === 308) {
    const rangeEnd = parseRangeEnd(res.headers.get('range'));
    let uploadedBytes = typeof rangeEnd === 'number' ? rangeEnd + 1 : null;

    // Some responses may omit Range; query the resumable session for the last committed byte.
    if (uploadedBytes === null) {
      try {
        const statusRes = await fetchWithTimeout(uploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': '0',
            'Content-Range': `bytes */${totalBytes}`
          },
          signal: abortSignal || undefined
        }, RESUMABLE_SESSION_TIMEOUT_MS);

        if (statusRes.status === 308) {
          const statusRangeEnd = parseRangeEnd(statusRes.headers.get('range'));
          if (typeof statusRangeEnd === 'number') {
            uploadedBytes = statusRangeEnd + 1;
          }
        } else if (statusRes.ok) {
          // Upload already finalized.
          uploadedBytes = totalBytes;
        }
      } catch (err) {
        if (isAbortError(err)) {
          const e = new Error('Upload canceled');
          e.code = 'UPLOAD_CANCELED';
          e.name = 'AbortError';
          throw e;
        }
        // Fall back to optimistic progress if status check fails.
      }
    }

    if (uploadedBytes === null) {
      // Optimistic advance to avoid infinite loop; YouTube normally commits full chunk if it returns 308.
      uploadedBytes = Math.min(totalBytes, end + 1);
    }
    return { done: false, uploadedBytes };
  }

  if (!res.ok) {
    const data = await safeJson(res);
    const upstreamMessage = data?.error?.message;
    const err = new Error('Video upload failed');
    if (isQuotaExceeded(data)) {
      err.code = 'YT_QUOTA_EXCEEDED';
    }
    err.status = res.status;
    err.response = { status: res.status, data };
    err.cause = upstreamMessage || data;
    throw err;
  }

  const data = await safeJson(res);
  return { done: true, uploadedBytes: totalBytes, data };
};

function buildYouTubeVideoMeta(youtubeInput, context = {}) {
  if (!youtubeInput) {
    throw new Error('Hosted video metadata requires a hosted video URL or ID');
  }

  const trimmed = String(youtubeInput).trim();

  let videoId = extractYouTubeVideoId(trimmed);

  if (!videoId) {
    const idPattern = /^[a-zA-Z0-9_-]{11}$/;
    if (idPattern.test(trimmed)) {
      videoId = trimmed;
    }
  }

  if (!videoId) {
    throw new Error('Invalid hosted video URL or video ID');
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const normalizedUrl = normalizeYouTubeUrl(watchUrl);

  return {
    storageType: 'youtube',
    youtubeVideoId: videoId,
    youtubeUrl: normalizedUrl,
    uploadedAt: new Date(),
    uploadedBy: context.userId || context.uploadedBy || undefined
  };
}

async function uploadFileToYouTube(file, metadata = {}, attempt = 1, runtime = {}) {
  if (!file || (!file.path && !file.buffer)) {
    throw new Error('Video file is required for video upload');
  }

  const onProgress = typeof runtime.onProgress === 'function' ? runtime.onProgress : null;
  const abortSignal = runtime.abortSignal || null;

  const isRetryable = (err) => {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    if (err.code === 'ERR_CANCELED' || err.code === 'ABORT_ERR') return false;
    const underlying = getUnderlyingError(err);
    const code = err?.code || underlying?.code;
    const name = err?.name || underlying?.name;
    const status = err?.response?.status || err?.status;
    if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
    if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
    if (
      name === 'HeadersTimeoutError' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    ) {
      return true;
    }
    return false;
  };

  const isAuthError = (err) => {
    const status = err?.response?.status || err?.status;
    return status === 401 || status === 403;
  };

  const maxAttempts = 3;
  let refreshed = false;
  let lastError;

  for (let i = attempt; i <= maxAttempts; i += 1) {
    try {
      const tokenDoc = await ensureValidYouTubeToken();

      setCredentials({
        access_token: tokenDoc.accessToken,
        refresh_token: tokenDoc.refreshToken
      });

      const totalBytes = typeof file.size === 'number' && file.size > 0
        ? file.size
        : (file.buffer ? file.buffer.length : null);

      if (!totalBytes) {
        throw new Error('Video upload failed');
      }

      const uploadUrl = await requestResumableUploadSession({
        accessToken: tokenDoc.accessToken,
        totalBytes,
        mimeType: file.mimetype,
        abortSignal,
        requestBody: {
          snippet: {
            title: metadata.title || file.originalname,
            description: metadata.description || '',
            categoryId: '27'
          },
          status: {
            privacyStatus: metadata.privacyStatus || 'unlisted',
            embeddable: true,
            selfDeclaredMadeForKids: false
          }
        }
      });

      const chunkSize = DEFAULT_CHUNK_SIZE_BYTES;
      let offset = 0;
      let lastUploadData = null;

      const reportProgress = (uploadedBytes) => {
        if (!onProgress) return;
        try {
          const safeUploaded = Math.min(totalBytes, Math.max(0, uploadedBytes));
          const rawPercent = totalBytes ? Math.ceil((safeUploaded * 100) / totalBytes) : 0;
          const percent = totalBytes
            ? (safeUploaded >= totalBytes ? 100 : Math.min(99, Math.max(0, rawPercent)))
            : 0;
          onProgress({ uploadedBytes: safeUploaded, totalBytes, percent });
        } catch (_) {}
      };

      reportProgress(0);

      if (file.buffer) {
        while (offset < totalBytes) {
          if (abortSignal?.aborted) {
            const e = new Error('Upload canceled');
            e.code = 'UPLOAD_CANCELED';
            e.name = 'AbortError';
            throw e;
          }
          const endExclusive = Math.min(offset + chunkSize, totalBytes);
          const end = endExclusive - 1;
          const chunk = file.buffer.subarray(offset, endExclusive);

          const result = await putResumableChunk({
            uploadUrl,
            accessToken: tokenDoc.accessToken,
            chunk,
            start: offset,
            end,
            totalBytes,
            mimeType: file.mimetype,
            abortSignal
          });

          reportProgress(result.uploadedBytes);
          offset = result.uploadedBytes;
          if (result.done) {
            lastUploadData = result.data;
            break;
          }
        }
      } else {
        const fd = await fs.promises.open(file.path, 'r');
        try {
          while (offset < totalBytes) {
            if (abortSignal?.aborted) {
              const e = new Error('Upload canceled');
              e.code = 'UPLOAD_CANCELED';
              e.name = 'AbortError';
              throw e;
            }
            const remaining = totalBytes - offset;
            const toRead = Math.min(chunkSize, remaining);
            const buf = Buffer.allocUnsafe(toRead);
            const { bytesRead } = await fd.read(buf, 0, toRead, offset);
            if (!bytesRead) {
              throw new Error('Video upload failed');
            }

            const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
            const end = offset + chunk.length - 1;

            const result = await putResumableChunk({
              uploadUrl,
              accessToken: tokenDoc.accessToken,
              chunk,
              start: offset,
              end,
              totalBytes,
              mimeType: file.mimetype,
              abortSignal
            });

            reportProgress(result.uploadedBytes);
            offset = result.uploadedBytes;
            if (result.done) {
              lastUploadData = result.data;
              break;
            }
          }
        } finally {
          await fd.close().catch(() => {});
        }
      }

      const videoId = lastUploadData?.id;
      if (!videoId) {
        throw new Error('Video upload failed');
      }

      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

      try {
        const existing = await YouTubeVideo.findOne({ youtubeVideoId: videoId }).select('_id');
        if (!existing) {
          const title = metadata.title || file.originalname;
          const description = metadata.description || '';

          await YouTubeVideo.create({
            title,
            description,
            youtubeVideoId: videoId,
            youtubeUrl: normalizeYouTubeUrl(youtubeUrl),
            privacyStatus: metadata.privacyStatus || 'unlisted',
            uploadedBy: metadata.userId || metadata.uploadedBy || null,
            course: metadata.courseId || null,
            section: metadata.sectionId || null,
            group: metadata.groupId || null,
            content: metadata.contentId || null,
            originalFilename: file.originalname || file.filename || 'video',
            fileSize: typeof file.size === 'number' ? file.size : null,
            status: 'active',
            statusChangedAt: new Date(),
            physicallyDeletedAt: null,
            uploadedAt: new Date()
          });
        }
      } catch (e) {
        // Do not fail uploads if we cannot persist the audit record.
        console.error('Failed to persist YouTubeVideo record:', e);
      }

      if (file.path) {
        await fs.promises.unlink(file.path).catch(() => {});
      }

      return {
        storageType: 'youtube',
        youtubeVideoId: videoId,
        youtubeUrl: normalizeYouTubeUrl(youtubeUrl),
        uploadedAt: new Date(),
        uploadedBy: metadata.userId || metadata.uploadedBy || null
      };
    } catch (error) {
      lastError = error;

      if (isAuthError(error) && !refreshed) {
        try {
          await ensureValidYouTubeToken({ forceRefresh: true });
          refreshed = true;
          continue;
        } catch (refreshErr) {
          lastError = refreshErr;
        }
      }

      const canRetry = i < maxAttempts && isRetryable(error);
      if (!canRetry) break;

      const baseDelay = 750;
      const exp = Math.pow(2, i - 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(baseDelay * exp + jitter);
    }
  }

  if (file && file.path) {
    await fs.promises.unlink(file.path).catch(() => {});
  }

  throw lastError || new Error('Video upload failed');
}

async function uploadLessonVideo(input, options = {}) {
  // File upload path (silent YouTube upload)
  if (input && input.path) {
    return uploadFileToYouTube(
      input,
      {
        title: options.title,
        description: options.description,
        privacyStatus: options.privacyStatus || 'unlisted',
        courseId: options.courseId,
        sectionId: options.sectionId,
        groupId: options.groupId,
        contentId: options.contentId,
        userId: options.userId || options.uploadedBy || options.context?.userId
      },
      1,
      {
        onProgress: options.onProgress,
        abortSignal: options.abortSignal
      }
    );
  }

  if (input && input.buffer) {
    return uploadFileToYouTube(
      input,
      {
        title: options.title,
        description: options.description,
        privacyStatus: options.privacyStatus || 'unlisted',
        courseId: options.courseId,
        sectionId: options.sectionId,
        groupId: options.groupId,
        contentId: options.contentId,
        userId: options.userId || options.uploadedBy || options.context?.userId
      },
      1,
      {
        onProgress: options.onProgress,
        abortSignal: options.abortSignal
      }
    );
  }

  // Backward-compatible URL/ID path
  const youtubeUrlOrId = options.youtubeUrlOrId || input;
  return buildYouTubeVideoMeta(youtubeUrlOrId, options.context || {});
}

async function uploadLessonFile() {
  throw new Error('YoutubeVideoService.uploadLessonFile is not supported');
}

async function getLessonFile() {
  throw new Error('YoutubeVideoService.getLessonFile is not supported');
}

async function deleteLessonFile() {
  return;
}

module.exports = {
  uploadLessonVideo,
  uploadLessonFile,
  getLessonFile,
  deleteLessonFile
};
