const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Category = require('../models/Category');
const User = require('../models/User');

const defaultCategories = [
  {
    name: 'Programming',
    description: 'Programming and software development courses',
    icon: 'code'
  },
  {
    name: 'Languages',
    description: 'Language learning and linguistics courses',
    icon: 'language'
  }
];

async function seedCategories() {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    // Find an admin user to be the creator
    const admin = await User.findOne({ role: 'admin' });
    
    if (!admin) {
      console.error('No admin user found. Please create an admin user first.');
      process.exit(1);
    }

    console.log('Admin user found:', admin.email);

    // Check and create categories
    for (const categoryData of defaultCategories) {
      const existing = await Category.findOne({ name: categoryData.name });
      
      if (existing) {
        console.log(`✓ Category "${categoryData.name}" already exists`);
      } else {
        await Category.create({
          ...categoryData,
          createdBy: admin._id
        });
        console.log(`✓ Created category: ${categoryData.name}`);
      }
    }

    console.log('\n✅ Category seeding completed!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding categories:', error);
    process.exit(1);
  }
}

seedCategories();
