/**
 * Cleanup Script: Remove old agreements with Cloudinary URLs
 * Run this once to clean up old agreements before the fix
 */

const mongoose = require('mongoose');
const path = require('path');

// Load .env from server directory
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');

async function cleanupOldAgreements() {
  try {
    console.log('🔄 Connecting to database...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to database');

    // Find all agreements with cloudinary URLs
    const oldAgreements = await InstructorEarningsAgreement.find({
      pdfUrl: { $regex: /cloudinary/ }
    });

    console.log(`📋 Found ${oldAgreements.length} old agreements with Cloudinary URLs`);

    if (oldAgreements.length === 0) {
      console.log('✅ No old agreements to clean up!');
      process.exit(0);
    }

    // Delete them
    const result = await InstructorEarningsAgreement.deleteMany({
      pdfUrl: { $regex: /cloudinary/ }
    });

    console.log(`✅ Deleted ${result.deletedCount} old agreements`);
    console.log('💡 New agreements will be generated with local storage when you update global settings');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

cleanupOldAgreements();
