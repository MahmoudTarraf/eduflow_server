const AdminSettings = require('../models/AdminSettings');

const toProviderKey = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
};

// Helper to map AdminSettings document to a unified settings payload
const shapeSettingsResponse = (settingsDoc) => {
  const settings = settingsDoc ? settingsDoc.toObject() : {};

  // Core fields straight from schema
  const {
    platformName,
    platformEmail,
    platformPhone,
    platformIntro,
    agreementText,
    platformRevenuePercentage,
    instructorRevenuePercentage,
    rejectedAgreementsLastReadAt,
    logoUrl,
    defaultCurrency,
    supportedCurrencies,
    minimumPayoutAmountSYP,
    passingGrade,
    maxIntroVideoSizeMB,
    introVideoMaxReuploads,
    autoApproveEnrollment,
    showHomepageRatings,
    featuredRatingsLimit,
    paymentReceivers,
    paymentProviders
  } = settings;

  // Derived/alias fields for the restored Global Settings spec
  const maxIntroVideosForInstructor =
    typeof settings.maxIntroVideosForInstructor === 'number'
      ? settings.maxIntroVideosForInstructor
      : (typeof introVideoMaxReuploads === 'number' ? introVideoMaxReuploads : 3);

  const showRatingsOnHomepage =
    typeof settings.showRatingsOnHomepage === 'boolean'
      ? settings.showRatingsOnHomepage
      : (showHomepageRatings !== false);

  const homepageRatingsLimit =
    typeof settings.homepageRatingsLimit === 'number'
      ? settings.homepageRatingsLimit
      : (typeof featuredRatingsLimit === 'number' ? featuredRatingsLimit : 10);

  const currencyStudentPays = settings.currencyStudentPays || defaultCurrency || 'SYP';
  const platformCurrency = settings.platformCurrency || defaultCurrency || 'SYP';

  const minimumPayoutRequest =
    typeof settings.minimumPayoutRequest === 'number'
      ? settings.minimumPayoutRequest
      : (typeof minimumPayoutAmountSYP === 'number' ? minimumPayoutAmountSYP : 10000);

  const initialSignupPercentage =
    typeof settings.initialSignupPercentage === 'number'
      ? settings.initialSignupPercentage
      : (typeof platformRevenuePercentage === 'number' ? platformRevenuePercentage : 30);

  return {
    // Raw settings (for existing UIs like AgreementSettings, InstructorEarningsManagement, etc.)
    ...settings,

    // Explicitly expose commonly used fields
    platformName: platformName || 'EduFlow',
    platformEmail: platformEmail || '',
    platformPhone: platformPhone || '',
    platformIntro: platformIntro || settings.platformIntro || '',
    agreementText: agreementText || '',
    platformRevenuePercentage: typeof platformRevenuePercentage === 'number' ? platformRevenuePercentage : 30,
    instructorRevenuePercentage:
      typeof instructorRevenuePercentage === 'number'
        ? instructorRevenuePercentage
        : (100 - (typeof platformRevenuePercentage === 'number' ? platformRevenuePercentage : 30)),
    rejectedAgreementsLastReadAt: rejectedAgreementsLastReadAt || null,
    logoUrl: logoUrl || '',

    defaultCurrency: defaultCurrency || 'SYP',
    supportedCurrencies: Array.isArray(supportedCurrencies) && supportedCurrencies.length
      ? supportedCurrencies
      : ['SYP'],
    minimumPayoutAmountSYP: typeof minimumPayoutAmountSYP === 'number' ? minimumPayoutAmountSYP : 10000,
    passingGrade: typeof passingGrade === 'number' ? passingGrade : 60,
    maxIntroVideoSizeMB: typeof maxIntroVideoSizeMB === 'number' ? maxIntroVideoSizeMB : 500,
    introVideoMaxReuploads: typeof introVideoMaxReuploads === 'number' ? introVideoMaxReuploads : 3,
    autoApproveEnrollment: autoApproveEnrollment !== false,
    showHomepageRatings: showHomepageRatings !== false,
    featuredRatingsLimit: typeof featuredRatingsLimit === 'number' ? featuredRatingsLimit : 10,
    paymentReceivers: Array.isArray(paymentReceivers) ? paymentReceivers : [],
    paymentProviders: Array.isArray(paymentProviders) ? paymentProviders : [],

    // Aliases for the legacy GlobalSettings.js spec
    maxIntroVideosForInstructor,
    showRatingsOnHomepage,
    homepageRatingsLimit,
    currencyStudentPays,
    platformCurrency,
    minimumPayoutRequest,
    initialSignupPercentage
  };
};

// @desc    Get full admin settings (admin dashboard)
// @route   GET /api/admin/settings
// @access  Private (Admin)
exports.getSettings = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    const data = shapeSettingsResponse(settings);

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get admin settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch admin settings',
      error: error.message
    });
  }
};

// @desc    Mark rejected earnings agreements as read
// @route   POST /api/admin/settings/rejected-agreements/mark-read
// @access  Private (Admin)
exports.markRejectedAgreementsAsRead = async (req, res) => {
  try {
    const updated = await AdminSettings.updateSettings(
      { rejectedAgreementsLastReadAt: new Date() },
      req.user && req.user.id
    );
    const data = shapeSettingsResponse(updated);

    res.json({
      success: true,
      message: 'Rejected agreements marked as read',
      data: {
        rejectedAgreementsLastReadAt: data.rejectedAgreementsLastReadAt
      }
    });
  } catch (error) {
    console.error('Mark rejected agreements as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark rejected agreements as read',
      error: error.message
    });
  }
};

// @desc    Update admin settings (global)
// @route   PUT /api/admin/settings
// @route   POST /api/admin/settings
// @access  Private (Admin)
exports.updateSettings = async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};

    // Agreement & revenue split
    if (typeof body.agreementText === 'string') {
      updates.agreementText = body.agreementText;
    }

    // Direct revenue percentages (used by AgreementSettings and earnings tools)
    const hasPlatformPct = body.platformRevenuePercentage !== undefined;
    const hasInstructorPct = body.instructorRevenuePercentage !== undefined;

    if (hasPlatformPct || hasInstructorPct) {
      const platformPct = hasPlatformPct
        ? Number(body.platformRevenuePercentage)
        : 100 - Number(body.instructorRevenuePercentage);

      if (!Number.isFinite(platformPct) || platformPct < 0 || platformPct > 100) {
        return res.status(400).json({
          success: false,
          message: 'Platform percentage must be between 0 and 100'
        });
      }

      updates.platformRevenuePercentage = platformPct;
      updates.instructorRevenuePercentage = 100 - platformPct;
    }

    // initialSignupPercentage (alias for platform/instructor revenue split)
    if (body.initialSignupPercentage !== undefined && body.initialSignupPercentage !== '') {
      const pct = Number(body.initialSignupPercentage);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({
          success: false,
          message: 'initialSignupPercentage must be between 0 and 100'
        });
      }
      updates.platformRevenuePercentage = pct;
      updates.instructorRevenuePercentage = 100 - pct;
      updates.initialSignupPercentage = pct;
    }

    // Homepage ratings toggle & limit
    if (body.showRatingsOnHomepage !== undefined) {
      const val = !!body.showRatingsOnHomepage;
      updates.showHomepageRatings = val;
      updates.showRatingsOnHomepage = val;
    }

    if (body.showHomepageRatings !== undefined) {
      updates.showHomepageRatings = !!body.showHomepageRatings;
    }

    if (body.homepageRatingsLimit !== undefined) {
      const limit = parseInt(body.homepageRatingsLimit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        return res.status(400).json({
          success: false,
          message: 'homepageRatingsLimit must be at least 1'
        });
      }
      updates.featuredRatingsLimit = limit;
      updates.homepageRatingsLimit = limit;
    }

    if (body.featuredRatingsLimit !== undefined && body.homepageRatingsLimit === undefined) {
      const limit = parseInt(body.featuredRatingsLimit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        return res.status(400).json({
          success: false,
          message: 'featuredRatingsLimit must be at least 1'
        });
      }
      updates.featuredRatingsLimit = limit;
    }

    // Intro video limits
    if (body.maxIntroVideosForInstructor !== undefined) {
      const n = parseInt(body.maxIntroVideosForInstructor, 10);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          success: false,
          message: 'maxIntroVideosForInstructor must be a non-negative integer'
        });
      }
      updates.introVideoMaxReuploads = n;
      updates.maxIntroVideosForInstructor = n;
    }

    if (body.introVideoMaxReuploads !== undefined && body.maxIntroVideosForInstructor === undefined) {
      const n = parseInt(body.introVideoMaxReuploads, 10);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          success: false,
          message: 'introVideoMaxReuploads must be a non-negative integer'
        });
      }
      updates.introVideoMaxReuploads = n;
    }

    if (body.maxIntroVideoSizeMB !== undefined) {
      const size = Number(body.maxIntroVideoSizeMB);
      if (!Number.isFinite(size) || size < 50 || size > 2000) {
        return res.status(400).json({
          success: false,
          message: 'maxIntroVideoSizeMB must be between 50 and 2000 MB'
        });
      }
      updates.maxIntroVideoSizeMB = size;
    }

    // Currency settings (alias currencyStudentPays / platformCurrency onto existing fields)
    const allowedCurrencies = ['SYP', 'SYR', 'USD', 'EUR', 'GBP'];

    if (body.currencyStudentPays) {
      const cur = String(body.currencyStudentPays).toUpperCase();
      if (!allowedCurrencies.includes(cur)) {
        return res.status(400).json({
          success: false,
          message: `currencyStudentPays must be one of: ${allowedCurrencies.join(', ')}`
        });
      }
      updates.defaultCurrency = cur;
      updates.currencyStudentPays = cur;
    }

    if (body.platformCurrency) {
      const cur = String(body.platformCurrency).toUpperCase();
      if (!allowedCurrencies.includes(cur)) {
        return res.status(400).json({
          success: false,
          message: `platformCurrency must be one of: ${allowedCurrencies.join(', ')}`
        });
      }
      updates.platformCurrency = cur;
    }

    if (Array.isArray(body.supportedCurrencies)) {
      const sanitized = body.supportedCurrencies
        .map((c) => String(c).toUpperCase())
        .filter((c) => allowedCurrencies.includes(c));

      const unique = Array.from(new Set(sanitized));

      if (unique.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'supportedCurrencies must contain at least one valid currency'
        });
      }

      updates.supportedCurrencies = unique;
    }

    // Minimum payout amount (alias minimumPayoutRequest)
    if (body.minimumPayoutRequest !== undefined) {
      const amount = Number(body.minimumPayoutRequest);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({
          success: false,
          message: 'minimumPayoutRequest must be a non-negative number'
        });
      }
      updates.minimumPayoutAmountSYP = amount;
      updates.minimumPayoutRequest = amount;
    }

    if (body.minimumPayoutAmountSYP !== undefined && body.minimumPayoutRequest === undefined) {
      const amount = Number(body.minimumPayoutAmountSYP);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({
          success: false,
          message: 'minimumPayoutAmountSYP must be a non-negative number'
        });
      }
      updates.minimumPayoutAmountSYP = amount;
    }

    // Basic platform identity (used by other parts of the system)
    if (typeof body.platformName === 'string') {
      updates.platformName = body.platformName.trim();
    }
    if (typeof body.platformEmail === 'string') {
      updates.platformEmail = body.platformEmail.trim();
    }
    if (typeof body.platformPhone === 'string') {
      updates.platformPhone = body.platformPhone.trim();
    }

    if (typeof body.platformIntro === 'string') {
      updates.platformIntro = body.platformIntro.trim();
    }

    if (typeof body.facebookUrl === 'string') {
      updates.facebookUrl = body.facebookUrl.trim();
    }

    if (typeof body.githubUrl === 'string') {
      updates.githubUrl = body.githubUrl.trim();
    }

    if (typeof body.linkedinUrl === 'string') {
      updates.linkedinUrl = body.linkedinUrl.trim();
    }

    if (typeof body.logoUrl === 'string') {
      updates.logoUrl = body.logoUrl.trim();
    }

    if (Array.isArray(body.paymentProviders)) {
      const sanitizedProviders = body.paymentProviders
        .map((p) => {
          const name = typeof p?.name === 'string' ? p.name.trim() : '';
          const key = toProviderKey(p?.key || name);
          const imageUrl = typeof p?.imageUrl === 'string' ? p.imageUrl.trim() : '';
          const isActive = p?.isActive !== false;

          return {
            key,
            name,
            imageUrl,
            isActive
          };
        })
        .filter((p) => p.key && p.name);

      const seen = new Set();
      const deduped = [];
      for (const p of sanitizedProviders) {
        if (seen.has(p.key)) continue;
        seen.add(p.key);
        deduped.push(p);
      }

      updates.paymentProviders = deduped;
    }

    if (body.rejectedAgreementsLastReadAt !== undefined) {
      if (body.rejectedAgreementsLastReadAt === null || body.rejectedAgreementsLastReadAt === '') {
        updates.rejectedAgreementsLastReadAt = null;
      } else {
        const dt = new Date(body.rejectedAgreementsLastReadAt);
        if (Number.isNaN(dt.getTime())) {
          return res.status(400).json({
            success: false,
            message: 'rejectedAgreementsLastReadAt must be a valid date'
          });
        }
        updates.rejectedAgreementsLastReadAt = dt;
      }
    }

    // If no recognized fields were provided, avoid writing an empty update
    if (Object.keys(updates).length === 0) {
      const currentSettings = await AdminSettings.getSettings();
      return res.json({
        success: true,
        message: 'No settings were changed',
        data: shapeSettingsResponse(currentSettings)
      });
    }

    const updated = await AdminSettings.updateSettings(updates, req.user && req.user.id);
    const data = shapeSettingsResponse(updated);

    res.json({
      success: true,
      message: 'Admin settings updated successfully',
      data
    });
  } catch (error) {
    console.error('Update admin settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update admin settings',
      error: error.message
    });
  }
};

// @desc    Get payment receivers (public)
// @route   GET /api/admin/settings/payment-receivers
// @access  Public
exports.getPaymentReceivers = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    const receivers = Array.isArray(settings.paymentReceivers)
      ? settings.paymentReceivers.map((r) => ({
          providerKey: r.providerKey || r.paymentMethod,
          paymentMethod: r.paymentMethod || r.providerKey,
          receiverName: r.receiverName,
          receiverEmail: r.receiverEmail || '',
          receiverPhone: r.receiverPhone,
          receiverLocation: r.receiverLocation || '',
          accountDetails: r.accountDetails || '',
          isActive: r.isActive !== false,
          _id: r._id
        }))
      : [];

    const providers = Array.isArray(settings.paymentProviders)
      ? settings.paymentProviders.map((p) => ({
          key: p.key,
          name: p.name,
          imageUrl: p.imageUrl || '',
          isActive: p.isActive !== false,
          _id: p._id
        }))
      : [];

    res.json({
      success: true,
      data: receivers,
      providers
    });
  } catch (error) {
    console.error('Get payment receivers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment receivers',
      error: error.message
    });
  }
};

// @desc    Update payment receivers (admin)
// @route   PUT /api/admin/settings/payment-receivers
// @access  Private (Admin)
exports.updatePaymentReceivers = async (req, res) => {
  try {
    const { paymentReceivers } = req.body || {};

    if (!Array.isArray(paymentReceivers)) {
      return res.status(400).json({
        success: false,
        message: 'paymentReceivers must be an array'
      });
    }

    // Basic sanitization: ensure each receiver has required fields
    const sanitized = paymentReceivers
      .map((r) => {
        const providerKey = String(r?.providerKey || r?.paymentMethod || '').trim();
        return {
          providerKey,
          paymentMethod: providerKey,
          receiverName: r?.receiverName,
          receiverEmail: r?.receiverEmail || '',
          receiverPhone: r?.receiverPhone,
          receiverLocation: r?.receiverLocation || '',
          accountDetails: r?.accountDetails || '',
          isActive: r?.isActive !== false
        };
      })
      .filter((r) => r.providerKey && r.receiverName && r.receiverPhone);

    const updated = await AdminSettings.updateSettings({ paymentReceivers: sanitized }, req.user && req.user.id);
    const data = shapeSettingsResponse(updated);

    res.json({
      success: true,
      message: 'Payment receivers updated successfully',
      data: data.paymentReceivers
    });
  } catch (error) {
    console.error('Update payment receivers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment receivers',
      error: error.message
    });
  }
};

// @desc    Public-safe settings for clients (homepage, help, messages, etc.)
// @route   GET /api/admin/settings/public
// @access  Public
exports.getPublicSettings = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    const shaped = shapeSettingsResponse(settings);

    const envMaxVideoSizeMB = parseInt(process.env.MAX_VIDEO_SIZE_MB, 10);
    const envMaxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB, 10);
    const envMinVideoDurationSeconds = parseInt(process.env.MIN_VIDEO_DURATION_SECONDS, 10);

    const maxUploadVideoSizeMB = Number.isFinite(envMaxVideoSizeMB) && envMaxVideoSizeMB > 0
      ? envMaxVideoSizeMB
      : shaped.maxIntroVideoSizeMB;
    const maxUploadFileSizeMB = Number.isFinite(envMaxFileSizeMB) && envMaxFileSizeMB > 0
      ? envMaxFileSizeMB
      : (shaped.maxFileSizeMB !== undefined ? shaped.maxFileSizeMB : 100);
    const minVideoDurationSeconds = Number.isFinite(envMinVideoDurationSeconds) && envMinVideoDurationSeconds > 0
      ? envMinVideoDurationSeconds
      : 60;

    // Only expose fields that are safe for public consumption
    const data = {
      platformName: shaped.platformName,
      platformEmail: shaped.platformEmail,
      platformIntro: shaped.platformIntro,
      facebookUrl: shaped.facebookUrl || settings.facebookUrl || '',
      githubUrl: shaped.githubUrl || settings.githubUrl || '',
      linkedinUrl: shaped.linkedinUrl || settings.linkedinUrl || '',
      defaultCurrency: shaped.defaultCurrency,
      supportedCurrencies: shaped.supportedCurrencies,
      minimumPayoutAmountSYP: shaped.minimumPayoutAmountSYP,
      showHomepageRatings: shaped.showHomepageRatings,
      featuredRatingsLimit: shaped.featuredRatingsLimit,
      maxVideoSizeMB: shaped.maxIntroVideoSizeMB,
      introVideoMaxReuploads: shaped.introVideoMaxReuploads,
      maxIntroVideoSizeMB: shaped.maxIntroVideoSizeMB,
      maxUploadVideoSizeMB,
      maxUploadFileSizeMB,
      minVideoDurationSeconds,
      // Aliases for restored global settings spec
      maxIntroVideosForInstructor: shaped.maxIntroVideosForInstructor,
      showRatingsOnHomepage: shaped.showRatingsOnHomepage,
      homepageRatingsLimit: shaped.homepageRatingsLimit,
      currencyStudentPays: shaped.currencyStudentPays,
      platformCurrency: shaped.platformCurrency,
      minimumPayoutRequest: shaped.minimumPayoutRequest,
      initialSignupPercentage: shaped.initialSignupPercentage
    };

    data.paymentProviders = Array.isArray(shaped.paymentProviders)
      ? shaped.paymentProviders
          .filter((p) => p && p.key && p.name && p.isActive !== false)
          .map((p) => ({ key: p.key, name: p.name, imageUrl: p.imageUrl || '' }))
      : [];

    data.maxFileSizeMB = maxUploadFileSizeMB;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Get public admin settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch public settings',
      error: error.message
    });
  }
};

// @desc    Reset intro video upload counters for all instructors
// @route   POST /api/admin/settings/reset-intro-videos-counter
// @access  Private (Admin)
exports.resetIntroVideosCounter = async (req, res) => {
  try {
    const InstructorAgreement = require('../models/InstructorAgreement');

    const result = await InstructorAgreement.updateMany(
      {},
      {
        $set: {
          reuploadAttempts: 0,
          allowResubmission: true
        }
      }
    );

    const modifiedCount =
      typeof result.modifiedCount === 'number'
        ? result.modifiedCount
        : (typeof result.nModified === 'number' ? result.nModified : 0);

    res.json({
      success: true,
      message: `Intro video re-upload counters reset for ${modifiedCount} instructor(s).`,
      data: { modifiedCount }
    });
  } catch (error) {
    console.error('Reset intro videos counter error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset intro video counters',
      error: error.message
    });
  }
};

