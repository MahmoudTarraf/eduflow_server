const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  '10minutemail.com',
  '10minutemail.net',
  'temp-mail.org',
  'guerrillamail.com',
  'guerrillamail.info',
  'guerrillamail.org',
  'sharklasers.com',
  'yopmail.com',
  'yopmail.net',
  'yopmail.fr',
  'maildrop.cc',
  'trashmail.com',
  'trashmail.de',
  'dispostable.com',
  'getnada.com',
  'anonaddy.me',
  'burnermail.io'
]);

function extractDomain(email) {
  if (typeof email !== 'string') return null;
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return null;
  return email.slice(atIndex + 1).toLowerCase();
}

function isDisposableEmail(email) {
  // First, try a maintained library if available (e.g. mailchecker).
  // This allows us to benefit from an up-to-date provider list while
  // still working if the package is not installed.
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const mailchecker = require('mailchecker');
    if (mailchecker && typeof mailchecker.isValid === 'function') {
      // mailchecker.isValid returns false for disposable/invalid emails.
      const isValid = mailchecker.isValid(email);
      if (!isValid) {
        return true;
      }
    }
  } catch (_) {
    // Library not installed or failed – fall back to static list below.
  }

  const domain = extractDomain(email);
  if (!domain) return true; // treat invalid emails as disposable/blocked

  if (DISPOSABLE_DOMAINS.has(domain)) return true;

  const parts = domain.split('.');
  if (parts.length > 2) {
    const root = parts.slice(-2).join('.');
    if (DISPOSABLE_DOMAINS.has(root)) return true;
  }

  return false;
}

module.exports = { isDisposableEmail };
