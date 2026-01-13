const Policy = require('../models/Policy');
const sanitizeHtml = require('sanitize-html');
const { DEFAULT_PRIVACY_POLICY, DEFAULT_TERMS_OF_SERVICE } = require('../utils/defaultPolicies');

const ALLOWED_TYPES = ['privacy', 'terms'];

const DEFAULT_POLICIES = {
  privacy: DEFAULT_PRIVACY_POLICY,
  terms: DEFAULT_TERMS_OF_SERVICE
};

const sanitizePolicyContent = (html) => {
  return sanitizeHtml(html || '', {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      '*': ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard'
  });
};

// Admin: list all policies (initialize defaults if missing)
exports.getPoliciesAdmin = async (req, res) => {
  try {
    // Ensure default policies exist
    for (const type of ALLOWED_TYPES) {
      const exists = await Policy.findOne({ type });
      if (!exists) {
        const sanitizedContent = sanitizePolicyContent(DEFAULT_POLICIES[type]);
        await Policy.create({
          type,
          content: sanitizedContent
        });
      }
    }

    const policies = await Policy.find().select('type content updatedAt');

    res.json({
      success: true,
      data: policies
    });
  } catch (error) {
    console.error('Get policies error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch policies',
      error: error.message
    });
  }
};

// Admin: create or update a single policy
exports.updatePolicy = async (req, res) => {
  try {
    const { type } = req.params;
    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid policy type'
      });
    }

    const rawContent = typeof req.body.content === 'string' ? req.body.content : '';
    const sanitizedContent = sanitizePolicyContent(rawContent);

    const policy = await Policy.findOneAndUpdate(
      { type },
      { type, content: sanitizedContent, updatedBy: req.user.id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select('type content updatedAt');

    res.json({
      success: true,
      message: 'Policy updated successfully',
      data: policy
    });
  } catch (error) {
    console.error('Update policy error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update policy',
      error: error.message
    });
  }
};

// Public: get a single policy by type (initialize default if missing)
exports.getPolicyPublic = async (req, res) => {
  try {
    const { type } = req.params;
    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid policy type'
      });
    }

    let policy = await Policy.findOne({ type }).select('type content updatedAt');

    // If policy doesn't exist, create it with default content
    if (!policy) {
      const sanitizedContent = sanitizePolicyContent(DEFAULT_POLICIES[type]);
      policy = await Policy.create({
        type,
        content: sanitizedContent
      });
    }

    res.json({
      success: true,
      data: policy
    });
  } catch (error) {
    console.error('Get policy public error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch policy',
      error: error.message
    });
  }
};
