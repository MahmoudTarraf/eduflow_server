const crypto = require('crypto');
const { validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const generateToken = require('../utils/generateToken');
const { sendEmail } = require('../utils/sendEmail');
const { constructVerificationUrl, constructClientUrl } = require('../utils/urlHelper');
const { sha256 } = require('../utils/cryptoUtil');
const { isPasswordStrong, passwordStrengthCheck } = require('../utils/passwordStrength');
const { isDisposableEmail } = require('../utils/disposableEmail');

const cleanAlpha = (s, max = 20) => {
  if (typeof s !== 'string') return undefined;
  const sanitized = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} });
  const onlyLetters = sanitized.replace(/[^\p{L}\s]/gu, '');
  return onlyLetters.trim().slice(0, max);
};

// @desc    Register user (creates pending registration and sends verification email)
// SECURITY: Strong passwords are enforced via express-validator in routes/auth.js
// to mitigate weak credential reuse and brute-force risks.
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { name, email, password, phone, country, city, school, role = 'student' } = req.body;
    
    console.log('[Registration] Received data:', { name, email, phone, country, city, school, role });

    if (isDisposableEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Disposable or temporary email addresses are not allowed. Please use a real email address.'
      });
    }

    // Validate phone number format
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Remove spaces and validate format: must start with 09 and be exactly 10 digits
    const cleanPhone = phone.replace(/\s/g, '');
    const phoneRegex = /^09\d{8}$/;
    
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must start with 09 and contain exactly 10 digits (e.g., 0912345678)'
      });
    }

    // Block duplicates across both collections (by email), but ignore soft-deleted users
    const [existingUser, existingPending] = await Promise.all([
      User.findActiveByEmail(email),
      PendingRegistration.findOne({ email })
    ]);
    if (existingUser) {
      if (existingUser.isEmailVerified) {
        return res.status(400).json({
          success: false,
          message: 'This email is already registered. Please log in.'
        });
      }
      // Existing user record is not email-verified (legacy flow). Remove it so we can
      // start a clean pending registration and send a fresh verification email.
      await User.deleteOne({ _id: existingUser._id });
    }
    if (existingPending) {
      // If pending registration exists, delete it and allow re-registration
      // This handles cases where user registered but never verified
      console.log('[Registration] Found existing pending registration, deleting it to allow re-registration');
      await PendingRegistration.deleteOne({ email });
    }

    // Check duplicate phone across User and PendingRegistration
    const [existingPhoneUser, existingPhonePending] = await Promise.all([
      User.findOne({ phone: cleanPhone }),
      PendingRegistration.findOne({ phone: cleanPhone })
    ]);
    if (existingPhoneUser || existingPhonePending) {
      return res.status(400).json({
        success: false,
        message: 'This phone number is already registered. Please use another phone number.'
      });
    }

    // Enforce stronger password rules for instructor/admin without changing student logic
    if (role === 'instructor' || role === 'admin') {
      if (!isPasswordStrong(password)) {
        return res.status(400).json({
          success: false,
          message: 'Password does not meet security requirements. It must be at least 12 characters and include uppercase, lowercase, number, and special character.'
        });
      }
    }

    // Create pending registration
    const verificationToken = crypto.randomBytes(20).toString('hex');
    let pending;
    
    try {
      const safeCountry = cleanAlpha(country);
      const safeCity = cleanAlpha(city);
      const safeSchool = cleanAlpha(school);

      pending = await PendingRegistration.create({
        name,
        email,
        password,
        phone: cleanPhone,
        country: safeCountry,
        city: safeCity,
        school: safeSchool,
        role,
        emailVerificationToken: verificationToken
      });
      console.log('[Registration] Pending registration created successfully:', pending._id);
    } catch (dbError) {
      console.error('[Registration] Failed to create pending registration:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Failed to create registration. Please try again.'
      });
    }

    // Send verification email
    const verificationUrl = constructVerificationUrl(verificationToken);
    
    let emailSent = false;
    try {
      // Check if email is configured
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.warn('[Registration] Email not configured. Verification link:', verificationUrl);
        emailSent = false;
      } else {
        await sendEmail({
          email: pending.email,
          subject: 'Email Verification - EduFlow Academy',
          message: `Please verify your email by clicking the link: ${verificationUrl}`,
          html: `
            <h2>Welcome to EduFlow Academy!</h2>
            <p>Please verify your email by clicking the button below:</p>
            <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a>
            <p>If the button doesn't work, copy and paste this link: ${verificationUrl}</p>
          `
        });
        console.log('[Registration] Verification email sent successfully to:', email);
        emailSent = true;
      }
    } catch (emailError) {
      console.error('[Registration] Email sending failed:', emailError.message);
      emailSent = false;
    }

    // Do not create user or return token yet
    res.status(201).json({
      success: true,
      message: emailSent 
        ? 'Verification email sent. Please check your email to complete registration.'
        : 'Registration successful. Email service is not configured. Use the verification link below or resend verification.',
      pendingVerification: true,
      // Include verification link if email wasn't sent (for development/testing)
      verificationLink: !emailSent ? verificationUrl : undefined
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
};

// @desc    Check if email domain is disposable/temporary
// @route   GET /api/auth/check-email-domain?email=...
// @access  Public
exports.checkEmailDomain = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        isDisposable: false
      });
    }

    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
        isDisposable: false
      });
    }

    const disposable = isDisposableEmail(email);

    return res.json({
      success: true,
      email,
      isDisposable: disposable,
      message: disposable
        ? 'Temporary or disposable emails are not allowed. Please use a valid email address.'
        : 'Email domain is allowed.'
    });
  } catch (error) {
    console.error('checkEmailDomain error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while checking email domain',
      isDisposable: false
    });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, password } = req.body;
    // Check if user exists (exclude soft-deleted accounts)
    const user = await User.findActiveByEmail(email).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Block login for soft-deleted accounts
    if (user.isDeleted || user.status === 'deleted') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deleted. Please contact support if you believe this is an error.',
        isDeleted: true,
        status: 'deleted'
      });
    }

    // Check if user is banned (cannot login at all)
    if (user.status === 'banned' || user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been banned by EduFlow. Please contact support.',
        isBanned: true,
        status: 'banned',
        banReason: user.banReason
      });
    }

    // NOTE: Suspended users CAN login but with restrictions applied in middleware
    // We don't block login here, just flag them

    // Check password
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Weak password hint for admin/instructor only (non-blocking)
    let weakPassword = false;
    if ((user.role === 'admin' || user.role === 'instructor') && typeof password === 'string') {
      const strength = passwordStrengthCheck(password);
      weakPassword = !!strength.weakPassword;
    }

    // Instructor-specific checks
    if (user.role === 'instructor') {
      // Check if there's a pending instructor application (new registration flow)
      const InstructorApplication = require('../models/InstructorApplication');
      const application = await InstructorApplication.findOne({ email: user.email });
      
      if (application && application.status === 'pending_review') {
        // Check registration progress
        if (!application.emailVerified) {
          return res.status(403).json({
            success: false,
            message: 'Please verify your email to continue the instructor registration process.',
            redirectTo: '/register/instructor/verify-email',
            step: 'email_verification'
          });
        }
        
        if (!application.agreementPdfUrl) {
          return res.status(403).json({
            success: false,
            message: 'Please complete the instructor agreement to continue.',
            redirectTo: '/register/instructor/agreement',
            step: 'agreement'
          });
        }
        
        if (!application.introVideoUrl) {
          return res.status(403).json({
            success: false,
            message: 'Please submit your introduction video to complete your application.',
            redirectTo: '/register/instructor/intro-video',
            step: 'intro_video'
          });
        }
        
        // All steps completed, waiting for admin approval
        return res.status(403).json({
          success: false,
          message: 'Your instructor application is under review. Admin will respond to your request within 2 days.',
          redirectTo: '/instructor/pending-approval',
          step: 'pending_approval'
        });
      }
      
      // Check if instructor is approved (for existing flow)
      if (user.instructorStatus !== 'approved') {
        return res.status(403).json({
          success: false,
          message: 'Admin will respond to your request within 2 days.',
          step: 'pending_approval'
        });
      }
      
      // Check if email is verified
      if (!user.isEmailVerified) {
        return res.status(403).json({
          success: false,
          message: 'Please verify your email address before logging in.',
          redirectTo: '/verify-email',
          step: 'email_verification'
        });
      }
    }

    // 2FA gating for admin/instructor only
    if ((user.role === 'admin' || user.role === 'instructor') && user.twoFactorEnabled) {
      try {
        // Per-user trusted device cookie support with safe migration from legacy global cookie
        const baseName = process.env.TD_COOKIE_NAME || 'tdid';
        const perUserName = `${baseName}_${user._id}`;

        const perUserRaw = req.cookies && req.cookies[perUserName];
        const legacyRaw = req.cookies && req.cookies[baseName];
        const raw = perUserRaw || legacyRaw || null;

        let isTrusted = false;
        if (raw && Array.isArray(user.trustedDevices)) {
          const hash = sha256(raw);
          const now = Date.now();
          isTrusted = user.trustedDevices.some(d => String(d.tokenHash) === hash && (!d.expiresAt || new Date(d.expiresAt).getTime() > now));
        }

        // If trusted via legacy cookie, silently migrate by setting the per-user cookie
        if (isTrusted && !perUserRaw && legacyRaw) {
          const sameSite = process.env.NODE_ENV === 'production' ? 'none' : 'lax';
          res.cookie(perUserName, legacyRaw, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite,
            maxAge: 30 * 24 * 60 * 60 * 1000
          });
        }

        if (!isTrusted) {
          const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
          if (!secret) {
            return res.status(500).json({ success: false, message: 'Server configuration error' });
          }
          const twoFactorSession = require('jsonwebtoken').sign({ id: user._id, twofa: true, weakPassword }, secret, { expiresIn: '10m' });
          return res.json({ success: true, requires2FA: true, twoFactorSession });
        }
      } catch (e) {
        const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
        const twoFactorSession = require('jsonwebtoken').sign({ id: user._id, twofa: true, weakPassword }, secret, { expiresIn: '10m' });
        return res.json({ success: true, requires2FA: true, twoFactorSession });
      }
    }

  const token = generateToken(user._id);

  const restrictions = user.role === 'student'
    ? (user.suspensionRestrictions || {})
    : user.role === 'instructor'
    ? (user.instructorSuspensionRestrictions || {})
    : {};

  res.json({
    success: true,
    token,
    weakPassword,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      country: user.country,
      city: user.city,
      school: user.school,
      role: user.role,
      instructorStatus: user.instructorStatus,
      avatar: user.avatar,
      preferences: user.preferences,
      isEmailVerified: user.isEmailVerified,
      status: user.status || 'active',
      isSuspended: user.isSuspended || false,
      suspensionReason: user.suspensionReason,
      restrictions,
      twoFactorEnabled: !!user.twoFactorEnabled
    }
  });
} catch (error) {
  console.error('Login error:', error);
  res.status(500).json({
    success: false,
    message: 'Server error during login'
  });
}
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const userDoc = await User.findById(req.user.id).select('-password')
      .populate('enrolledCourses.course', 'name image level')
      .populate('enrolledCourses.group', 'name');

    const user = userDoc ? userDoc.toObject() : null;
    if (user) {
      user.id = user._id;
      if (user.role === 'student') {
        user.restrictions = user.suspensionRestrictions || {};
      } else if (user.role === 'instructor') {
        user.restrictions = user.instructorSuspensionRestrictions || {};
      } else {
        user.restrictions = {};
      }
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { name, phone, country, city, school, preferences } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    // Phone should be updated if provided (even if empty string)
    if (phone !== undefined) {
      updateData.phone = phone;
    }
    if (country !== undefined) {
      updateData.country = cleanAlpha(country);
    }
    if (city !== undefined) {
      updateData.city = cleanAlpha(city);
    }
    if (school !== undefined) {
      updateData.school = cleanAlpha(school);
    }
    if (preferences) updateData.preferences = { ...req.user.preferences, ...preferences };

    console.log('[Update Profile] Updating user:', req.user.id, 'with data:', updateData);

    const userDoc = await User.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    console.log('[Update Profile] User updated successfully. Phone:', userDoc.phone);

    const user = userDoc ? userDoc.toObject() : null;
    if (user) {
      user.id = user._id;
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('[Update Profile] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Update password
// @route   PUT /api/auth/password
// @access  Private
exports.updatePassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id).select('+password');

    // Check current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Enforce strong passwords for admin and instructor only
    if (user.role === 'admin' || user.role === 'instructor') {
      if (!isPasswordStrong(newPassword)) {
        return res.status(400).json({
          success: false,
          message: 'New password does not meet security requirements. It must be at least 12 characters and include uppercase, lowercase, number, and special character.'
        });
      }
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Forgot password - Send OTP
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email } = req.body;

    const user = await User.findActiveByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with this email'
      });
    }

    // Block forgot-password for deleted or banned accounts
    if (user.isDeleted || user.status === 'deleted') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deleted. Please contact support.',
        isDeleted: true,
        status: 'deleted'
      });
    }
    if (user.status === 'banned' || user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been banned by EduFlow. Password reset is not allowed. Please contact support.',
        isBanned: true,
        status: 'banned'
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOTP = otp;
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    // SECURITY: Never log OTPs in production; logs can leak secrets.
    // Limited dev-only logging helps troubleshooting during local testing.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Forgot Password] OTP generated for ${email}: ${otp}`);
    }

    // Send OTP email
    let emailSent = false;
    try {
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[Forgot Password] Email not configured. OTP:', otp);
        } else {
          console.warn('[Forgot Password] Email not configured. OTP generated but not logged in production.');
        }
        emailSent = false;
      } else {
        await sendEmail({
          email: user.email,
          subject: 'Password Reset OTP - EduFlow Academy',
          message: `Your password reset OTP is: ${otp}. This OTP will expire in 10 minutes.`,
          html: `
            <h2>Password Reset Request</h2>
            <p>You requested a password reset. Use the OTP below to verify your identity:</p>
            <div style="background-color: #f3f4f6; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
              ${otp}
            </div>
            <p>This OTP will expire in 10 minutes.</p>
            <p>If you didn't request this, please ignore this email.</p>
          `
        });
        console.log('[Forgot Password] OTP email sent successfully to:', email);
        emailSent = true;
      }
    } catch (error) {
      console.error('[Forgot Password] Email sending failed:', error.message);
      emailSent = false;
    }

    res.json({
      success: true,
      message: emailSent 
        ? 'OTP sent to your email. Please check your inbox.' 
        : 'OTP generated. Email service unavailable - please contact support.',
      otp: !emailSent ? otp : undefined // Only return OTP if email failed (for development)
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Verify OTP
// @route   POST /api/auth/verify-otp
// @access  Public
exports.verifyOTP = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, otp } = req.body;

    const user = await User.findOne({
      email,
      resetPasswordOTP: otp,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    console.log(`[Verify OTP] OTP verified successfully for ${email}`);

    res.json({
      success: true,
      message: 'OTP verified successfully'
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reset password with OTP
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, otp, password } = req.body;

    const user = await User.findOne({
      email,
      resetPasswordOTP: otp,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    // Enforce strong passwords for admin and instructor only
    if (user.role === 'admin' || user.role === 'instructor') {
      if (!isPasswordStrong(password)) {
        return res.status(400).json({
          success: false,
          message: 'Password does not meet security requirements. It must be at least 12 characters and include uppercase, lowercase, number, and special character.'
        });
      }
    }

    user.password = password;
    user.resetPasswordOTP = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    console.log(`[Reset Password] Password reset successfully for ${email}`);

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Resend OTP for password reset
// @route   POST /api/auth/resend-reset-otp
// @access  Public
exports.resendResetOTP = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findActiveByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No user found with this email'
      });
    }

    // Generate new 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOTP = otp;
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    // SECURITY: Never log OTPs in production; logs can leak secrets.
    // Limited dev-only logging helps troubleshooting during local testing.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Resend Reset OTP] OTP generated for ${email}: ${otp}`);
    }

    // Send OTP email
    let emailSent = false;
    try {
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[Resend Reset OTP] Email not configured. OTP:', otp);
        } else {
          console.warn('[Resend Reset OTP] Email not configured. OTP generated but not logged in production.');
        }
        emailSent = false;
      } else {
        await sendEmail({
          email: user.email,
          subject: 'Password Reset OTP - EduFlow Academy',
          message: `Your password reset OTP is: ${otp}. This OTP will expire in 10 minutes.`,
          html: `
            <h2>Password Reset Request</h2>
            <p>You requested a new OTP. Use the OTP below to verify your identity:</p>
            <div style="background-color: #f3f4f6; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
              ${otp}
            </div>
            <p>This OTP will expire in 10 minutes.</p>
            <p>If you didn't request this, please ignore this email.</p>
          `
        });
        console.log('[Resend Reset OTP] OTP email sent successfully to:', email);
        emailSent = true;
      }
    } catch (error) {
      console.error('[Resend Reset OTP] Email sending failed:', error.message);
      emailSent = false;
    }

    res.json({
      success: true,
      message: emailSent 
        ? 'New OTP sent to your email.' 
        : 'OTP generated. Email service unavailable - please contact support.',
      otp: !emailSent ? otp : undefined
    });
  } catch (error) {
    console.error('Resend reset OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Verify email and create user from pending registration
// @route   GET /api/auth/verify-email/:token
// @access  Public
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const pending = await PendingRegistration.findOne({ emailVerificationToken: token });
    if (!pending) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }

    console.log('[Email Verification] Creating user from pending:', {
      name: pending.name,
      email: pending.email,
      phone: pending.phone,
      country: pending.country,
      city: pending.city,
      school: pending.school,
      role: pending.role
    });

    // Create the real user now that email is verified
    const user = await User.create({
      name: pending.name,
      email: pending.email,
      password: pending.password,
      phone: pending.phone,
      country: pending.country,
      city: pending.city,
      school: pending.school,
      role: pending.role,
      instructorStatus: pending.role === 'instructor' ? 'pending' : 'approved',
      isEmailVerified: true
    });

    // Remove pending registration
    await pending.deleteOne();

    // Send email to admin for new instructor registration
    if (user.role === 'instructor') {
      try {
        const admin = await User.findOne({ role: 'admin' });
        if (admin && admin.email) {
          await sendEmail({
            email: admin.email,
            subject: 'New Instructor Registration - EduFlow Academy',
            html: `
              <h2>New Instructor Registration</h2>
              <p>Dear Admin,</p>
              <p>A new instructor has completed their registration and email verification:</p>
              <p><strong>Name:</strong> ${user.name}</p>
              <p><strong>Email:</strong> ${user.email}</p>
              <p><strong>Phone:</strong> ${user.phone || 'Not provided'}</p>
              <p><strong>Country:</strong> ${user.country || 'Not provided'}</p>
              <p><strong>City:</strong> ${user.city || 'Not provided'}</p>
              <p><strong>School/University:</strong> ${user.school || 'Not provided'}</p>
              <p><strong>Status:</strong> Pending Approval</p>
              <p>Please review and approve this instructor in your admin dashboard.</p>
              <br>
              <p>Best regards,<br>EduFlow Academy System</p>
            `
          });
          console.log(`[New Instructor] Email sent to admin: ${admin.email}`);
        }
      } catch (emailError) {
        console.error('[New Instructor] Admin email failed:', emailError.message);
      }
    }

    // Determine redirect path for frontend
    let redirectPath = '/login';
    let message = 'Email verified successfully! Your account has been created.';
    
    if (user.role === 'instructor') {
      // Instructors must accept agreement before approval
      redirectPath = '/instructor/agreement';
      message = 'Email verified! Please complete your instructor agreement to continue.';
    }

    // Redirect to success page with query parameters
    const successUrl = `${constructClientUrl('/verify-success')}?redirect=${encodeURIComponent(redirectPath)}&message=${encodeURIComponent(message)}&role=${user.role}`;
    res.redirect(successUrl);
  } catch (error) {
    console.error('Verify email error:', error);
    const errorUrl = `${constructClientUrl('/verify-error')}?message=${encodeURIComponent('Email verification failed. Please try again.')}`;
    res.redirect(errorUrl);
  }
};

// @desc    Resend verification email (public) for pending registrations
// @route   POST /api/auth/resend-verification
// @access  Public
exports.resendVerification = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    console.log('[Resend Verification] Request for email:', email);

    // First, check pending registrations
    let verificationEmail = null;
    let token = null;
    const pending = await PendingRegistration.findOne({ email });
    
    console.log('[Resend Verification] Pending registration found:', !!pending);
    
    // Throttle settings
    const MAX_ATTEMPTS = parseInt(process.env.RESEND_VERIFICATION_MAX || '3', 10);
    const WINDOW_MS = parseInt(process.env.RESEND_VERIFICATION_WINDOW_MS || String(15 * 60 * 1000), 10); // 15 minutes
    const BLOCK_MS = parseInt(process.env.RESEND_VERIFICATION_BLOCK_MS || String(30 * 60 * 1000), 10); // 30 minutes

    const now = Date.now();

    const checkAndBumpThrottle = async (doc) => {
      if (!doc) return;
      if (doc.verificationResendBlockedUntil && now < new Date(doc.verificationResendBlockedUntil).getTime()) {
        throw new Error(`blocked:${new Date(doc.verificationResendBlockedUntil).toISOString()}`);
      }
      const ws = doc.verificationResendWindowStart ? new Date(doc.verificationResendWindowStart).getTime() : 0;
      let count = doc.verificationResendCount || 0;
      if (!ws || now - ws > WINDOW_MS) {
        // reset window
        doc.verificationResendWindowStart = new Date(now);
        doc.verificationResendCount = 0;
        count = 0;
      }
      if (count >= MAX_ATTEMPTS) {
        doc.verificationResendBlockedUntil = new Date(now + BLOCK_MS);
        await doc.save();
        throw new Error(`blocked:${new Date(doc.verificationResendBlockedUntil).toISOString()}`);
      }
      doc.verificationResendCount = count + 1;
      if (!ws) doc.verificationResendWindowStart = new Date(now);
      await doc.save();
    };

    if (pending) {
      // Throttle on pending
      try {
        await checkAndBumpThrottle(pending);
      } catch (e) {
        if (String(e.message).startsWith('blocked:')) {
          const until = e.message.split(':')[1];
          return res.status(429).json({ success: false, message: `Too many attempts. Please try again after ${until}.` });
        }
        throw e;
      }
      // Generate new token for pending registration
      token = crypto.randomBytes(20).toString('hex');
      pending.emailVerificationToken = token;
      await pending.save();
      verificationEmail = pending.email;
    } else {
      // Fallback: handle existing unverified users (backward compatibility)
      const user = await User.findActiveByEmail(email);
      
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          message: 'No account found with this email. Please register first or check if you already verified your email.' 
        });
      }
      
      if (user.isEmailVerified) {
        return res.status(400).json({ 
          success: false, 
          message: 'This email is already verified. Please login.' 
        });
      }
      
      // Throttle on user
      try {
        await checkAndBumpThrottle(user);
      } catch (e) {
        if (String(e.message).startsWith('blocked:')) {
          const until = e.message.split(':')[1];
          return res.status(429).json({ success: false, message: `Too many attempts. Please try again after ${until}.` });
        }
        throw e;
      }
      // Generate new token for existing unverified user
      token = crypto.randomBytes(20).toString('hex');
      user.emailVerificationToken = token;
      await user.save();
      verificationEmail = user.email;
    }

    const verificationUrl = constructVerificationUrl(token);

    let emailSent = false;
    try {
      // Check if email is configured
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.warn('[Resend Verification] Email not configured. Verification link:', verificationUrl);
        emailSent = false;
      } else {
        await sendEmail({
          email: verificationEmail,
          subject: 'Email Verification - EduFlow Academy',
          message: `Please verify your email by clicking the link: ${verificationUrl}`,
          html: `
            <h2>Email Verification</h2>
            <p>Please verify your email by clicking the button below:</p>
            <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a>
            <p>If the button doesn't work, copy and paste this link: ${verificationUrl}</p>
          `
        });
        console.log('[Resend Verification] Email sent successfully to:', verificationEmail);
        emailSent = true;
      }
    } catch (error) {
      console.error('[Resend Verification] Email sending failed:', error.message);
      emailSent = false;
    }

    res.json({ 
      success: true, 
      message: emailSent 
        ? 'Verification email sent successfully. Please check your inbox.' 
        : 'Email service is currently unavailable. Please contact support or try again later.',
      verificationLink: !emailSent ? verificationUrl : undefined // Include link if email failed
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
