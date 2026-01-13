const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const SectionPayment = require('../models/SectionPayment');
const InstructorEarning = require('../models/InstructorEarning');
const AdminEarning = require('../models/AdminEarning');
const Course = require('../models/Course');
const User = require('../models/User');

async function verifyPaymentEarnings() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/eduflow-academy';
    await mongoose.connect(uri);
    console.log('✅ Connected to database\n');

    // Get all approved payments
    const approvedPayments = await SectionPayment.find({ status: 'approved' })
      .populate('course', 'name')
      .populate('student', 'name')
      .populate('instructor', 'name');

    console.log(`📊 Found ${approvedPayments.length} approved payments\n`);

    for (const payment of approvedPayments) {
      console.log(`\n💰 Payment ${payment._id}:`);
      console.log(`   Student: ${payment.student?.name}`);
      console.log(`   Course: ${payment.course?.name}`);
      console.log(`   Amount: ${payment.amountCents} ${payment.currency}`);
      console.log(`   Instructor: ${payment.instructor?.name || 'NOT SET'}`);
      console.log(`   Platform Earnings: ${payment.platformEarnings || 0}`);
      console.log(`   Instructor Earnings: ${payment.instructorEarnings || 0}`);
      console.log(`   Platform %: ${payment.platformPercentage || 'NOT SET'}`);
      console.log(`   Instructor %: ${payment.instructorPercentage || 'NOT SET'}`);

      // Check for InstructorEarning record
      const instructorEarning = await InstructorEarning.findOne({ sectionPayment: payment._id });
      console.log(`   InstructorEarning Record: ${instructorEarning ? '✅ EXISTS' : '❌ MISSING'}`);
      if (instructorEarning) {
        console.log(`      Amount: ${instructorEarning.instructorEarningAmount}`);
      }

      // Check for AdminEarning record
      const adminEarning = await AdminEarning.findOne({ sectionPayment: payment._id });
      console.log(`   AdminEarning Record: ${adminEarning ? '✅ EXISTS' : '❌ MISSING'}`);
      if (adminEarning) {
        console.log(`      Amount: ${adminEarning.adminEarningAmount}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    
    // Summary
    const totalInstructorEarnings = await InstructorEarning.countDocuments();
    const totalAdminEarnings = await AdminEarning.countDocuments();
    
    console.log('\n📈 Summary:');
    console.log(`   Total Approved Payments: ${approvedPayments.length}`);
    console.log(`   Total InstructorEarning Records: ${totalInstructorEarnings}`);
    console.log(`   Total AdminEarning Records: ${totalAdminEarnings}`);
    
    const missingInstructorEarnings = approvedPayments.length - totalInstructorEarnings;
    const missingAdminEarnings = approvedPayments.length - totalAdminEarnings;
    
    if (missingInstructorEarnings > 0 || missingAdminEarnings > 0) {
      console.log('\n⚠️  Issues Found:');
      if (missingInstructorEarnings > 0) {
        console.log(`   Missing ${missingInstructorEarnings} InstructorEarning records`);
      }
      if (missingAdminEarnings > 0) {
        console.log(`   Missing ${missingAdminEarnings} AdminEarning records`);
      }
    } else {
      console.log('\n✅ All earnings records are properly created!');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

verifyPaymentEarnings();
