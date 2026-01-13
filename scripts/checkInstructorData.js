const mongoose = require('mongoose');
const User = require('../models/User');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const checkInstructorData = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ Connected to MongoDB\n');

    // Find all instructors
    const instructors = await User.find({ role: 'instructor' });
    console.log(`📊 Total Instructors: ${instructors.length}\n`);

    for (const instructor of instructors) {
      console.log('=' .repeat(80));
      console.log(`👤 Instructor: ${instructor.name} (${instructor.email})`);
      console.log(`   ID: ${instructor._id}`);
      console.log(`   Status: ${instructor.instructorStatus}`);
      console.log(`   Approved: ${instructor.instructorStatus === 'approved' ? '✅' : '❌'}`);
      console.log('-'.repeat(80));

      // Find all courses by this instructor
      const allCourses = await Course.find({ instructor: instructor._id });
      console.log(`📚 Total Courses: ${allCourses.length}`);

      if (allCourses.length > 0) {
        for (const course of allCourses) {
          console.log(`\n   Course: ${course.name}`);
          console.log(`   - ID: ${course._id}`);
          console.log(`   - Published: ${course.isPublished !== false ? '✅ Yes' : '❌ No'} (value: ${course.isPublished})`);
          console.log(`   - Rating: ${course.rating || 'N/A'}`);
          console.log(`   - Level: ${course.level || 'N/A'}`);
          console.log(`   - Category: ${course.category || 'N/A'}`);
          console.log(`   - Image: ${course.image ? '✅' : '❌'}`);

          // Check enrollments for this course
          const enrollments = await Enrollment.find({ course: course._id });
          console.log(`   - Enrollments: ${enrollments.length}`);
          
          if (enrollments.length > 0) {
            for (const enrollment of enrollments) {
              const student = await User.findById(enrollment.student);
              console.log(`     • Student: ${student ? student.name : 'Unknown'} (${enrollment.status})`);
            }
          }
        }
      }

      // Check published courses only
      const publishedCourses = allCourses.filter(c => c.isPublished !== false);
      console.log(`\n📖 Published Courses: ${publishedCourses.length}`);

      // Check total unique students across published courses
      const courseIds = publishedCourses.map(c => c._id);
      const uniqueStudents = await Enrollment.distinct('student', {
        course: { $in: courseIds }
      });
      console.log(`👥 Total Unique Students: ${uniqueStudents.length}`);

      console.log('=' .repeat(80) + '\n');
    }

    console.log('\n✅ Diagnostic Complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
};

checkInstructorData();
