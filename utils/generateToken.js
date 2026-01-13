const jwt = require('jsonwebtoken');

const generateToken = (id) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    // SECURITY: Fail fast if JWT secret is not configured; no fallbacks in production.
    const message = 'JWT_SECRET is not configured. Please set it in your environment variables.';
    if (process.env.NODE_ENV === 'production') {
      throw new Error(message);
    } else {
      console.warn(`[Security Warning] ${message} Using a temporary in-memory secret for development only.`);
    }
  }

  return jwt.sign({ id }, secret || 'development-insecure-secret', {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });
};

module.exports = generateToken;
