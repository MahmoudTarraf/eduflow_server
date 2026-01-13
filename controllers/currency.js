const { convertCurrency, getCacheStats } = require('../services/currencyExchange');
const AdminSettings = require('../models/AdminSettings');

/**
 * @desc    Get supported currencies from admin settings
 * @route   GET /api/currency/supported
 * @access  Public
 */
exports.getSupportedCurrencies = async (req, res) => {
  try {
    const settings = await AdminSettings.getSettings();
    
    res.json({
      success: true,
      data: {
        supportedCurrencies: settings.supportedCurrencies || ['USD', 'EUR', 'GBP', 'SYP'],
        defaultCurrency: settings.defaultCurrency || 'SYP'
      }
    });
  } catch (error) {
    console.error('Error getting supported currencies:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get supported currencies'
    });
  }
};

/**
 * @desc    Convert currency from SYP to target currency
 * @route   POST /api/currency/convert
 * @access  Public
 */
exports.convertCurrencyAmount = async (req, res) => {
  try {
    const { amountInSYP, targetCurrency } = req.body;

    // Validation
    if (!amountInSYP || amountInSYP <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount in SYP is required'
      });
    }

    if (!targetCurrency) {
      return res.status(400).json({
        success: false,
        message: 'Target currency is required'
      });
    }

    // Verify currency is supported
    const settings = await AdminSettings.getSettings();
    const supportedCurrencies = settings.supportedCurrencies || ['USD', 'EUR', 'GBP', 'SYP'];
    
    if (!supportedCurrencies.includes(targetCurrency)) {
      return res.status(400).json({
        success: false,
        message: `Currency ${targetCurrency} is not supported`
      });
    }

    // Convert currency
    const result = await convertCurrency(amountInSYP, targetCurrency);

    const responseData = {
      success: true,
      data: {
        from: 'SYP',
        to: targetCurrency,
        amount: amountInSYP,
        converted: result.convertedAmount,
        exchangeRate: result.rate,
        // Legacy fields for backward compatibility
        amountInSYP,
        targetCurrency,
        convertedAmount: result.convertedAmount,
        displayText: `${result.convertedAmount} ${targetCurrency}`
      }
    };

    console.log('💱 Currency conversion response:', responseData.data);

    res.json(responseData);
  } catch (error) {
    console.error('Error converting currency:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to convert currency'
    });
  }
};

/**
 * @desc    Get cache statistics (admin only)
 * @route   GET /api/currency/cache-stats
 * @access  Private/Admin
 */
exports.getCurrencyCacheStats = async (req, res) => {
  try {
    const stats = getCacheStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get cache statistics'
    });
  }
};
