// emailService.js
const nodemailer = require('nodemailer');

let transporter;
let verified = false;
let lastVerified = null;
const VERIFY_INTERVAL = 5 * 60 * 1000; // Re-verify every 5 minutes

const initTransporter = async () => {
  // Reuse existing transporter if still valid
  const now = Date.now();
  if (transporter && verified && lastVerified && (now - lastVerified) < VERIFY_INTERVAL) {
    return transporter;
  }

  // Create new transporter or recreate if needed
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT, 10) || 587,
      secure: process.env.EMAIL_SECURE === 'true' || false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
      pool: true,             // ✅ Keep connections open for reuse
      maxConnections: 5,      // Increased from 3
      maxMessages: 100,
      connectionTimeout: 10000, // Increased timeout
      greetingTimeout: 10000,
      socketTimeout: 15000,   // Increased socket timeout
      tls: { 
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      // Retry configuration
      requireTLS: false,
      debug: false,
    });

    // Handle transporter errors
    transporter.on('error', (err) => {
      console.error('[Email] Transporter error:', err.message);
      verified = false;
    });
  }

  // Verify connection
  try {
    await transporter.verify();
    verified = true;
    lastVerified = Date.now();
    console.log('[Email] SMTP verified and ready');
  } catch (err) {
    console.error('[Email] SMTP verify failed:', err.message);
    verified = false;
    // Don't throw - allow sending to be attempted anyway
  }

  return transporter;
};

const sendEmail = async (options, retries = 2) => {
  try {
    // Ensure transporter is initialized
    if (!transporter || !verified) {
      await initTransporter();
    }

    const message = {
      from: `${process.env.FROM_NAME || 'EduFlow Academy'} <${process.env.FROM_EMAIL || process.env.EMAIL_USER}>`,
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
    
    // Retry logic for transient errors
    if (retries > 0 && (
      error.code === 'ECONNECTION' || 
      error.code === 'ETIMEDOUT' || 
      error.code === 'ESOCKET' ||
      error.responseCode >= 500
    )) {
      console.log(`[Email] 🔄 Retrying... (${retries} attempts left)`);
      
      // Reset transporter for retry
      verified = false;
      transporter = null;
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return sendEmail(options, retries - 1);
    }
    
    // Re-throw if all retries exhausted or permanent error
    throw error;
  }
};

module.exports = { sendEmail, initTransporter };
