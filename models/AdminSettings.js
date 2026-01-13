const mongoose = require('mongoose');

const paymentProviderSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  imageUrl: {
    type: String,
    trim: true,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

const paymentReceiverSchema = new mongoose.Schema({
  providerKey: {
    type: String,
    trim: true
  },
  paymentMethod: {
    type: String,
    trim: true
  },
  receiverName: {
    type: String,
    required: true,
    trim: true
  },
  receiverEmail: {
    type: String,
    trim: true,
    default: ''
  },
  receiverPhone: {
    type: String,
    required: true,
    trim: true
  },
  receiverLocation: {
    type: String,
    trim: true,
    default: ''
  },
  accountDetails: {
    type: String,
    trim: true,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

paymentReceiverSchema.pre('validate', function(next) {
  if (!this.providerKey && this.paymentMethod) {
    this.providerKey = this.paymentMethod;
  }
  if (!this.paymentMethod && this.providerKey) {
    this.paymentMethod = this.providerKey;
  }
  next();
});

const adminSettingsSchema = new mongoose.Schema({
  // Singleton pattern - only one document should exist
  _id: {
    type: String,
    default: 'admin_settings'
  },
  
  // Platform information
  platformName: {
    type: String,
    default: 'EduFlow',
    trim: true
  },
  platformEmail: {
    type: String,
    trim: true
  },
  platformPhone: {
    type: String,
    trim: true
  },
  platformIntro: {
    type: String,
    trim: true,
    default: ''
  },
  facebookUrl: {
    type: String,
    trim: true,
    default: ''
  },
  githubUrl: {
    type: String,
    trim: true,
    default: ''
  },
  linkedinUrl: {
    type: String,
    trim: true,
    default: ''
  },
  
  // Payment receivers configuration
  paymentProviders: {
    type: [paymentProviderSchema],
    default: []
  },
  paymentReceivers: [paymentReceiverSchema],
  
  // Certificate settings
  certificateTemplate: {
    type: String,
    default: ''
  },
  certificateSignature: {
    type: String,
    default: ''
  },
  
  // Instructor Agreement settings
  agreementText: {
    type: String,
    default: `This Instructor Agreement ("Agreement") is entered into between EduFlow Academy ("Platform") and the Instructor named below.

1. INSTRUCTOR RESPONSIBILITIES
The Instructor agrees to:
- Create high-quality educational content
- Respond to student inquiries in a timely manner
- Maintain professional conduct at all times
- Keep course materials up to date

2. REVENUE SHARING
The Platform will retain {platformPercentage}% of all course revenue, with the remaining {instructorPercentage}% paid to the Instructor monthly.

3. INTELLECTUAL PROPERTY
The Instructor retains ownership of all course content but grants the Platform a license to distribute it.

4. TERMINATION
Either party may terminate this agreement with 30 days written notice.

By signing below, the Instructor agrees to these terms and conditions.`
  },
  platformRevenuePercentage: {
    type: Number,
    default: 30,
    min: 0,
    max: 100
  },
  instructorRevenuePercentage: {
    type: Number,
    default: 70,
    min: 0,
    max: 100
  },
  rejectedAgreementsLastReadAt: {
    type: Date,
    default: null
  },
  logoUrl: {
    type: String,
    default: ''
  },
  
  // Currency settings
  defaultCurrency: {
    type: String,
    default: 'SYP',
    enum: ['USD', 'SYP', 'SYR', 'EUR', 'GBP']
  },
  supportedCurrencies: {
    type: [String],
    default: ['SYP'],
    validate: {
      validator: function(currencies) {
        return currencies.length > 0 && currencies.every(c => ['USD', 'SYP', 'SYR', 'EUR', 'GBP'].includes(c));
      },
      message: 'Supported currencies must be valid currency codes'
    }
  },
  
  // Payout settings
  minimumPayoutAmountSYP: {
    type: Number,
    default: 10000,
    min: [10000, 'Minimum payout amount must be at least 10,000 SYP']
  },
  
  // Grading settings
  passingGrade: {
    type: Number,
    default: 60,
    min: 0,
    max: 100
  },
  maxIntroVideoSizeMB: {
    type: Number,
    default: 500,
    min: 50,
    max: 2000
  },
  introVideoMaxReuploads: {
    type: Number,
    default: 3,
    min: 0,
    max: 10
  },
  
  // Enrollment settings
  autoApproveEnrollment: {
    type: Boolean,
    default: true
  },

  // Homepage display settings
  showHomepageRatings: {
    type: Boolean,
    default: true
  },
  featuredRatingsLimit: {
    type: Number,
    default: 10,
    min: 1,
    max: 50
  },
  
  // Backup / maintenance settings
  lastAutoBackupAt: {
    type: Date
  },
  lastAutoBackupStatus: {
    type: String,
    enum: ['success', 'failed'],
    default: undefined
  },
  lastAutoBackupSize: {
    type: Number
  },
  lastAutoBackupCollections: {
    type: Number
  },
  lastAutoBackupError: {
    type: String
  },
  
  updatedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Static method to get or create settings
adminSettingsSchema.statics.getSettings = async function() {
  let settings = await this.findById('admin_settings');
  if (!settings) {
    settings = await this.create({ _id: 'admin_settings' });
  }
  return settings;
};

// Static method to update settings
adminSettingsSchema.statics.updateSettings = async function(updates, updatedBy) {
  const settings = await this.getSettings();
  Object.assign(settings, updates);
  if (updatedBy) {
    settings.updatedBy = updatedBy;
  }
  await settings.save();
  return settings;
};

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);
