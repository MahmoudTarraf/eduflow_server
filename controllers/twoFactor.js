const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const User = require('../models/User');
const { encryptText, decryptText, sha256 } = require('../utils/cryptoUtil');
const jwt = require('jsonwebtoken');

function assertAllowedRole(user) {
  if (!user || !['admin', 'instructor'].includes(user.role)) {
    const err = new Error('2FA is only available for admin and instructor accounts');
    err.statusCode = 403;
    throw err;
  }
}

exports.setup = async (req, res) => {
  try {
    assertAllowedRole(req.user);

    // Generate TOTP secret
    const secret = speakeasy.generateSecret({
      name: `EduFlow (${req.user.email})`,
      length: 32
    });

    // Store encrypted secret temporarily (not enabling 2FA yet)
    const enc = encryptText(secret.base32);
    req.user.twoFactorSecret = JSON.stringify(enc);
    await req.user.save();

    // Generate QR code data URL
    const otpauth = secret.otpauth_url;
    const qr = await qrcode.toDataURL(otpauth);

    res.json({
      success: true,
      secret: secret.base32,
      otpauth,
      qr
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.verifySetup = async (req, res) => {
  try {
    assertAllowedRole(req.user);
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    const enc = req.user.twoFactorSecret ? JSON.parse(req.user.twoFactorSecret) : null;
    const base32 = decryptText(enc);
    if (!base32) return res.status(400).json({ success: false, message: 'No 2FA secret to verify' });

    const verified = speakeasy.totp.verify({ secret: base32, encoding: 'base32', token: code, window: 1 });
    if (!verified) return res.status(400).json({ success: false, message: 'Invalid 2FA code' });

    // Generate backup codes (8 codes), return once, store hashes
    const codes = Array.from({ length: 8 }, () => Math.random().toString(36).slice(-10));
    req.user.twoFactorBackupCodes = codes.map(c => sha256(c));
    req.user.twoFactorEnabled = true;
    await req.user.save();

    res.json({ success: true, backupCodes: codes });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.disable = async (req, res) => {
  try {
    assertAllowedRole(req.user);
    req.user.twoFactorEnabled = false;
    req.user.twoFactorSecret = undefined;
    req.user.twoFactorBackupCodes = [];
    req.user.trustedDevices = [];
    await req.user.save();
    res.json({ success: true, message: 'Two-factor authentication disabled' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.listTrustedDevices = async (req, res) => {
  try {
    assertAllowedRole(req.user);
    const devices = (req.user.trustedDevices || []).map(d => ({
      id: d._id,
      deviceName: d.deviceName || 'Trusted Device',
      expiresAt: d.expiresAt,
      createdAt: d.createdAt
    }));
    res.json({ success: true, devices });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.revokeTrustedDevice = async (req, res) => {
  try {
    assertAllowedRole(req.user);
    const { id } = req.params;
    await User.updateOne({ _id: req.user._id }, { $pull: { trustedDevices: { _id: id } } });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.login2FA = async (req, res) => {
  try {
    const { code, rememberDevice, deviceName, twoFactorSession, email } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    let userId;
    let weakPassword = false;
    if (twoFactorSession) {
      const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
      const decoded = jwt.verify(twoFactorSession, secret);
      if (!decoded || !decoded.twofa) return res.status(400).json({ success: false, message: 'Invalid 2FA session' });
      userId = decoded.id;
      if (typeof decoded.weakPassword === 'boolean') {
        weakPassword = decoded.weakPassword;
      }
    } else if (email) {
      const u = await User.findActiveByEmail(email);
      if (!u) return res.status(400).json({ success: false, message: 'Invalid user' });
      userId = u._id;
    } else {
      return res.status(400).json({ success: false, message: 'twoFactorSession or email required' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(400).json({ success: false, message: 'Invalid user' });
    if (!['admin', 'instructor'].includes(user.role)) return res.status(403).json({ success: false, message: '2FA not applicable to this user' });
    if (!user.twoFactorEnabled) return res.status(400).json({ success: false, message: '2FA not enabled' });

    const enc = user.twoFactorSecret ? JSON.parse(user.twoFactorSecret) : null;
    const base32 = decryptText(enc);
    if (!base32) return res.status(500).json({ success: false, message: '2FA secret not available' });

    const ok = speakeasy.totp.verify({ secret: base32, encoding: 'base32', token: code, window: 1 });
    if (!ok) return res.status(400).json({ success: false, message: 'Invalid 2FA code' });

    // Create JWT
    const generateToken = require('../utils/generateToken');
    const token = generateToken(user._id);

    // Optional: remember device
    if (rememberDevice) {
      const rawToken = require('crypto').randomBytes(32).toString('hex');
      const tokenHash = sha256(rawToken);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const name = deviceName || (req.headers['user-agent'] || 'Trusted Device').slice(0, 100);
      await User.updateOne({ _id: user._id }, { $push: { trustedDevices: { tokenHash, expiresAt, deviceName: name } } });

      // Per-user cookie name to avoid cross-user interference on shared browsers
      const baseName = process.env.TD_COOKIE_NAME || 'tdid';
      const cookieName = `${baseName}_${user._id}`;
      const sameSite = process.env.NODE_ENV === 'production' ? 'none' : 'lax';
      res.cookie(cookieName, rawToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite,
        maxAge: 30 * 24 * 60 * 60 * 1000
      });
    }

    res.json({ success: true, token, weakPassword, user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified
    } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
