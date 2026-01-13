const YouTubeToken = require('../models/YouTubeToken');
const { refreshAccessToken } = require('../config/youtube');
const { encryptText, decryptText } = require('../utils/cryptoUtil');

function readTokenValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;

  // Some deployments stored encrypted payload as JSON string.
  if (typeof value === 'string') return value;

  try {
    return decryptText(value);
  } catch (_) {
    // Backward-compatible: if it isn't decryptable, treat as missing.
    return null;
  }
}

function writeTokenValue(value) {
  if (!value) return null;
  try {
    return encryptText(value);
  } catch (_) {
    // In non-production, cryptoUtil can fall back to plain mode.
    return value;
  }
}

async function ensureValidYouTubeToken(options = {}) {
  const { forceRefresh = false, bufferMs = 5 * 60 * 1000 } = options;

  const tokenDoc = await YouTubeToken.findOne({ owner: 'platform' });

  if (!tokenDoc) {
    const err = new Error('YouTube is not configured. Please authorize the platform YouTube account.');
    err.code = 'YT_NOT_CONFIGURED';
    throw err;
  }

  const now = Date.now();
  const expiresSoon = !tokenDoc.expiryDate || tokenDoc.expiryDate < now + bufferMs;

  if (forceRefresh || expiresSoon) {
    try {
      const refreshToken = readTokenValue(tokenDoc.refreshToken);
      if (!refreshToken) {
        const err = new Error('YouTube token refresh failed. Admin action required.');
        err.code = 'YT_REFRESH_FAILED';
        throw err;
      }

      const newTokens = await refreshAccessToken(refreshToken);
      tokenDoc.accessToken = writeTokenValue(newTokens.access_token);
      tokenDoc.expiryDate = newTokens.expiry_date;

      // Mark as connected once refresh succeeds.
      try {
        tokenDoc.connectionStatus = 'CONNECTED';
      } catch (_) {}

      await tokenDoc.save();
    } catch (cause) {
      const err = new Error('YouTube token refresh failed. Admin action required.');
      err.code = 'YT_REFRESH_FAILED';
      err.cause = cause;

      try {
        tokenDoc.connectionStatus = 'REAUTH_REQUIRED';
        await tokenDoc.save();
      } catch (_) {}

      throw err;
    }
  }

  // Return a safe doc with decrypted token strings attached for server-side callers.
  // This avoids leaking encrypted payloads into config/youtube.setCredentials.
  const result = tokenDoc;
  result.accessToken = readTokenValue(tokenDoc.accessToken);
  result.refreshToken = readTokenValue(tokenDoc.refreshToken);
  return result;
}

module.exports = { ensureValidYouTubeToken };
