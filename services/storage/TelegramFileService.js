const fs = require('fs');
const https = require('https');
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const zlib = require('zlib');
const { streamTelegramFile } = require('../telegramFileService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getTelegramBotToken = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const getTelegramChannelId = () => String(process.env.TELEGRAM_CHANNEL_ID || '').trim();

const getMaxTelegramUploadBytes = () => {
  const mb = Number.parseInt(process.env.TELEGRAM_MAX_UPLOAD_MB || '50', 10);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 50;
  return safeMb * 1024 * 1024;
};

const isAbortError = (err) => {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'UPLOAD_CANCELED') return true;
  if (err.code === 'ABORT_ERR') return true;
  if (err.code === 'ERR_CANCELED') return true;
  const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return msg.includes('aborted') || msg.includes('abort');
};

const buildPublicUploadError = (internal, details = {}) => {
  const err = new Error('Upload failed. Please try again.');
  err.code = 'UPLOAD_FAILED';
  err.cause = {
    message: internal?.message,
    status: internal?.status,
    telegram: internal?.telegram,
    ...details
  };
  return err;
};

const parseJsonSafely = (data) => {
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
};

const sanitizeFilenameForMultipart = (value) => {
  const raw = String(value || 'file');
  let name = raw;
  try {
    name = name.normalize('NFKD');
  } catch (_) {
    name = raw;
  }

  name = name
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\u001f-\u007f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();

  if (!name) return 'file';
  return name.length > 150 ? name.slice(-150) : name;
};

const validateTelegramToken = async (token) => {
  if (!token) return false;

  const url = `https://api.telegram.org/bot${token}/getMe`;
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const json = parseJsonSafely(data);
        resolve(Boolean(json?.ok));
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
};

function buildTelegramFileMeta(fileId, originalName, mimeType, size, context = {}) {
  if (!fileId) {
    throw new Error('TelegramFileService.buildTelegramFileMeta requires fileId');
  }

  return {
    storageType: 'telegram',
    telegramFileId: fileId,
    telegramMessageId: context.telegramMessageId ?? undefined,
    telegramChatId: context.telegramChatId ?? undefined,
    telegramFileName: originalName || undefined,
    originalName: originalName || undefined,
    mimeType: mimeType || undefined,
    size: size || undefined,
    uploadedAt: new Date(),
    uploadedBy: context.userId || context.uploadedBy || undefined
  };
}

async function sendDocumentToTelegram(file, context = {}) {
  const token = getTelegramBotToken();
  const channelId = getTelegramChannelId();

  if (!token || !channelId) {
    throw buildPublicUploadError(new Error('Telegram token or channel is not configured'), {
      code: 'TELEGRAM_MISCONFIGURED'
    });
  }

  if (!file || !file.path) {
    throw buildPublicUploadError(new Error('File path missing'), { code: 'FILE_MISSING' });
  }

  const maxBytes = getMaxTelegramUploadBytes();
  const totalBytes = typeof file.size === 'number' && file.size > 0
    ? file.size
    : (() => {
        try {
          return fs.statSync(file.path).size;
        } catch (_) {
          return null;
        }
      })();

  if (typeof totalBytes === 'number' && totalBytes > maxBytes) {
    throw buildPublicUploadError(new Error('File exceeds Telegram upload limit'), {
      code: 'FILE_TOO_LARGE',
      maxBytes,
      totalBytes
    });
  }

  const contentType = file.mimetype || 'application/octet-stream';
  const filename = sanitizeFilenameForMultipart(file.originalname || 'file');
  const boundary = `----EduFlowTg${Date.now().toString(16)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const chatPart = `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="chat_id"\r\n\r\n' +
    `${channelId}\r\n`;
  const fileHeader = `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const makeAttempt = async () => {
    return new Promise((resolve, reject) => {
      let settled = false;

      const abortSignal = context?.abortSignal || null;
      const onProgress = typeof context?.onProgress === 'function' ? context.onProgress : null;
      const startedAt = Date.now();
      let lastProgressAt = 0;
      let uploadedBytes = 0;

      const options = {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendDocument`,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Accept': 'application/json',
          'User-Agent': 'EduFlowTelegramFileService/1.0'
        }
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;

          const raw = Buffer.concat(chunks);
          const contentEncoding = String(res.headers?.['content-encoding'] || '').toLowerCase();
          const contentTypeHeader = String(res.headers?.['content-type'] || '').toLowerCase();

          if (!raw || raw.length === 0) {
            const headerSnapshot = {
              server: res.headers?.server,
              date: res.headers?.date,
              contentLength: res.headers?.['content-length'],
              contentType: res.headers?.['content-type'],
              contentEncoding: res.headers?.['content-encoding']
            };
            return reject(buildPublicUploadError(new Error('Telegram returned an empty response body'), {
              status: res.statusCode,
              statusMessage: res.statusMessage,
              code: 'UPSTREAM_EMPTY_BODY',
              contentEncoding,
              contentType: contentTypeHeader,
              bodySnippet: '',
              headers: headerSnapshot
            }));
          }

          let decoded = raw;
          try {
            if (contentEncoding === 'gzip') decoded = zlib.gunzipSync(raw);
            else if (contentEncoding === 'deflate') decoded = zlib.inflateSync(raw);
            else if (contentEncoding === 'br' && typeof zlib.brotliDecompressSync === 'function') {
              decoded = zlib.brotliDecompressSync(raw);
            }
          } catch (decodeErr) {
            const snippet = raw.toString('utf8', 0, Math.min(raw.length, 500));
            return reject(buildPublicUploadError(new Error('Telegram response could not be decoded'), {
              status: res.statusCode,
              code: 'UPSTREAM_DECODE_FAILED',
              contentEncoding,
              contentType: contentTypeHeader,
              bodySnippet: snippet
            }));
          }

          const text = decoded.toString('utf8');
          const json = parseJsonSafely(text);
          if (!json || typeof json !== 'object') {
            const snippet = text.slice(0, 500);
            return reject(buildPublicUploadError(new Error('Telegram response was not valid JSON'), {
              status: res.statusCode,
              code: 'UPSTREAM_INVALID_JSON',
              contentEncoding,
              contentType: contentTypeHeader,
              bodySnippet: snippet
            }));
          }

          if (!json.ok) {
            const internal = new Error(json.description || 'Telegram upload failed');
            internal.status = json.error_code || res.statusCode;
            internal.telegram = { error_code: json.error_code, description: json.description };
            return reject(buildPublicUploadError(internal, { status: internal.status }));
          }

          const fileId = json.result?.document?.file_id;
          const messageId = json.result?.message_id;
          const chatId = json.result?.chat?.id;
          if (!fileId) {
            return reject(buildPublicUploadError(new Error('Telegram response missing document.file_id')));
          }

          resolve({
            fileId,
            messageId: typeof messageId === 'number' ? messageId : undefined,
            chatId: chatId !== undefined && chatId !== null ? String(chatId) : undefined,
            mimeType: contentType,
            size: typeof totalBytes === 'number' ? totalBytes : file.size
          });
        });
      });

      const finishWithError = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      req.on('error', (err) => {
        finishWithError(buildPublicUploadError(err));
      });

      req.setTimeout(10 * 60 * 1000, () => {
        const err = new Error('Upstream upload timed out');
        err.code = 'ETIMEDOUT';
        try {
          req.destroy(err);
        } catch (_) {}
      });

      const readStream = fs.createReadStream(file.path);
      const progressStream = new Transform({
        transform(chunk, enc, cb) {
          uploadedBytes += chunk.length;

          if (onProgress && typeof totalBytes === 'number' && totalBytes > 0) {
            const now = Date.now();
            if (now - lastProgressAt >= 200 || uploadedBytes >= totalBytes) {
              lastProgressAt = now;
              const rawPercent = Math.ceil((uploadedBytes * 100) / totalBytes);
              const percent = uploadedBytes >= totalBytes ? 100 : Math.min(99, Math.max(0, rawPercent));
              try {
                onProgress({
                  uploadedBytes,
                  totalBytes,
                  percent,
                  elapsedMs: now - startedAt
                });
              } catch (_) {}
            }
          }

          cb(null, chunk);
        }
      });

      const onAbort = () => {
        const err = new Error('Upload canceled');
        err.name = 'AbortError';
        err.code = 'UPLOAD_CANCELED';
        try {
          readStream.destroy(err);
        } catch (_) {}
        try {
          req.destroy(err);
        } catch (_) {}
        finishWithError(err);
      };

      if (abortSignal && typeof abortSignal.addEventListener === 'function') {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      readStream.on('error', (err) => {
        finishWithError(buildPublicUploadError(err));
      });
      progressStream.on('error', (err) => {
        finishWithError(buildPublicUploadError(err));
      });

      try {
        req.write(chatPart);
        req.write(fileHeader);
      } catch (err) {
        finishWithError(buildPublicUploadError(err));
        return;
      }

      readStream.pipe(progressStream).pipe(req, { end: false });

      progressStream.on('end', () => {
        try {
          req.write(fileFooter);
          req.end();
        } catch (err) {
          finishWithError(buildPublicUploadError(err));
        }
      });
    });
  };

  const isRetryable = async (err) => {
    if (!err) return false;
    if (isAbortError(err)) return false;
    if (err?.cause?.code === 'UPSTREAM_EMPTY_BODY') return true;
    if (err?.cause?.code === 'UPSTREAM_INVALID_JSON') return true;
    if (err?.cause?.code === 'UPSTREAM_DECODE_FAILED') return true;
    const status = err?.cause?.status || err?.status;
    const upstreamStatus = typeof status === 'number' ? status : null;
    if ([408, 429, 500, 502, 503, 504].includes(upstreamStatus)) return true;
    if (upstreamStatus === 401) {
      const ok = await validateTelegramToken(token);
      return ok;
    }
    const code = err?.cause?.code || err?.code;
    return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
  };

  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await makeAttempt();

      if (typeof context?.onProgress === 'function' && typeof totalBytes === 'number' && totalBytes > 0) {
        try {
          context.onProgress({ uploadedBytes: totalBytes, totalBytes, percent: 100, elapsedMs: Date.now() });
        } catch (_) {}
      }

      return result;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (!(await isRetryable(err))) break;
      const base = 500;
      const exp = Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base * exp + jitter);
    }
  }

  throw lastError || buildPublicUploadError(new Error('Upload failed'));
}

async function uploadLessonFile(file, context = {}) {
  let result;
  try {
    result = await sendDocumentToTelegram(file, context);
    return buildTelegramFileMeta(result.fileId, file.originalname, result.mimeType, result.size, {
      ...context,
      telegramMessageId: result.messageId,
      telegramChatId: result.chatId
    });
  } finally {
    try {
      if (file?.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (err) {
      console.error('[TelegramFileService] Failed to delete temp file after upload:', err.message);
    }
  }
}

async function uploadLessonVideo() {
  throw new Error('TelegramFileService.uploadLessonVideo is not supported');
}

async function getLessonFile(fileMeta, res, options = {}) {
  if (!fileMeta || !fileMeta.telegramFileId) {
    throw new Error('TelegramFileService.getLessonFile requires fileMeta.telegramFileId');
  }

  return streamTelegramFile(fileMeta.telegramFileId, res, options);
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
