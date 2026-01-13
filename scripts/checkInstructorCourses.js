// Database diagnostic script to check instructor courses
// Run with: node server/scripts/checkInstructorCourses.js

require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('../models/Course');
const User = require('../models/User');

const checkInstructorCourses = async () => {
  try {
    console.log('\n========== INSTRUCTOR COURSES DIAGNOSTIC ==========\n');
    
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // 1. Find the instructor by email
    const instructorEmail = 'mahmoudtarraf77@gmail.com'; // Change if needed
    const instructor = await User.findActiveByEmail(instructorEmail);
    
    if (!instructor) {
      console.log(`❌ No user found with email: ${instructorEmail}`);
      process.exit(1);
    }

    console.log('📋 Instructor Details:');
    console.log('  ID:', instructor._id.toString());
    console.log('  Name:', instructor.name);
    console.log('  Email:', instructor.email);
    console.log('  Role:', instructor.role);
    console.log('  Instructor Status:', instructor.instructorStatus);
    console.log('');

    // 2. Count total courses in database
    const totalCourses = await Course.countDocuments({});
    console.log(`📊 Total courses in database: ${totalCourses}\n`);

    // 3. Find courses by instructor ID
    const coursesByInstructor = await Course.find({ instructor: instructor._id })
      .populate('instructor', 'name email')
      .populate('groups', 'name');
    
    console.log(`🎓 Courses for ${instructor.email}:`);
    console.log(`  Found: ${coursesByInstructor.length} courses\n`);

    if (coursesByInstructor.length > 0) {
      coursesByInstructor.forEach((course, index) => {
        console.log(`  ${index + 1}. ${course.name}`);
        console.log(`     ID: ${course._id}`);
        console.log(`     Instructor: ${course.instructor?.name} (${course.instructor?.email})`);
        console.log(`     Category: ${course.category}`);
        console.log(`     Level: ${course.level}`);
        console.log(`     Groups: ${course.groups?.length || 0}`);
        console.log(`     Active: ${course.isActive}`);
        console.log('');
      });
    } else {
      console.log('  ⚠️  No courses found for this instructor\n');
      
      // Check if there are any courses at all
      if (totalCourses > 0) {
        console.log('🔍 Checking all courses with their instructors:\n');
        const allCourses = await Course.find({})
          .populate('instructor', 'name email')
          .select('name instructor');
        
        allCourses.forEach((course, index) => {
          console.log(`  ${index + 1}. ${course.name}`);
          console.log(`     Instructor ID: ${course.instructor?._id || 'NULL'}`);
          console.log(`     Instructor Email: ${course.instructor?.email || 'NULL'}`);
          console.log(`     Match: ${course.instructor?._id?.toString() === instructor._id.toString() ? '✅ YES' : '❌ NO'}`);
          console.log('');
        });
      }
    }

    console.log('==================================================\n');
    
    // 4. Recommendations
    console.log('💡 RECOMMENDATIONS:\n');
    
    if (instructor.role !== 'instructor') {
      console.log('  ⚠️  User role is not "instructor"');
      console.log('     Update with: User.findByIdAndUpdate(id, { role: "instructor" })');
    }
    
    if (instructor.instructorStatus !== 'approved') {
      console.log('  ⚠️  Instructor status is not "approved"');
      console.log('     Update with: User.findByIdAndUpdate(id, { instructorStatus: "approved" })');
    }
    
    if (coursesByInstructor.length === 0 && totalCourses > 0) {
      console.log('  ⚠️  Courses exist but not assigned to this instructor');
      console.log('     Check instructor field in Course documents');
      console.log('     Update with: Course.updateMany({ instructor: oldId }, { instructor: correctId })');
    }
    
    if (coursesByInstructor.length === 0 && totalCourses === 0) {
      console.log('  ℹ️  No courses in database yet');
      console.log('     Create a test course via the dashboard');
    }
    
    console.log('\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

checkInstructorCourses();
