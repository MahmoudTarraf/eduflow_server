const cron = require('node-cron');
const Course = require('../models/Course');
const Section = require('../models/Section');

// Run every hour to check for expired discounts
const checkExpiredDiscounts = async () => {
  try {
    console.log('🕐 Checking for expired discounts...');
    
    const now = new Date();
    const expiredCourses = await Course.find({
      'discount.status': 'approved',
      'discount.endDate': { $lt: now }
    });

    console.log(`Found ${expiredCourses.length} expired discounts`);

    for (const course of expiredCourses) {
      console.log(`⏰ Reverting discount for course: ${course.name}`);

      // Restore original cost
      if (course.originalCost) {
        course.cost = course.originalCost;
        course.originalCost = null;
      }

      // Mark discount as expired
      course.discount.status = 'expired';
      
      await course.save();

      console.log(`✅ Discount reverted for: ${course.name}`);
    }

    if (expiredCourses.length > 0) {
      console.log(`✅ Successfully processed ${expiredCourses.length} expired discounts`);
    }
  } catch (error) {
    console.error('❌ Error checking expired discounts:', error);
  }
};

// Schedule to run every hour
const startDiscountScheduler = () => {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', checkExpiredDiscounts);
  console.log('✅ Discount scheduler started - checking every hour');
  
  // Run immediately on startup
  checkExpiredDiscounts();
};

module.exports = { startDiscountScheduler, checkExpiredDiscounts };
