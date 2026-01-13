const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

const Course = require('../models/Course');
const Section = require('../models/Section');
const Group = require('../models/Group');

const diagnoseSections = async () => {
  try {
    console.log('🔍 Connecting to MongoDB...');
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/eduflow-academy';
    console.log(`   URI: ${uri}`);
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB\n');

    // Get all courses
    const courses = await Course.find({})
      .select('name cost offersCertificate certificate')
      .lean();

    console.log(`📚 Found ${courses.length} courses\n`);
    console.log('=' .repeat(80));

    for (const course of courses) {
      console.log(`\n📖 Course: ${course.name}`);
      console.log(`   ID: ${course._id}`);
      console.log(`   Cost: ${course.cost || 0}`);
      console.log(`   offersCertificate: ${course.offersCertificate}`);
      console.log(`   certificate.isAvailable: ${course.certificate?.isAvailable}`);
      
      // Get groups for this course
      const groups = await Group.find({ course: course._id })
        .select('name')
        .lean();
      
      console.log(`   Groups: ${groups.length}`);

      // Get sections for this course
      const sections = await Section.find({ course: course._id })
        .select('name price group')
        .populate('group', 'name')
        .lean();

      if (sections.length > 0) {
        console.log(`   \n   📑 Sections (${sections.length}):`);
        let totalSectionPrice = 0;
        for (const section of sections) {
          const price = section.price || 0;
          totalSectionPrice += price;
          console.log(`      - ${section.name}`);
          console.log(`        Group: ${section.group?.name || 'No Group'}`);
          console.log(`        Price: ${price}`);
          console.log(`        ID: ${section._id}`);
        }
        console.log(`   \n   💰 Total Section Prices: ${totalSectionPrice}`);
        
        if (course.cost && totalSectionPrice > course.cost) {
          console.log(`   ⚠️  WARNING: Total section prices (${totalSectionPrice}) exceed course cost (${course.cost})`);
        }
      } else {
        console.log(`   📑 No sections found`);
      }
      
      console.log('\n' + '='.repeat(80));
    }

    // Check for any pending cost changes
    const PendingCourseCostChange = require('../models/PendingCourseCostChange');
    const pendingChanges = await PendingCourseCostChange.find({})
      .populate('course', 'name')
      .populate('instructor', 'name email')
      .lean();

    if (pendingChanges.length > 0) {
      console.log(`\n\n⏳ Pending Cost Changes (${pendingChanges.length}):\n`);
      for (const change of pendingChanges) {
        console.log(`   Course: ${change.course?.name}`);
        console.log(`   Status: ${change.status}`);
        console.log(`   Old Cost: ${change.oldCost}`);
        console.log(`   New Cost: ${change.newCost}`);
        console.log(`   Total Paid Sections: ${change.totalPaidSections}`);
        console.log(`   Affected Sections: ${change.affectedSections?.length || 0}`);
        console.log(`   Created: ${change.createdAt}`);
        if (change.confirmedAt) {
          console.log(`   Confirmed: ${change.confirmedAt}`);
        }
        console.log('   ---');
      }
    }

    console.log('\n✅ Diagnosis complete!\n');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
};

diagnoseSections();
