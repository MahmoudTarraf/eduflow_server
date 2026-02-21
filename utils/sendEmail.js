// emailService.js
const nodemailer = require('nodemailer');

let transporter;
let verified = false;
let lastVerified = null;
const VERIFY_INTERVAL = 5 * 60 * 1000; // 5 minutes

const initTransporter = async () => {
  const now = Date.now();

  // Reuse verified transporter
  if (transporter && verified && lastVerified && (now - lastVerified) < VERIFY_INTERVAL) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    secure: process.env.EMAIL_SECURE === 'true', // false for 587
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },

    pool: true,
    maxConnections: 5,
    maxMessages: 100,

    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,

    tls: {
      minVersion: 'TLSv1.2',
    },
  });

  transporter.on('error', (err) => {
    console.error('[Email] Transporter error:', err.message);
    verified = false;
  });

  try {
    await transporter.verify();
    verified = true;
    lastVerified = Date.now();
    console.log('[Email] SMTP verified (MailerSend)');
  } catch (err) {
    verified = false;
    console.error('[Email] SMTP verify failed:', err.message);
  }

  return transporter;
};

const sendEmail = async (options, retries = 2) => {
  try {
    if (!transporter || !verified) {
      await initTransporter();
    }

    const message = {
      from: `${process.env.FROM_NAME} <${process.env.FROM_EMAIL}>`,
      to: options.email,
      subject: options.subject,
      text: options.message || undefined,
      html: options.html || undefined,
      attachments: options.attachments || undefined,
    };

    const info = await transporter.sendMail(message);
    console.log(`[Email] ✅ Sent to ${options.email}: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`[Email] ❌ Failed to send to ${options.email}:`, error.message);

    if (
      retries > 0 &&
      (
        error.code === 'ECONNECTION' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ESOCKET' ||
        error.responseCode >= 500
      )
    ) {
      console.log(`[Email] 🔄 Retrying... (${retries} left)`);
      verified = false;
      transporter = null;
      await new Promise(r => setTimeout(r, 1000));
      return sendEmail(options, retries - 1);
    }

    throw error;
  }
};

module.exports = { sendEmail, initTransporter };