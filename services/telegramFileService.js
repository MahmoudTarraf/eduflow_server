const https = require('https');
const { URL } = require('url');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 50
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableTelegramError = (err) => {
  if (!err) return false;
  const code = err?.code || err?.cause?.code;
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  const status = err?.status || err?.cause?.status || err?.statusCode;
  const n = typeof status === 'number' ? status : null;
  return Boolean(n && [408, 429, 500, 502, 503, 504].includes(n));
};

const createHttpError = (message, details = {}) => {
  const e = new Error(message);
  Object.assign(e, details);
  return e;
};

if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[TelegramFileService] TELEGRAM_BOT_TOKEN is not set. Telegram file streaming will be disabled.');
}

function buildTelegramApiUrl(pathname, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });
  return url.toString();
}

function buildTelegramFileUrl(filePath) {
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}

async function resolveTelegramFilePath(fileId) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured on the server');
  }

  const url = buildTelegramApiUrl('getFile', { file_id: fileId });

  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, { agent: TELEGRAM_AGENT }, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                return reject(createHttpError('Telegram API error', { status: res.statusCode }));
              }

              const json = JSON.parse(data);
              if (!json.ok) {
                return reject(createHttpError(json.description || 'Failed to get file info from Telegram', {
                  status: json.error_code
                }));
              }
              if (!json.result || !json.result.file_path) {
                return reject(createHttpError('Telegram did not return a file_path'));
              }
              resolve(json.result.file_path);
            } catch (err) {
              reject(err);
            }
          });
        });

        req.setTimeout(30_000, () => {
          const err = new Error('Telegram API request timed out');
          err.code = 'ETIMEDOUT';
          req.destroy(err);
        });

        req.on('error', (err) => {
          reject(err);
        });
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      if (!isRetryableTelegramError(err)) break;
      await sleep(300 * attempt);
    }
  }

  throw lastErr;
}

async function streamTelegramFile(fileId, res, options = {}) {
  const sendError = (status, message) => {
    if (!res.headersSent) {
      res.status(status).json({ success: false, message });
    } else {
      try {
        res.end();
      } catch (_) {}
    }
  };

  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const filePath = await resolveTelegramFilePath(fileId);
      const fileUrl = buildTelegramFileUrl(filePath);

      await new Promise((resolve, reject) => {
        let settled = false;
        let fileRes = null;

        const req = https.get(
          fileUrl,
          {
            agent: TELEGRAM_AGENT,
            headers: {
              'Accept': '*/*',
              'User-Agent': 'EduFlowTelegramFileStream/1.0'
            }
          },
          (upstreamRes) => {
            fileRes = upstreamRes;

            if (fileRes.statusCode !== 200) {
              const err = createHttpError('Unexpected status from Telegram file endpoint', {
                status: fileRes.statusCode || 502
              });
              try {
                fileRes.resume();
              } catch (_) {}
              return reject(err);
            }

            const setHeaders = () => {
              if (res.headersSent) return;
              if (fileRes.headers['content-type']) {
                res.setHeader('Content-Type', fileRes.headers['content-type']);
              }
              if (fileRes.headers['content-length']) {
                res.setHeader('Content-Length', fileRes.headers['content-length']);
              }
              if (options.asAttachment && options.filename) {
                res.setHeader('Content-Disposition', `attachment; filename="${options.filename}"`);
              }
            };

            let hasWritten = false;

            const onFirstChunk = (chunk) => {
              if (settled) return;
              setHeaders();
              hasWritten = true;
              try {
                res.write(chunk);
              } catch (e) {
                return reject(e);
              }
              fileRes.pipe(res);
            };

            fileRes.once('data', onFirstChunk);

            fileRes.on('end', () => {
              if (settled) return;
              settled = true;
              if (!hasWritten) {
                setHeaders();
                try {
                  res.end();
                } catch (_) {}
              }
              resolve();
            });

            fileRes.on('error', (err) => {
              if (settled) return;
              settled = true;
              if (hasWritten || res.headersSent) {
                try {
                  res.end();
                } catch (_) {}
              }
              reject(err);
            });
          }
        );

        req.setTimeout(5 * 60 * 1000, () => {
          const err = new Error('Telegram file download timed out');
          err.code = 'ETIMEDOUT';
          req.destroy(err);
        });

        res.once('close', () => {
          try {
            req.destroy();
          } catch (_) {}
          try {
            if (fileRes) fileRes.destroy();
          } catch (_) {}
        });

        req.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      });

      return;
    } catch (err) {
      lastErr = err;
      if (res.headersSent) {
        return;
      }
      if (attempt >= maxAttempts || !isRetryableTelegramError(err)) {
        const status = typeof err?.status === 'number' ? err.status : 502;
        console.error('[TelegramFileService] Error while streaming from Telegram:', err);
        return sendError(status, 'Failed to retrieve file. Please try again.');
      }
      await sleep(300 * attempt);
    }
  }

  console.error('[TelegramFileService] Error streaming file after retries:', lastErr);
  return sendError(502, 'Failed to retrieve file. Please try again.');
}

module.exports = {
  resolveTelegramFilePath,
  streamTelegramFile
};
