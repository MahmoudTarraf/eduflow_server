const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const AdminLog = require('../models/AdminLog');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const SectionPayment = require('../models/SectionPayment');
const Course = require('../models/Course');
const { sendEmail } = require('../utils/sendEmail');
const { constructUploadPath, constructFileUrl } = require('../utils/urlHelper');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');

// POST /api/admin/maintenance/cleanup
// Private (Admin)
exports.runCleanup = async (req, res) => {
  try {
    const now = new Date();
    const includeOldMessages = req.body?.includeOldMessages === true || req.query?.includeOldMessages === 'true';
    const logsDays = parseInt(req.body?.logsDays || req.query?.logsDays, 10);
    const notificationsDays = parseInt(req.body?.notificationsDays || req.query?.notificationsDays, 10);

    const summary = {
      clearedResetTokens: 0,
      clearedVerificationTokens: 0,
      deletedPendingRegistrations: 'ttl_managed',
      deletedAdminLogs: 0,
      deletedMessages: 0,
      deletedNotifications: 0
    };

    // 1) Clear expired password reset OTPs on User (no deletes)
    const resetResult = await User.updateMany(
      { resetPasswordExpire: { $lte: now } },
      { $unset: { resetPasswordOTP: '', resetPasswordExpire: '' } }
    );
    summary.clearedResetTokens = resetResult.modifiedCount || 0;

    // 2) Clear stale email verification tokens on User (older than 24h)
    // We don't have a specific token timestamp; use updatedAt as approximation
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const verifyResult = await User.updateMany(
      { emailVerificationToken: { $exists: true, $ne: null }, updatedAt: { $lte: cutoff24h } },
      { $unset: { emailVerificationToken: '' } }
    );
    summary.clearedVerificationTokens = verifyResult.modifiedCount || 0;

    // 3) PendingRegistration expiration handled by TTL index; optionally force delete very old (>7d) stragglers
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await PendingRegistration.deleteMany({ createdAt: { $lte: cutoff7d } }).catch(() => {});

    // 4) Optionally delete AdminLog older than logsDays (if provided)
    if (!isNaN(logsDays) && logsDays > 0) {
      const cutoffLogs = new Date(Date.now() - logsDays * 24 * 60 * 60 * 1000);
      const delLogs = await AdminLog.deleteMany({ createdAt: { $lte: cutoffLogs } });
      summary.deletedAdminLogs = delLogs.deletedCount || 0;
    }

    // 5) Optionally delete Messages older than 60 days if explicitly allowed
    if (includeOldMessages) {
      const cutoffMsgs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const delMsgs = await Message.deleteMany({ createdAt: { $lte: cutoffMsgs } });
      summary.deletedMessages = delMsgs.deletedCount || 0;
    }

    // 6) Optionally delete Notifications older than notificationsDays
    if (!isNaN(notificationsDays) && notificationsDays > 0) {
      const cutoffNotifs = new Date(Date.now() - notificationsDays * 24 * 60 * 60 * 1000);
      const delNotifs = await Notification.deleteMany({ createdAt: { $lte: cutoffNotifs } });
      summary.deletedNotifications = delNotifs.deletedCount || 0;
    }

    console.log('[Maintenance Cleanup Summary]', summary);
    res.json({ success: true, message: 'Cleanup completed', summary });
  } catch (error) {
    console.error('Maintenance cleanup error:', error);
    res.status(500).json({ success: false, message: 'Cleanup failed', error: error.message });
  }
};

async function generateAndEmailBackupReport() {
  // Minimal, non-media data snapshot
  const [paymentsCount, messagesSample, adminLogsSample, notificationsSample, coursesCount, usersCount] = await Promise.all([
    SectionPayment.countDocuments({}),
    Message.find({}).select('sender recipient conversationType subject createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    AdminLog.find({}).select('action performedBy targetUser details createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    Notification.find({}).select('user type title read createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    Course.countDocuments({}),
    User.countDocuments({})
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    stats: {
      users: usersCount,
      courses: coursesCount,
      payments: paymentsCount,
      messagesSample: messagesSample.length,
      adminLogsSample: adminLogsSample.length,
      notificationsSample: notificationsSample.length
    },
    samples: {
      messages: messagesSample,
      adminLogs: adminLogsSample,
      notifications: notificationsSample
    }
  };

  // Email to admin
  const admin = await User.findOne({ role: 'admin' }).select('email name').lean();
  if (!admin || !admin.email) {
    throw new Error('No admin email configured');
  }

  const filename = `eduflow-backup-report-${new Date().toISOString().slice(0,10)}.json`;
  await sendEmail({
    email: admin.email,
    subject: 'EduFlow Backup Report',
    html: '<p>Attached is the latest backup report (non-media, summarized).</p>',
    attachments: [{
      filename,
      content: Buffer.from(JSON.stringify(report, null, 2), 'utf-8'),
      contentType: 'application/json'
    }]
  });

  return { size: JSON.stringify(report).length };
}

// POST /api/admin/maintenance/backup-report
// Private (Admin)
exports.sendBackupReport = async (req, res) => {
  try {
    const result = await generateAndEmailBackupReport();
    res.json({ success: true, message: 'Backup report emailed to admin', ...result });
  } catch (error) {
    console.error('Backup report error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate backup report', error: error.message });
  }
};

exports._generateAndEmailBackupReport = generateAndEmailBackupReport;

// ========= FULL BACKUP (ALL COLLECTIONS) ========= //

async function generateFullBackupBuffer() {
  // Collect all registered mongoose models dynamically
  const modelNames = mongoose.connection.modelNames();
  const collections = {};
  const collectionStats = [];
  for (const name of modelNames) {
    const Model = mongoose.model(name);
    const docs = await Model.find({}).lean({ virtuals: false });
    collections[name] = docs;
    collectionStats.push({ name, count: docs.length });
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development',
    collections
  };

  let buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
  let filename = `eduflow-full-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  let contentType = 'application/json';

  // Compress if large (>5MB)
  if (buffer.length > 5 * 1024 * 1024) {
    buffer = zlib.gzipSync(buffer);
    filename += '.gz';
    contentType = 'application/gzip';
  }

  return {
    buffer,
    filename,
    contentType,
    payload,
    collectionStats,
    sizeBytes: buffer.length
  };
}

// POST /api/admin/backup/full
// Private (Admin)
exports.sendFullBackup = async (req, res) => {
  try {
    const { buffer, filename, contentType } = await generateFullBackupBuffer();

    const adminEmail = process.env.ADMIN_EMAIL || (await User.findOne({ role: 'admin' }).select('email').lean())?.email;
    if (!adminEmail) {
      return res.status(400).json({ success: false, message: 'Admin email is not configured' });
    }

    await sendEmail({
      email: adminEmail,
      subject: 'EduFlow Full Backup',
      html: `<p>The full MongoDB backup was generated at ${new Date().toLocaleString()}.</p><p>This backup contains documents for all registered collections. No media content is included — only metadata and URLs.</p>`,
      attachments: [{ filename, content: buffer, contentType }]
    });

    res.json({ success: true, message: 'Full backup emailed to admin', size: buffer.length, compressed: filename.endsWith('.gz') });
  } catch (error) {
    console.error('Full backup error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate full backup', error: error.message });
  }
};

// Internal helper: scheduled full backup with report
async function runScheduledFullBackup() {
  const startedAt = new Date();
  try {
    const { buffer, filename, contentType, payload, collectionStats, sizeBytes } = await generateFullBackupBuffer();

    const adminEmail = process.env.ADMIN_EMAIL || (await User.findOne({ role: 'admin' }).select('email').lean())?.email;
    if (!adminEmail) {
      throw new Error('Admin email is not configured');
    }

    const collectionNames = Object.keys(payload.collections || {});
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

    const maxAttachmentBytes = parseInt(process.env.BACKUP_MAX_ATTACHMENT_BYTES || String(25 * 1024 * 1024), 10);
    const attachments = [];
    let downloadUrl;

    if (sizeBytes <= maxAttachmentBytes) {
      attachments.push({ filename, content: buffer, contentType });
    } else {
      // Write backup file to disk and send a download link instead of attachment
      const relativePath = constructUploadPath('backups', filename); // e.g. /uploads/backups/file.json[.gz]
      const uploadsDir = path.join(__dirname, '..');
      const fullPath = path.join(uploadsDir, relativePath.replace(/^\//, ''));

      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, buffer);

      downloadUrl = constructFileUrl(relativePath);
    }

    const collectionsListHtml = collectionStats
      .map(cs => `<li>${cs.name}: ${cs.count} documents</li>`)
      .join('') || '<li>No collections found</li>';

    let html = `
      <h2>Your Scheduled Backup + Backup Report</h2>
      <p>The scheduled backup was generated at <strong>${startedAt.toLocaleString()}</strong>.</p>
      <ul>
        <li><strong>Backup size:</strong> ${sizeMB} MB (${sizeBytes} bytes)</li>
        <li><strong>Total collections:</strong> ${collectionNames.length}</li>
      </ul>
      <h3>Collections</h3>
      <ul>
        ${collectionsListHtml}
      </ul>
    `;

    if (downloadUrl) {
      html += `
        <p>The backup file was too large to attach. You can download it securely using this link:</p>
        <p><a href="${downloadUrl}">${downloadUrl}</a></p>
      `;
    } else {
      html += '<p>The full backup file is attached to this email.</p>';
    }

    await sendEmail({
      email: adminEmail,
      subject: 'Your Scheduled Backup + Backup Report',
      html,
      attachments
    });

    const completedAt = new Date();
    return {
      success: true,
      sizeBytes,
      collectionNames,
      startedAt,
      completedAt
    };
  } catch (error) {
    console.error('Scheduled full backup error:', error);
    try {
      const adminEmail = process.env.ADMIN_EMAIL || (await User.findOne({ role: 'admin' }).select('email').lean())?.email;
      if (adminEmail) {
        await sendEmail({
          email: adminEmail,
          subject: 'Scheduled Backup Failed',
          html: `<p>The scheduled backup failed at ${new Date().toLocaleString()}.</p><p>Error: <pre>${(error && error.stack) || error.message}</pre></p>`
        });
      }
    } catch (notifyErr) {
      console.error('Failed to send scheduled-backup failure email:', notifyErr);
    }
    throw error;
  }
}

exports._runScheduledFullBackup = runScheduledFullBackup;

// ========= RESTORE FROM BACKUP ========= //

// POST /api/admin/backup/restore (multipart form: backup file + password)
// Private (Admin)
exports.restoreFromBackup = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    // Validate admin password
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ success: false, message: 'Password is required to confirm restore' });
    const admin = await User.findById(req.user.id).select('+password');
    if (!admin || admin.role !== 'admin') return res.status(403).json({ success: false, message: 'Not authorized' });
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid password' });

    // Validate uploaded file
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: 'Backup file is required' });
    let raw = req.file.buffer;
    // Try parse JSON; if fails, try gunzip
    let text;
    try {
      text = raw.toString('utf-8');
      JSON.parse(text); // validation only
    } catch {
      try {
        const inflated = zlib.gunzipSync(raw);
        text = inflated.toString('utf-8');
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid backup file format (expected JSON or gzipped JSON)' });
      }
    }

    const backup = JSON.parse(text);
    if (!backup || typeof backup !== 'object' || !backup.collections || typeof backup.collections !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid backup structure' });
    }

    const modelNames = new Set(mongoose.connection.modelNames());

    // Try transaction first; fallback to non-transactional restore if unsupported
    try {
      await session.withTransaction(async () => {
        for (const [name, docs] of Object.entries(backup.collections)) {
          if (!Array.isArray(docs)) continue;
          if (!modelNames.has(name)) {
            // Skip unknown models
            continue;
          }
          const Model = mongoose.model(name);
          // Replace collection content
          // Use native collection delete to bypass Mongoose middleware that may block deletes
          await Model.collection.deleteMany({}, { session });
          if (docs.length > 0) {
            // avoid running middleware; insert as-is (ids preserved)
            await Model.insertMany(docs, { session, ordered: false });
          }
        }
      });
    } catch (txErr) {
      // code 20 = IllegalOperation (transactions not supported on standalone)
      const unsupported = txErr?.code === 20 || /Transaction numbers are only allowed/i.test(txErr?.message || '');
      if (!unsupported) throw txErr;
      // Fallback: perform restore without a transaction
      for (const [name, docs] of Object.entries(backup.collections)) {
        if (!Array.isArray(docs)) continue;
        if (!modelNames.has(name)) continue;
        const Model = mongoose.model(name);
        // Use native collection delete to bypass Mongoose middleware that may block deletes
        await Model.collection.deleteMany({});
        if (docs.length > 0) {
          await Model.insertMany(docs, { ordered: false });
        }
      }
    }

    res.json({ success: true, message: 'Restore completed successfully' });
  } catch (error) {
    console.error('Restore backup error:', error);
    res.status(500).json({ success: false, message: 'Failed to restore from backup', error: error.message });
  } finally {
    session.endSession();
  }
};
