const mongoose = require('mongoose');
const Badge = require('../models/Badge');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/eduflow', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const defaultBadges = [
  {
    title: 'Fast Learner',
    description: 'Complete 5 lessons',
    icon: '🚀',
    conditionType: 'lesson',
    threshold: 5,
    pointsReward: 10,
    isActive: true
  },
  {
    title: 'Quiz Master',
    description: 'Complete 5 quizzes',
    icon: '🧠',
    conditionType: 'quiz',
    threshold: 5,
    pointsReward: 15,
    isActive: true
  },
  {
    title: 'Course Finisher',
    description: 'Complete your first course',
    icon: '🎓',
    conditionType: 'course',
    threshold: 1,
    pointsReward: 50,
    isActive: true
  },
  {
    title: 'Dedicated Student',
    description: 'Maintain a 7-day login streak',
    icon: '🔥',
    conditionType: 'streak',
    threshold: 7,
    pointsReward: 25,
    isActive: true
  },
  {
    title: 'Super Streaker',
    description: 'Maintain a 30-day login streak',
    icon: '⚡',
    conditionType: 'streak',
    threshold: 30,
    pointsReward: 100,
    isActive: true
  },
  {
    title: 'Rising Star',
    description: 'Earn 100 points',
    icon: '⭐',
    conditionType: 'points',
    threshold: 100,
    pointsReward: 20,
    isActive: true
  },
  {
    title: 'Knowledge Seeker',
    description: 'Complete 20 lessons',
    icon: '📚',
    conditionType: 'lesson',
    threshold: 20,
    pointsReward: 30,
    isActive: true
  },
  {
    title: 'Champion',
    description: 'Complete 10 quizzes',
    icon: '🏆',
    conditionType: 'quiz',
    threshold: 10,
    pointsReward: 40,
    isActive: true
  },
  {
    title: 'Scholar',
    description: 'Complete 3 courses',
    icon: '🎯',
    conditionType: 'course',
    threshold: 3,
    pointsReward: 100,
    isActive: true
  },
  {
    title: 'Point Master',
    description: 'Earn 500 points',
    icon: '💎',
    conditionType: 'points',
    threshold: 500,
    pointsReward: 50,
    isActive: true
  }
];

async function seedBadges() {
  try {
    console.log('Seeding default badges...');
    
    // Clear existing badges
    await Badge.deleteMany({});
    console.log('Cleared existing badges');
    
    // Insert default badges
    const badges = await Badge.insertMany(defaultBadges);
    console.log(`✅ Successfully created ${badges.length} badges`);
    
    badges.forEach(badge => {
      console.log(`  - ${badge.icon} ${badge.title}: ${badge.description}`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('Error seeding badges:', error);
    process.exit(1);
  }
}

seedBadges();
