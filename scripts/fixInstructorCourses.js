// Script to fix instructor field in courses
// Run with: node server/scripts/fixInstructorCourses.js <instructor-email>

require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('../models/Course');
const User = require('../models/User');

const fixInstructorCourses = async () => {
  try {
    const instructorEmail = process.argv[2] || 'mahmoudtarraf77@gmail.com';
    
    console.log('\n========== FIX INSTRUCTOR COURSES ==========\n');
    
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find the instructor (active only)
    const instructor = await User.findActiveByEmail(instructorEmail);
    
    if (!instructor) {
      console.log(`❌ No user found with email: ${instructorEmail}`);
      process.exit(1);
    }

    console.log('📋 Instructor Found:');
    console.log('  ID:', instructor._id.toString());
    console.log('  Name:', instructor.name);
    console.log('  Email:', instructor.email);
    console.log('  Role:', instructor.role);
    console.log('  Status:', instructor.instructorStatus);
    console.log('');

    // Update user to be instructor if not already
    if (instructor.role !== 'instructor') {
      console.log('🔧 Updating user role to "instructor"...');
      instructor.role = 'instructor';
      await instructor.save();
      console.log('✅ Role updated\n');
    }

    // Approve instructor if not already
    if (instructor.instructorStatus !== 'approved') {
      console.log('🔧 Approving instructor...');
      instructor.instructorStatus = 'approved';
      await instructor.save();
      console.log('✅ Instructor approved\n');
    }

    // Find courses that might belong to this instructor
    // Check by email in instructor field (if it was stored as string)
    const coursesNeedingFix = await Course.find({
      $or: [
        { instructor: instructorEmail },
        { instructor: { $exists: false } },
        { instructor: null }
      ]
    });

    if (coursesNeedingFix.length > 0) {
      console.log(`🔧 Found ${coursesNeedingFix.length} courses that need fixing:\n`);
      
      for (const course of coursesNeedingFix) {
        console.log(`  Fixing: ${course.name}`);
        course.instructor = instructor._id;
        await course.save();
        console.log('  ✅ Updated\n');
      }
    } else {
      console.log('✅ No courses need fixing\n');
    }

    // Show final count
    const finalCourses = await Course.find({ instructor: instructor._id });
    console.log(`📊 Final count: ${finalCourses.length} courses assigned to ${instructor.email}\n`);

    if (finalCourses.length > 0) {
      console.log('📚 Courses:');
      finalCourses.forEach((course, index) => {
        console.log(`  ${index + 1}. ${course.name} (${course.category})`);
      });
      console.log('');
    }

    console.log('✅ Done! You can now refresh the dashboard.\n');
    console.log('============================================\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

fixInstructorCourses();
