const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const SectionPayment = require('../models/SectionPayment');
const InstructorEarning = require('../models/InstructorEarning');
const AdminEarning = require('../models/AdminEarning');
const Course = require('../models/Course');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const AdminSettings = require('../models/AdminSettings');

async function recalculatePaymentEarnings() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/eduflow-academy';
    await mongoose.connect(uri);
    console.log('✅ Connected to database');

    // Find all approved payments
    const allApprovedPayments = await SectionPayment.find({
      status: 'approved'
    }).populate('course');

    console.log(`\n📊 Found ${allApprovedPayments.length} approved payments\n`);

    if (allApprovedPayments.length === 0) {
      console.log('✅ No approved payments found');
      process.exit(0);
    }

    // Filter payments that need processing
    const paymentsToProcess = [];
    for (const payment of allApprovedPayments) {
      const needsEarningsCalc = !payment.platformEarnings || !payment.instructorEarnings;
      const hasInstructorEarning = await InstructorEarning.findOne({ sectionPayment: payment._id });
      const hasAdminEarning = await AdminEarning.findOne({ sectionPayment: payment._id });
      
      if (needsEarningsCalc || !hasInstructorEarning || !hasAdminEarning) {
        paymentsToProcess.push({
          payment,
          needsEarningsCalc,
          missingInstructorEarning: !hasInstructorEarning,
          missingAdminEarning: !hasAdminEarning
        });
      }
    }

    console.log(`📝 Payments needing processing: ${paymentsToProcess.length}\n`);

    if (paymentsToProcess.length === 0) {
      console.log('✅ All approved payments have proper earnings records');
      process.exit(0);
    }

    let updated = 0;
    let failed = 0;
    let instructorEarningsCreated = 0;
    let adminEarningsCreated = 0;

    for (const item of paymentsToProcess) {
      try {
        const payment = item.payment;
        console.log(`\n🔄 Processing payment ${payment._id}...`);
        console.log(`   Needs earnings calc: ${item.needsEarningsCalc ? 'YES' : 'NO'}`);
        console.log(`   Missing InstructorEarning: ${item.missingInstructorEarning ? 'YES' : 'NO'}`);
        console.log(`   Missing AdminEarning: ${item.missingAdminEarning ? 'YES' : 'NO'}`);
        
        // Get instructor from course
        const course = await Course.findById(payment.course._id);
        if (!course || !course.instructor) {
          console.log(`⚠️  Skipping payment ${payment._id}: No instructor found`);
          failed++;
          continue;
        }

        // Get instructor's percentage
        let instructorPercentage = 70;
        let platformPercentage = 30;

        const agreement = await InstructorEarningsAgreement.findOne({
          instructor: course.instructor,
          status: 'approved',
          isActive: true
        }).sort({ createdAt: -1 });

        if (agreement) {
          instructorPercentage = agreement.instructorPercentage;
          platformPercentage = agreement.platformPercentage;
        } else {
          const settings = await AdminSettings.getSettings();
          instructorPercentage = settings.instructorRevenuePercentage || 70;
          platformPercentage = settings.platformRevenuePercentage || 30;
        }

        // Calculate earnings
        const totalAmount = payment.amountCents;
        let instructorEarnings, platformEarnings;

        // Only recalculate if needed, otherwise use existing values
        if (item.needsEarningsCalc) {
          instructorEarnings = Math.floor((totalAmount * instructorPercentage) / 100);
          platformEarnings = totalAmount - instructorEarnings;

          // Update payment
          payment.instructor = course.instructor;
          payment.instructorEarnings = instructorEarnings;
          payment.platformEarnings = platformEarnings;
          payment.instructorPercentage = instructorPercentage;
          payment.platformPercentage = platformPercentage;
          
          await payment.save();
          console.log(`   ✅ Updated payment earnings`);
        } else {
          // Use existing values
          instructorEarnings = payment.instructorEarnings;
          platformEarnings = payment.platformEarnings;
          instructorPercentage = payment.instructorPercentage;
          platformPercentage = payment.platformPercentage;
          console.log(`   ℹ️  Using existing payment earnings`);
        }

        // Check if InstructorEarning record already exists
        const existingInstructorEarning = await InstructorEarning.findOne({
          sectionPayment: payment._id
        });

        if (!existingInstructorEarning) {
          // Create InstructorEarning record
          await InstructorEarning.create({
            instructor: course.instructor,
            student: payment.student,
            course: payment.course,
            section: payment.section,
            sectionPayment: payment._id,
            studentPaidAmount: totalAmount,
            currency: payment.currency,
            instructorPercentage: instructorPercentage,
            instructorEarningAmount: instructorEarnings,
            adminCommissionAmount: platformEarnings,
            status: 'accrued',
            paymentMethod: payment.paymentMethod,
            accruedAt: payment.processedAt || new Date()
          });
          
          instructorEarningsCreated++;
        }

        // Check if AdminEarning record already exists
        const existingAdminEarning = await AdminEarning.findOne({
          sectionPayment: payment._id
        });

        if (!existingAdminEarning) {
          // Create AdminEarning record
          await AdminEarning.create({
            sectionPayment: payment._id,
            student: payment.student,
            course: payment.course,
            section: payment.section,
            instructor: course.instructor,
            totalAmount: totalAmount,
            currency: payment.currency,
            instructorPercentage: instructorPercentage,
            adminCommissionPercentage: platformPercentage,
            adminEarningAmount: platformEarnings,
            instructorEarningAmount: instructorEarnings,
            paymentMethod: payment.paymentMethod,
            transactionDate: payment.processedAt || new Date()
          });
          
          adminEarningsCreated++;
        }

        console.log(`   ✅ Payment ${payment._id} processed successfully`);

        updated++;
      } catch (error) {
        console.error(`❌ Failed to update payment ${payment._id}:`, error.message);
        failed++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Updated: ${updated} payments`);
    console.log(`   📝 InstructorEarning records created: ${instructorEarningsCreated}`);
    console.log(`   📝 AdminEarning records created: ${adminEarningsCreated}`);
    console.log(`   ❌ Failed: ${failed} payments`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Script error:', error);
    process.exit(1);
  }
}

recalculatePaymentEarnings();
