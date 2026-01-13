const jwt = require('jsonwebtoken');

const DEFAULT_EXPIRES_IN = process.env.VIDEO_PLAYBACK_TOKEN_TTL || '30m';

function getSecret() {
  const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  return secret;
}

function createPlaybackToken({ userId, contentId, courseId, userName, userEmail }) {
  const secret = getSecret();
  const payload = {
    uid: String(userId),
    cid: String(contentId),
    courseId: courseId ? String(courseId) : undefined,
    userName: userName || undefined,
    userEmail: userEmail || undefined,
    aud: 'videoPlayback'
  };

  return jwt.sign(payload, secret, {
    expiresIn: DEFAULT_EXPIRES_IN
  });
}

function verifyPlaybackToken(token) {
  try {
    const secret = getSecret();
    const decoded = jwt.verify(token, secret, { audience: 'videoPlayback' });
    return { valid: true, payload: decoded };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

module.exports = {
  createPlaybackToken,
  verifyPlaybackToken
};
