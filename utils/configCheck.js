function checkConfig() {
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return; // Warn in development only

  const warnings = [];

  if (!process.env.JWT_SECRET) {
    warnings.push('JWT_SECRET is missing. Using any fallback secret in development is insecure and should never be used in production.');
  }

  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    warnings.push('ADMIN_EMAIL or ADMIN_PASSWORD is missing. Admin bootstrap will be skipped and you may lock yourself out of admin features.');
  }

  if (!process.env.MAX_VIDEO_SIZE_MB || !process.env.MAX_FILE_SIZE_MB) {
    warnings.push('File size limits not fully configured (MAX_VIDEO_SIZE_MB, MAX_FILE_SIZE_MB). Defaults will be used; set explicit limits for production.');
  }

  if (warnings.length) {
    console.warn('--- Config Sanity Warnings (development) ---');
    for (const w of warnings) console.warn('•', w);
    console.warn('-------------------------------------------');
  }
}

function enforceCriticalConfig() {
  // Enforce 2FA encryption key validity in all environments; fail hard in production
  const key = process.env.TWOFA_ENCRYPTION_KEY;
  const fail = (msg) => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    } else {
      console.warn('--- Critical Config Warning ---');
      console.warn(msg);
      console.warn('-------------------------------');
    }
  };

  if (!key) {
    fail('TWOFA_ENCRYPTION_KEY is missing. Set a 32-byte key (base64 or utf8).');
    return;
  }
  try {
    let buf;
    // Heuristic: treat as base64 if valid base64 charset and length is multiple of 4
    const isB64 = /^[A-Za-z0-9+/=]+$/.test(key) && key.length % 4 === 0;
    buf = isB64 ? Buffer.from(key, 'base64') : Buffer.from(key);
    if (!Buffer.isBuffer(buf) || buf.length < 32) {
      fail('TWOFA_ENCRYPTION_KEY must be at least 32 bytes (after decoding).');
    }
  } catch (e) {
    fail('TWOFA_ENCRYPTION_KEY is invalid (decode failed).');
  }
}

module.exports = { checkConfig, enforceCriticalConfig };
