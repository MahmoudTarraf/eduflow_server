// utils/sendEmail.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const MAILERSEND_API_KEY = process.env.EMAIL_API_KEY; // <-- set in .env or platform env
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@yourdomain.com';
const FROM_NAME = process.env.FROM_NAME || 'EduFlow Academy';

/**
 * initTransporter - runtime check to ensure API key present.
 * kept so index.js startup call (await initTransporter()) still works.
 */
async function initTransporter() {
  if (!MAILERSEND_API_KEY) {
    console.warn('[Email] WARNING: MAILERSEND API key (EMAIL_API_KEY) is not set. Emails will fail until you set it.');
  } else {
    console.log('[Email] MailerSend API key present.');
  }
  return Promise.resolve();
}

/**
 * Send an email using MailerSend API
 * @param {Object} options
 * @param {string} options.email - recipient
 * @param {string} options.subject
 * @param {string} options.message - plain text
 * @param {string} options.html - optional HTML content
 * @param {Array} options.attachments - [{ filename, path/content }]
 */
async function sendEmail(options) {
  
  if (!MAILERSEND_API_KEY) {
    const err = new Error('EMAIL_API_KEY not configured (process.env.EMAIL_API_KEY missing)');
    console.error('[Email] ❌', err.message);
    throw err;
  }

  try {
    const data = {
      from: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: options.email }],
      subject: options.subject,
      text: options.message || '',
      html: options.html || undefined,
      attachments: (options.attachments || []).map(att => {
        let contentBase64;
        if (att.path) {
          contentBase64 = fs.readFileSync(att.path, { encoding: 'base64' });
        } else if (att.content) {
          contentBase64 = Buffer.from(att.content).toString('base64');
        } else {
          throw new Error('Attachment must have path or content');
        }
        return { content: contentBase64, filename: att.filename };
      })
    };

    const response = await axios.post('https://api.mailersend.com/v1/email', data, {
      headers: {
        Authorization: `Bearer ${MAILERSEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[Email] ✅ Sent to ${options.email}: ${response.data.message_id || 'no-id'}`);
    return response.data;
  } catch (err) {
    // show MailerSend response body when available for easier debugging
    console.error(`[Email] ❌ Failed to send to ${options.email}:`, err.response?.data || err.message);
    throw err;
  }
}

module.exports = { initTransporter, sendEmail };