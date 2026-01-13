/**
 * Multi-Currency System Test Script
 * 
 * This script tests the multi-currency implementation:
 * 1. Currency conversion API
 * 2. Cache functionality
 * 3. Database structure
 * 
 * Usage: node server/scripts/testMultiCurrency.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { convertCurrency, getCacheStats } = require('../services/currencyExchange');
const AdminSettings = require('../models/AdminSettings');
const SectionPayment = require('../models/SectionPayment');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/eduflow-academy';

async function testCurrencyConversion() {
  console.log('\n🧪 Testing Currency Conversion...\n');
  console.log('⚠️  IMPORTANT: Testing with actual SYP amount (not cents)\n');
  
  const testAmount = 50000; // 50,000 SYP (actual amount, not in cents)
  const currencies = ['USD', 'EUR', 'GBP'];
  
  console.log('📝 Example: If section.priceCents = 5000000 (stored in cents)');
  console.log('   Then actual SYP amount = 5000000 / 100 = 50,000 SYP');
  console.log('   This is what should be sent to the conversion API\n');
  
  for (const currency of currencies) {
    try {
      console.log(`Converting ${testAmount.toLocaleString()} SYP to ${currency}...`);
      const result = await convertCurrency(testAmount, currency);
      console.log(`✅ Result: ${result.convertedAmount} ${currency}`);
      console.log(`   Exchange rate: 1 SYP = ${result.rate} ${currency}`);
      
      // Verify calculation
      const expectedAmount = (testAmount * result.rate).toFixed(2);
      const matchesExpected = Math.abs(expectedAmount - result.convertedAmount) < 0.01;
      console.log(`   Verification: ${testAmount} × ${result.rate} = ${expectedAmount} ${matchesExpected ? '✅' : '❌'}\n`);
    } catch (error) {
      console.error(`❌ Failed to convert to ${currency}:`, error.message);
    }
  }
  
  // Show what the conversion should look like
  console.log('📊 Expected Results (approximate):');
  console.log('   50,000 SYP → ~4-5 USD (rate ≈ 0.00009)');
  console.log('   50,000 SYP → ~4-5 EUR (rate ≈ 0.00008)');
  console.log('   50,000 SYP → ~3-4 GBP (rate ≈ 0.00007)\n');
}

async function testCachePerformance() {
  console.log('\n⚡ Testing Cache Performance...\n');
  
  const testAmount = 50000;
  
  // First call - should hit API
  console.log('First conversion (should hit API)...');
  const start1 = Date.now();
  await convertCurrency(testAmount, 'USD');
  const time1 = Date.now() - start1;
  console.log(`✅ Time: ${time1}ms\n`);
  
  // Second call - should use cache
  console.log('Second conversion (should use cache)...');
  const start2 = Date.now();
  await convertCurrency(testAmount, 'USD');
  const time2 = Date.now() - start2;
  console.log(`✅ Time: ${time2}ms\n`);
  
  if (time2 < time1) {
    console.log('✅ Cache is working! Second call was faster.\n');
  } else {
    console.log('⚠️  Cache might not be working. Times are similar.\n');
  }
  
  // Show cache stats
  const stats = getCacheStats();
  console.log('📊 Cache Statistics:');
  console.log(`   Total entries: ${stats.totalEntries}`);
  console.log(`   Entries:`, stats.entries.map(e => ({
    key: e.key,
    age: `${e.age} minutes`
  })));
}

async function testAdminSettings() {
  console.log('\n⚙️  Testing Admin Settings...\n');
  
  try {
    const settings = await AdminSettings.getSettings();
    console.log('✅ Supported Currencies:', settings.supportedCurrencies);
    console.log('✅ Default Currency:', settings.defaultCurrency);
    
    if (!settings.supportedCurrencies || settings.supportedCurrencies.length === 0) {
      console.log('\n⚠️  Warning: No supported currencies configured!');
      console.log('   Setting default currencies...');
      settings.supportedCurrencies = ['USD', 'EUR', 'GBP', 'SYP'];
      settings.defaultCurrency = 'SYP';
      await settings.save();
      console.log('✅ Default currencies set successfully!');
    }
  } catch (error) {
    console.error('❌ Failed to load admin settings:', error.message);
  }
}

async function testPaymentStructure() {
  console.log('\n💾 Testing Payment Database Structure...\n');
  
  try {
    // Check if there are any payments
    const totalPayments = await SectionPayment.countDocuments();
    console.log(`Total payments in database: ${totalPayments}`);
    
    if (totalPayments > 0) {
      // Check latest payment structure
      const latestPayment = await SectionPayment.findOne()
        .sort({ createdAt: -1 })
        .select('baseAmountSYP amountCents currency exchangeRate status');
      
      console.log('\n📄 Latest Payment Structure:');
      console.log('   baseAmountSYP:', latestPayment.baseAmountSYP || 'NOT SET ⚠️');
      console.log('   amountCents:', latestPayment.amountCents);
      console.log('   currency:', latestPayment.currency || 'NOT SET ⚠️');
      console.log('   exchangeRate:', latestPayment.exchangeRate || 'NOT SET ⚠️');
      console.log('   status:', latestPayment.status);
      
      // Check if multi-currency fields exist
      const hasMultiCurrency = latestPayment.currency && latestPayment.exchangeRate;
      if (hasMultiCurrency) {
        console.log('\n✅ Payment has multi-currency fields!');
      } else {
        console.log('\n⚠️  Latest payment missing some multi-currency fields.');
        console.log('   This is normal for payments created before multi-currency was implemented.');
      }
      
      // Count payments by currency
      const currencyCounts = await SectionPayment.aggregate([
        { $match: { status: 'approved' } },
        { $group: { _id: '$currency', count: { $sum: 1 } } }
      ]);
      
      console.log('\n📊 Approved Payments by Currency:');
      currencyCounts.forEach(item => {
        console.log(`   ${item._id || 'Unknown'}: ${item.count} payments`);
      });
    } else {
      console.log('\n⚠️  No payments found in database.');
      console.log('   Create a test payment to verify multi-currency functionality.');
    }
  } catch (error) {
    console.error('❌ Failed to check payment structure:', error.message);
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Multi-Currency System Test Suite                  ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  try {
    // Connect to database
    console.log('\n🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    // Run all tests
    await testAdminSettings();
    await testCurrencyConversion();
    await testCachePerformance();
    await testPaymentStructure();
    
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║                 ✅ All Tests Complete!                 ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB\n');
    process.exit(0);
  }
}

// Run tests
runTests();
