const { validationResult } = require('express-validator');
const Rating = require('../models/Rating');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const CertificateRequest = require('../models/CertificateRequest');
const CourseGrade = require('../models/CourseGrade');
const AdminSettings = require('../models/AdminSettings');

// @desc    Get featured ratings (4-5 stars) for homepage
//          Honors admin settings: featuredRatingsLimit and per-rating hide flag.
// @route   GET /api/ratings/featured
// @access  Public
exports.getFeaturedRatings = async (req, res) => {
  try {
    const cache = require('../utils/cache');
    const cacheKey = 'featured_ratings_v1';

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, ratings: cached });
    }

    const settings = await AdminSettings.getSettings();
    const limit = typeof settings.featuredRatingsLimit === 'number'
      ? Math.max(1, Math.min(settings.featuredRatingsLimit, 50))
      : 10;

    const ratings = await Rating.find({ 
      rating: { $gte: 4 },
      review: { $exists: true, $ne: '' },
      $or: [
        { isHiddenOnHomepage: { $exists: false } },
        { isHiddenOnHomepage: false }
      ]
    })
      .select('rating review student course createdAt isHiddenOnHomepage')
      .populate('student', 'name avatar jobRole')
      .populate('course', 'name')
      .sort('-createdAt')
      .limit(limit)
      .lean();

    // Cache for 10 minutes
    cache.set(cacheKey, ratings, 10 * 60 * 1000);

    res.json({
      success: true,
      ratings
    });
  } catch (error) {
    console.error('Get featured ratings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured ratings',
      error: error.message
    });
  }
};

// @desc    List homepage-eligible ratings for admin (4+ stars, with hide/show flag)
// @route   GET /api/ratings/featured-admin
// @access  Private (Admin)
exports.getFeaturedRatingsAdmin = async (req, res) => {
  try {
    const ratings = await Rating.find({
      rating: { $gte: 4 },
      review: { $exists: true, $ne: '' }
    })
      .select('rating review student course createdAt isHiddenOnHomepage')
      .populate('student', 'name email avatar jobRole')
      .populate('course', 'name')
      .sort('-createdAt')
      .lean();

    res.json({
      success: true,
      ratings
    });
  } catch (error) {
    console.error('Get featured ratings (admin) error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured ratings for admin',
      error: error.message
    });
  }
};

// @desc    Toggle homepage visibility for a rating
// @route   PATCH /api/ratings/:id/homepage-visibility
// @access  Private (Admin)
exports.updateRatingHomepageVisibility = async (req, res) => {
  try {
    const { id } = req.params;
    const { isHiddenOnHomepage } = req.body;

    const rating = await Rating.findById(id);
    if (!rating) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    rating.isHiddenOnHomepage = Boolean(isHiddenOnHomepage);
    await rating.save();

    // Clear the cached featured ratings so changes take effect quickly
    try {
      const cache = require('../utils/cache');
      cache.del && cache.del('featured_ratings_v1');
    } catch (e) {
      // ignore cache clearing errors
    }

    res.json({
      success: true,
      message: 'Homepage visibility updated successfully',
      rating: {
        _id: rating._id,
        isHiddenOnHomepage: rating.isHiddenOnHomepage
      }
    });
  } catch (error) {
    console.error('Update rating homepage visibility error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update rating homepage visibility',
      error: error.message
    });
  }
};

// @desc    Get ratings for a course
// @route   GET /api/ratings/course/:courseId
// @access  Public
exports.getCourseRatings = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { page = 1, limit = 10, sort = '-createdAt' } = req.query;

    const ratings = await Rating.find({ course: courseId })
      .populate('student', 'name avatar jobRole')
      .sort(sort)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Rating.countDocuments({ course: courseId });

    // Calculate rating distribution
    const mongoose = require('mongoose');
    const distribution = await Rating.aggregate([
      { $match: { course: new mongoose.Types.ObjectId(courseId) } },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
      { $sort: { _id: -1 } }
    ]);

    res.json({
      success: true,
      count: ratings.length,
      total,
      ratings,
      distribution
    });
  } catch (error) {
    console.error('Get course ratings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ratings',
      error: error.message
    });
  }
};

// @desc    Create rating for a course
// @route   POST /api/ratings
// @access  Private (Student)
exports.createRating = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { course, rating, review, contentQuality, instructorSupport, valueForMoney } = req.body;
    const studentId = req.user.id;

    // Check if course exists
    const courseDoc = await Course.findById(course);
    if (!courseDoc) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Respect instructor toggle for ratings
    if (courseDoc.allowRatingAfterCompletion === false) {
      return res.status(403).json({
        success: false,
        message: 'Ratings are disabled for this course'
      });
    }

    // Check if student is enrolled
    const enrollment = await Enrollment.findOne({
      student: studentId,
      course: course
    });

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: 'You must be enrolled in this course to rate it'
      });
    }

    // Require course completion (100% progress definition) before allowing rating
    const [courseGradeRecord, settings, issuedCert] = await Promise.all([
      CourseGrade.findOne({
        student: studentId,
        course: course
      }),
      AdminSettings.getSettings(),
      CertificateRequest.findOne({
        student: studentId,
        course: course,
        status: 'issued'
      })
    ]);

    const passingGrade = typeof settings.passingGrade === 'number' ? settings.passingGrade : 60;

    let canRate = false;

    if (courseGradeRecord && courseGradeRecord.canRequestCertificate(passingGrade)) {
      // Student has completed all sections AND reached the minimum grade
      canRate = true;
    } else if (
      // Fallback: issued certificate for certificate-enabled courses also counts as completion
      issuedCert &&
      courseDoc.offersCertificate !== false &&
      courseDoc.certificateMode !== 'disabled'
    ) {
      canRate = true;
    }

    if (!canRate) {
      return res.status(403).json({
        success: false,
        message: 'You can rate this course only after completing it with the required minimum grade',
        details: {
          isComplete: Boolean(courseGradeRecord?.isComplete),
          overallGrade: courseGradeRecord ? Number(courseGradeRecord.overallGrade || 0) : null,
          passingGrade,
          hasIssuedCertificate: Boolean(issuedCert)
        }
      });
    }

    // Check if student already rated this course
    const existingRating = await Rating.findOne({
      student: studentId,
      course: course
    });

    if (existingRating) {
      return res.status(400).json({
        success: false,
        message: 'You have already rated this course. Use update instead.'
      });
    }

    // Create rating
    const newRating = await Rating.create({
      course,
      student: studentId,
      instructor: courseDoc.instructor,
      rating,
      review,
      contentQuality,
      instructorSupport,
      valueForMoney
    });

    const populatedRating = await Rating.findById(newRating._id).populate('student', 'name avatar');

    res.status(201).json({
      success: true,
      message: 'Rating created successfully',
      rating: populatedRating
    });
  } catch (error) {
    console.error('Create rating error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create rating',
      error: error.message
    });
  }
};

// @desc    Update rating
// @route   PUT /api/ratings/:id
// @access  Private (Student - own rating only)
exports.updateRating = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { rating, review, contentQuality, instructorSupport, valueForMoney } = req.body;

    const existingRating = await Rating.findById(id);

    if (!existingRating) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    // Check ownership
    if (existingRating.student.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this rating'
      });
    }

    // Update fields
    if (rating !== undefined) existingRating.rating = rating;
    if (review !== undefined) existingRating.review = review;
    if (contentQuality !== undefined) existingRating.contentQuality = contentQuality;
    if (instructorSupport !== undefined) existingRating.instructorSupport = instructorSupport;
    if (valueForMoney !== undefined) existingRating.valueForMoney = valueForMoney;

    await existingRating.save();

    const updatedRating = await Rating.findById(id)
      .populate('student', 'name avatar');

    res.json({
      success: true,
      message: 'Rating updated successfully',
      rating: updatedRating
    });
  } catch (error) {
    console.error('Update rating error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update rating',
      error: error.message
    });
  }
};

// @desc    Delete rating
// @route   DELETE /api/ratings/:id
// @access  Private (Student - own rating only, Admin)
exports.deleteRating = async (req, res) => {
  try {
    const { id } = req.params;

    const rating = await Rating.findById(id);

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    // Check ownership (students can only delete their own, admins can delete any)
    if (req.user.role !== 'admin' && rating.student.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this rating'
      });
    }

    await rating.deleteOne();

    res.json({
      success: true,
      message: 'Rating deleted successfully'
    });
  } catch (error) {
    console.error('Delete rating error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete rating',
      error: error.message
    });
  }
};

// @desc    Mark rating as helpful
// @route   POST /api/ratings/:id/helpful
// @access  Private
exports.markHelpful = async (req, res) => {
  try {
    const { id } = req.params;

    const rating = await Rating.findById(id);

    if (!rating) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    rating.helpful += 1;
    await rating.save();

    res.json({
      success: true,
      message: 'Marked as helpful',
      helpful: rating.helpful
    });
  } catch (error) {
    console.error('Mark helpful error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark as helpful',
      error: error.message
    });
  }
};

// @desc    Check if student can rate course (is enrolled, not yet rated, and completed with passing grade)
// @route   GET /api/ratings/can-rate/:courseId
// @access  Private (Student)
exports.canRateCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const studentId = req.user.id;

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if student is enrolled in the course
    const enrollment = await Enrollment.findOne({
      student: studentId,
      course: courseId
    });

    if (!enrollment) {
      return res.json({
        success: true,
        canRate: false,
        reason: 'Not enrolled in this course'
      });
    }

    // Respect instructor toggle for ratings
    if (course.allowRatingAfterCompletion === false) {
      return res.json({
        success: true,
        canRate: false,
        reason: 'Ratings are disabled for this course',
        enrollment
      });
    }

    // Check if student already rated
    const existingRating = await Rating.findOne({
      student: studentId,
      course: courseId
    });

    if (existingRating) {
      return res.json({
        success: true,
        canRate: false,
        reason: 'Already rated',
        rating: existingRating
      });
    }

    // Check course completion via CourseGrade and global passing grade
    const [courseGradeRecord, settings, certificate] = await Promise.all([
      CourseGrade.findOne({
        student: studentId,
        course: courseId
      }),
      AdminSettings.getSettings(),
      CertificateRequest.findOne({
        student: studentId,
        course: courseId,
        status: 'issued'
      })
    ]);

    const passingGrade = typeof settings.passingGrade === 'number' ? settings.passingGrade : 60;

    let canRate = false;
    let reason = 'Course not completed yet';

    if (courseGradeRecord && courseGradeRecord.canRequestCertificate(passingGrade)) {
      canRate = true;
      reason = null;
    } else if (
      // Fallback: issued certificate counts as completion for certificate-enabled courses
      certificate &&
      course.offersCertificate !== false &&
      course.certificateMode !== 'disabled'
    ) {
      canRate = true;
      reason = null;
    } else {
      reason = 'Course not completed with the minimum required grade yet';
    }

    if (canRate) {
      return res.json({
        success: true,
        canRate: true,
        enrollment,
        certificate: certificate || null,
        courseGrade: courseGradeRecord || null,
        completion: {
          mode: 'grade_based',
          isComplete: Boolean(courseGradeRecord?.isComplete),
          overallGrade: courseGradeRecord ? Number(courseGradeRecord.overallGrade || 0) : null,
          passingGrade
        }
      });
    }

    return res.json({
      success: true,
      canRate: false,
      reason,
      enrollment,
      certificate: certificate || null,
      courseGrade: courseGradeRecord || null,
      completion: {
        mode: 'grade_based',
        isComplete: Boolean(courseGradeRecord?.isComplete),
        overallGrade: courseGradeRecord ? Number(courseGradeRecord.overallGrade || 0) : null,
        passingGrade
      }
    });
  } catch (error) {
    console.error('Can rate course error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check rating eligibility',
      error: error.message
    });
  }
};

// @desc    Recalculate all course ratings (Admin utility)
// @route   POST /api/ratings/recalculate
// @access  Private (Admin)
exports.recalculateAllRatings = async (req, res) => {
  try {
    console.log('🔄 Starting recalculation of all course ratings...');
    
    const courses = await Course.find({}).select('_id name');
    let updated = 0;
    let failed = 0;

    for (const course of courses) {
      try {
        await Rating.getAverageRating(course._id);
        updated++;
      } catch (error) {
        console.error(`Failed to recalculate rating for course ${course._id}:`, error);
        failed++;
      }
    }

    console.log(`✅ Recalculation complete: ${updated} updated, ${failed} failed`);

    res.json({
      success: true,
      message: 'Ratings recalculated successfully',
      statistics: {
        totalCourses: courses.length,
        updated,
        failed
      }
    });
  } catch (error) {
    console.error('Recalculate ratings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to recalculate ratings',
      error: error.message
    });
  }
};
