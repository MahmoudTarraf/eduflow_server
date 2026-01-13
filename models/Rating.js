const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  course: {
    type: mongoose.Schema.ObjectId,
    ref: 'Course',
    required: true
  },
  student: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  instructor: {
    type: mongoose.Schema.ObjectId,
    ref: 'User'
  },
  rating: {
    type: Number,
    required: [true, 'Rating is required'],
    min: [1, 'Rating must be at least 1'],
    max: [5, 'Rating cannot be more than 5']
  },
  review: {
    type: String,
    maxlength: [1000, 'Review cannot exceed 1000 characters']
  },
  // Visibility controls
  isHiddenOnHomepage: {
    type: Boolean,
    default: false
  },
  // Individual rating categories
  contentQuality: {
    type: Number,
    min: 1,
    max: 5
  },
  instructorSupport: {
    type: Number,
    min: 1,
    max: 5
  },
  valueForMoney: {
    type: Number,
    min: 1,
    max: 5
  },
  // Metadata
  helpful: {
    type: Number,
    default: 0 // Count of users who found this review helpful
  },
  reported: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
ratingSchema.index({ course: 1, student: 1 }, { unique: true }); // One rating per student per course
ratingSchema.index({ course: 1, rating: -1 });
ratingSchema.index({ instructor: 1 });

// Calculate average rating for a course
ratingSchema.statics.getAverageRating = async function(courseId) {
  try {
    const result = await this.aggregate([
      { $match: { course: new mongoose.Types.ObjectId(courseId) } },
      {
        $group: {
          _id: '$course',
          averageRating: { $avg: '$rating' },
          totalRatings: { $sum: 1 }
        }
      }
    ]);

    if (result.length > 0) {
      // Update course with average rating (rounded to 1 decimal)
      const avgRating = Math.round(result[0].averageRating * 10) / 10;
      await mongoose.model('Course').findByIdAndUpdate(courseId, {
        averageRating: avgRating,
        totalRatings: result[0].totalRatings
      });
      
      console.log(`✅ Updated course ${courseId} rating: ${avgRating} (${result[0].totalRatings} ratings)`);
      return { averageRating: avgRating, totalRatings: result[0].totalRatings };
    } else {
      // No ratings found, set to 0
      await mongoose.model('Course').findByIdAndUpdate(courseId, {
        averageRating: 0,
        totalRatings: 0
      });
      
      console.log(`ℹ️ Reset course ${courseId} rating to 0 (no ratings)`);
      return { averageRating: 0, totalRatings: 0 };
    }
  } catch (error) {
    console.error('Error calculating average rating:', error);
    return { averageRating: 0, totalRatings: 0 };
  }
};

// Calculate and store aggregated rating for an instructor across all their courses
ratingSchema.statics.updateInstructorRating = async function(instructorId) {
  try {
    const mongoose = require('mongoose');
    const User = mongoose.model('User');

    if (!instructorId) {
      return { ratingValue: 0, ratingCount: 0 };
    }

    const result = await this.aggregate([
      { $match: { instructor: new mongoose.Types.ObjectId(instructorId) } },
      {
        $group: {
          _id: '$instructor',
          ratingValue: { $avg: '$rating' },
          ratingCount: { $sum: 1 }
        }
      }
    ]);

    if (result.length > 0) {
      const avg = Math.round(result[0].ratingValue * 10) / 10;
      const count = result[0].ratingCount;
      await User.findByIdAndUpdate(instructorId, {
        ratingValue: avg,
        ratingCount: count
      });
      return { ratingValue: avg, ratingCount: count };
    } else {
      await User.findByIdAndUpdate(instructorId, {
        ratingValue: 0,
        ratingCount: 0
      });
      return { ratingValue: 0, ratingCount: 0 };
    }
  } catch (error) {
    console.error('Error updating instructor rating:', error);
    return { ratingValue: 0, ratingCount: 0 };
  }
};

// Update course average rating after save
ratingSchema.post('save', async function() {
  await this.constructor.getAverageRating(this.course);
  if (this.instructor) {
    await this.constructor.updateInstructorRating(this.instructor);
  }
});

// Update course average rating after remove
ratingSchema.post('remove', async function() {
  await this.constructor.getAverageRating(this.course);
  if (this.instructor) {
    await this.constructor.updateInstructorRating(this.instructor);
  }
});

// Update course average rating after deleteOne
ratingSchema.post('deleteOne', { document: true, query: false }, async function() {
  await this.constructor.getAverageRating(this.course);
  if (this.instructor) {
    await this.constructor.updateInstructorRating(this.instructor);
  }
});

module.exports = mongoose.model('Rating', ratingSchema);
