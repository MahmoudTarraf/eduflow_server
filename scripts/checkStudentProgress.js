const mongoose = require('mongoose');
const User = require('../models/User');
const Progress = require('../models/Progress');
const Group = require('../models/Group');
const StudentPayment = require('../models/StudentPayment');
const Section = require('../models/Section');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eduflow', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function checkStudentProgress() {
  try {
    console.log('\n=== STUDENT PROGRESS DIAGNOSTIC SCRIPT ===\n');

    // Find all students
    const students = await User.find({ role: 'student' }).limit(5);
    
    if (students.length === 0) {
      console.log('No students found in database');
      process.exit(0);
    }

    for (const student of students) {
      console.log(`\n--- Student: ${student.name} (${student.email}) ---`);
      console.log(`Student ID: ${student._id}`);
      
      // Check enrolled courses
      if (student.enrolledCourses && student.enrolledCourses.length > 0) {
        console.log(`\nEnrolled Courses (${student.enrolledCourses.length}):`);
        
        for (const enrollment of student.enrolledCourses) {
          const courseId = enrollment.course;
          const groupId = enrollment.group;
          
          console.log(`\n  Course ID: ${courseId}`);
          console.log(`  Group ID: ${groupId}`);
          console.log(`  Status: ${enrollment.status}`);
          
          // Check Progress
          const progress = await Progress.findOne({
            student: student._id,
            course: courseId
          });
          
          if (progress) {
            console.log(`  ✅ Progress Found:`);
            console.log(`     - Overall: ${progress.overallProgress?.total || 0}%`);
            console.log(`     - Lectures: ${progress.overallProgress?.lectures || 0}%`);
            console.log(`     - Assignments: ${progress.overallProgress?.assignments || 0}%`);
            console.log(`     - Projects: ${progress.overallProgress?.projects || 0}%`);
          } else {
            console.log(`  ❌ No Progress Record Found`);
          }
          
          // Check Group Payment Status
          if (groupId) {
            const group = await Group.findById(groupId);
            if (group) {
              const studentInGroup = group.students.find(
                s => s.student.toString() === student._id.toString()
              );
              
              if (studentInGroup) {
                console.log(`  💰 Group Payment Info:`);
                console.log(`     - Status: ${studentInGroup.paymentStatus || 'N/A'}`);
                console.log(`     - Method: ${studentInGroup.paymentMethod || 'N/A'}`);
                console.log(`     - Entry Fee Paid: ${studentInGroup.entryFeePaid || false}`);
              }
            }
          }
          
          // Check Verified Payments
          const verifiedPayments = await StudentPayment.find({
            student: student._id,
            course: courseId,
            verified: true
          }).populate('section', 'name');
          
          if (verifiedPayments.length > 0) {
            console.log(`  ✅ Verified Payments (${verifiedPayments.length}):`);
            verifiedPayments.forEach(payment => {
              console.log(`     - Section: ${payment.section?.name || 'N/A'}`);
              console.log(`       Amount: ${payment.amountSYR} SYR`);
              console.log(`       Status: ${payment.status}`);
            });
          } else {
            console.log(`  ℹ️  No Verified Payments`);
          }
          
          // Check Total Sections
          const sections = await Section.find({ course: courseId });
          console.log(`  📚 Total Sections: ${sections.length}`);
          if (sections.length > 0) {
            const freeSections = sections.filter(s => s.isFree).length;
            const paidSections = sections.length - freeSections;
            console.log(`     - Free: ${freeSections}, Paid: ${paidSections}`);
          }
        }
      } else {
        console.log('No enrolled courses');
      }
    }

    console.log('\n=== DIAGNOSTIC COMPLETE ===\n');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the diagnostic
checkStudentProgress();
