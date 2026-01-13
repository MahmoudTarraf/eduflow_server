const Course = require('../models/Course');

/**
 * Check and expire discounts that have passed their end date
 * This should be run periodically (e.g., every hour or daily via cron)
 */
const expireDiscounts = async () => {
  try {
    const now = new Date();
    
    // Find all courses with approved discounts where endDate has passed
    const expiredCourses = await Course.find({
      'discount.status': 'approved',
      'discount.endDate': { $lt: now }
    });

    console.log(`Found ${expiredCourses.length} expired discounts`);

    for (const course of expiredCourses) {
      console.log(`Expiring discount for course: ${course.name}`);
      
      // Restore original cost
      if (course.originalCost) {
        course.cost = course.originalCost;
        course.originalCost = null;
        console.log(`✅ Restored original cost: ${course.cost}`);
      }
      
      course.discount.status = 'expired';
      course.discount.price = 0;
      course.discount.percentage = 0;
      
      await course.save();
    }

    console.log(`✅ Expired ${expiredCourses.length} discounts`);
    return expiredCourses.length;
  } catch (error) {
    console.error('Error expiring discounts:', error);
    throw error;
  }
};

module.exports = { expireDiscounts };
