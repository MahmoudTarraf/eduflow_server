const mongoose = require('mongoose');
const Course = require('../models/Course');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const publishAllCourses = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ Connected to MongoDB\n');

    // Find all unpublished courses
    const unpublishedCourses = await Course.find({ isPublished: false });
    console.log(`📚 Found ${unpublishedCourses.length} unpublished courses\n`);

    if (unpublishedCourses.length === 0) {
      console.log('✅ All courses are already published!');
      process.exit(0);
    }

    // Publish all courses
    const result = await Course.updateMany(
      { isPublished: false },
      { $set: { isPublished: true } }
    );

    console.log(`✅ Published ${result.modifiedCount} courses!`);
    
    // Show what was published
    for (const course of unpublishedCourses) {
      console.log(`   ✓ ${course.name}`);
    }

    console.log('\n✅ All courses are now published and visible!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

publishAllCourses();
