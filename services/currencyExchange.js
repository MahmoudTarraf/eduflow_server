const axios = require('axios');

/**
 * Currency Exchange Service
 * Uses ExchangeRate-API with 1-hour caching to minimize API calls
 */

// Cache structure: { 'SYP_USD_50000': { amount: 5, timestamp: 1234567890 } }
const exchangeCache = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Convert amount from SYP to target currency
 * @param {number} amountInSYP - Amount in Syrian Pounds
 * @param {string} targetCurrency - Target currency code (USD, EUR, GBP, etc.)
 * @returns {Promise<{convertedAmount: number, rate: number}>}
 */
const convertCurrency = async (amountInSYP, targetCurrency) => {
  try {
    // If target is SYP, return as-is
    if (targetCurrency === 'SYP') {
      return {
        convertedAmount: amountInSYP,
        rate: 1
      };
    }

    // Create cache key
    const cacheKey = `SYP_${targetCurrency}_${amountInSYP}`;
    
    // Check cache first
    const cached = exchangeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`✅ Using cached exchange rate for ${cacheKey}`);
      return {
        convertedAmount: cached.amount,
        rate: cached.rate
      };
    }

    // Make API call
    const apiKey = process.env.EXCHANGE_API_KEY;
    if (!apiKey) {
      throw new Error('EXCHANGE_API_KEY not configured');
    }

    const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/SYP/${targetCurrency}/${amountInSYP}`;
    console.log(`🌐 Fetching exchange rate from API: ${amountInSYP} SYP → ${targetCurrency}`);
    
    const response = await axios.get(url);
    
    // Log raw API response for debugging
    console.log('📡 Exchange API raw response:', {
      result: response.data.result,
      base_code: response.data.base_code,
      target_code: response.data.target_code,
      conversion_rate: response.data.conversion_rate,
      conversion_result: response.data.conversion_result
    });
    
    if (response.data.result !== 'success') {
      throw new Error(`Exchange API error: ${response.data['error-type']}`);
    }

    // Use conversion_result directly from API (preferred method)
    // This is the exact converted amount calculated by the API
    const convertedAmount = parseFloat(response.data.conversion_result.toFixed(2));
    
    // conversion_rate represents: 1 SYP = X target_currency
    const rate = response.data.conversion_rate;

    // Cache the result
    exchangeCache.set(cacheKey, {
      amount: convertedAmount,
      rate: rate,
      timestamp: Date.now()
    });

    console.log(`✅ Converted ${amountInSYP} SYP → ${convertedAmount} ${targetCurrency}`);
    console.log(`   Exchange rate: 1 SYP = ${rate} ${targetCurrency}`);

    return {
      convertedAmount,
      rate
    };
  } catch (error) {
    console.error('❌ Currency conversion error:', error.message);
    throw new Error(`Failed to convert currency: ${error.message}`);
  }
};

/**
 * Get exchange rate between two currencies
 * @param {string} fromCurrency - Source currency code
 * @param {string} toCurrency - Target currency code
 * @returns {Promise<number>} Exchange rate
 */
const getExchangeRate = async (fromCurrency, toCurrency) => {
  try {
    if (fromCurrency === toCurrency) {
      return 1;
    }

    const cacheKey = `RATE_${fromCurrency}_${toCurrency}`;
    const cached = exchangeCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`✅ Using cached rate for ${fromCurrency} → ${toCurrency}`);
      return cached.rate;
    }

    const apiKey = process.env.EXCHANGE_API_KEY;
    if (!apiKey) {
      throw new Error('EXCHANGE_API_KEY not configured');
    }

    const url = `https://v6.exchangerate-api.com/v6/${apiKey}/pair/${fromCurrency}/${toCurrency}`;
    const response = await axios.get(url);
    
    if (response.data.result !== 'success') {
      throw new Error(`Exchange API error: ${response.data['error-type']}`);
    }

    const rate = response.data.conversion_rate;

    exchangeCache.set(cacheKey, {
      rate: rate,
      timestamp: Date.now()
    });

    return rate;
  } catch (error) {
    console.error('❌ Get exchange rate error:', error.message);
    throw error;
  }
};

/**
 * Clear expired cache entries (called periodically)
 */
const clearExpiredCache = () => {
  const now = Date.now();
  let clearedCount = 0;
  
  for (const [key, value] of exchangeCache.entries()) {
    if (now - value.timestamp >= CACHE_DURATION) {
      exchangeCache.delete(key);
      clearedCount++;
    }
  }
  
  if (clearedCount > 0) {
    console.log(`🧹 Cleared ${clearedCount} expired cache entries`);
  }
};

// Clear expired cache every 30 minutes
setInterval(clearExpiredCache, 30 * 60 * 1000);

/**
 * Get cache statistics
 */
const getCacheStats = () => {
  return {
    totalEntries: exchangeCache.size,
    entries: Array.from(exchangeCache.entries()).map(([key, value]) => ({
      key,
      age: Math.floor((Date.now() - value.timestamp) / 1000 / 60), // minutes
      ...value
    }))
  };
};

module.exports = {
  convertCurrency,
  getExchangeRate,
  getCacheStats,
  clearExpiredCache
};
