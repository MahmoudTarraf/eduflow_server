const crypto = require('crypto');

function getKey() {
  const key = process.env.TWOFA_ENCRYPTION_KEY;
  if (!key) return null;
  // Accept base64 or utf8; normalize to 32 bytes
  const buf = Buffer.from(key.length === 44 ? key : Buffer.from(key).toString('base64'), 'base64');
  return buf.slice(0, 32); // AES-256
}

function encryptText(plain) {
  const key = getKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TWOFA_ENCRYPTION_KEY not set');
    }
    return { mode: 'plain', value: plain };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    mode: 'gcm',
    value: Buffer.concat([iv, tag, enc]).toString('base64')
  };
}

function decryptText(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') {
    // backward-compatible plain
    return obj;
  }
  if (obj.mode === 'plain') return obj.value;
  if (obj.mode === 'gcm') {
    const key = getKey();
    if (!key) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('TWOFA_ENCRYPTION_KEY not set');
      }
      // Cannot decrypt in dev without key; treat as plain
      return obj.value;
    }
    const buf = Buffer.from(obj.value, 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }
  return null;
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

module.exports = { encryptText, decryptText, sha256 };
