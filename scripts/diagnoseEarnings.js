/**
 * Diagnostic Script for Payment Earnings Issue
 * 
 * This script checks if:
 * 1. InstructorEarning records are being created
 * 2. AdminEarning records are being created
 * 3. Records can be retrieved
 * 
 * Run with: node server/scripts/diagnoseEarnings.js
 */

const mongoose = require('mongoose');
const InstructorEarning = require('../models/InstructorEarning');
const AdminEarning = require('../models/AdminEarning');
const SectionPayment = require('../models/SectionPayment');
const User = require('../models/User');
const Course = require('../models/Course');
require('dotenv').config();

async function diagnose() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get recent approved payments
    console.log('📝 Checking recent approved payments...');
    const recentPayments = await SectionPayment.find({ 
      status: 'approved',
      processedAt: { $exists: true }
    })
      .sort({ processedAt: -1 })
      .limit(5)
      .populate('student', 'name email')
      .populate('course', 'name')
      .lean();

    console.log(`Found ${recentPayments.length} recent approved payments:\n`);
    
    for (const payment of recentPayments) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Payment ID: ${payment._id}`);
      console.log(`Student: ${payment.student?.name}`);
      console.log(`Course: ${payment.course?.name}`);
      console.log(`Amount: ${payment.amountCents / 100} ${payment.currency}`);
      console.log(`Processed At: ${payment.processedAt}`);
      
      // Check if InstructorEarning exists
      const instructorEarning = await InstructorEarning.findOne({ 
        sectionPayment: payment._id 
      }).lean();
      
      if (instructorEarning) {
        console.log('✅ InstructorEarning FOUND:');
        console.log(`   - ID: ${instructorEarning._id}`);
        console.log(`   - Instructor: ${instructorEarning.instructor}`);
        console.log(`   - Status: ${instructorEarning.status}`);
        console.log(`   - Amount: ${instructorEarning.instructorEarningAmount / 100} ${instructorEarning.currency}`);
        console.log(`   - Percentage: ${instructorEarning.instructorPercentage}%`);
      } else {
        console.log('❌ InstructorEarning NOT FOUND for this payment!');
      }
      
      // Check if AdminEarning exists
      const adminEarning = await AdminEarning.findOne({ 
        sectionPayment: payment._id 
      }).lean();
      
      if (adminEarning) {
        console.log('✅ AdminEarning FOUND:');
        console.log(`   - ID: ${adminEarning._id}`);
        console.log(`   - Amount: ${adminEarning.adminEarningAmount / 100} ${adminEarning.currency}`);
        console.log(`   - Percentage: ${adminEarning.adminCommissionPercentage}%`);
      } else {
        console.log('❌ AdminEarning NOT FOUND for this payment!');
      }
      
      console.log('');
    }

    // Check total earnings counts
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n📊 Overall Statistics:\n');
    
    const totalInstructorEarnings = await InstructorEarning.countDocuments();
    const totalAdminEarnings = await AdminEarning.countDocuments();
    const totalApprovedPayments = await SectionPayment.countDocuments({ status: 'approved' });
    
    console.log(`Total Approved Payments: ${totalApprovedPayments}`);
    console.log(`Total InstructorEarning records: ${totalInstructorEarnings}`);
    console.log(`Total AdminEarning records: ${totalAdminEarnings}`);
    
    if (totalInstructorEarnings < totalApprovedPayments) {
      console.log('\n⚠️  WARNING: Some approved payments are missing InstructorEarning records!');
      console.log(`   Missing: ${totalApprovedPayments - totalInstructorEarnings} records`);
    }
    
    if (totalAdminEarnings < totalApprovedPayments) {
      console.log('\n⚠️  WARNING: Some approved payments are missing AdminEarning records!');
      console.log(`   Missing: ${totalApprovedPayments - totalAdminEarnings} records`);
    }

    // Test retrieval for a specific instructor
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n🔍 Testing retrieval for instructors:\n');
    
    const instructors = await User.find({ role: 'instructor' }).limit(3).lean();
    
    for (const instructor of instructors) {
      console.log(`Instructor: ${instructor.name} (${instructor._id})`);
      
      const summary = await InstructorEarning.getSummary(instructor._id);
      console.log('Summary:', JSON.stringify(summary, null, 2));
      
      const earningsList = await InstructorEarning.find({ 
        instructor: instructor._id 
      }).limit(5).lean();
      console.log(`Recent earnings count: ${earningsList.length}`);
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error during diagnosis:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Diagnosis complete. Database connection closed.');
  }
}

diagnose();
