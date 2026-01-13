const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function scanPath(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath) return resolve({ clean: true });
    const cmd = 'clamscan';
    const args = ['-i', filePath];
    const opts = { timeout: 60_000 }; // 60s per file
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      const infected = /FOUND\s*$/m.test(out);
      let signature = null;
      if (infected) {
        // Extract signature before ': <file>: <signature> FOUND'
        const match = out.match(/: ([^:]+) FOUND/m);
        signature = match ? match[1] : 'Unknown';
      }
      if (error && error.killed) {
        return reject(new Error('Antivirus scan timed out'));
      }
      resolve({ clean: !infected, signature, raw: out });
    });
  });
}

async function deleteFileSafe(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {}
}

function collectUploadedFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) {
      files.push(...req.files);
    } else if (typeof req.files === 'object') {
      Object.values(req.files).forEach(arr => {
        if (Array.isArray(arr)) files.push(...arr);
      });
    }
  }
  return files;
}

// Express middleware: scan any uploaded files saved by Multer
// On infection -> delete file(s) and return 400
module.exports = async function scanFile(req, res, next) {
  try {
    if (process.env.DISABLE_UPLOAD_AV_SCAN === 'true') {
      return next();
    }

    const files = collectUploadedFiles(req);
    if (!files.length) return next();

    for (const f of files) {
      const filePath = f.path || (f.destination && f.filename ? path.join(f.destination, f.filename) : null);
      const result = await scanPath(filePath);
      if (!result.clean) {
        await Promise.all(files.map(x => deleteFileSafe(x.path)));
        return res.status(400).json({
          success: false,
          message: 'File failed security scan',
          details: result.signature || 'Malware detected',
          file: f.originalname
        });
      }
    }

    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Security scan failed', error: err.message });
  }
}
