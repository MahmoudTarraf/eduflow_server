const User = require('../models/User');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const InstructorAgreement = require('../models/InstructorAgreement');

function stripHtml(input) {
  if (!input || typeof input !== 'string') return '';
  // Remove tags and collapse whitespace
  const text = input
    .replace(/<[^>]*>/g, ' ') // strip tags
    .replace(/\s+/g, ' ')     // collapse spaces
    .trim();
  return text;
}

// @desc    Get all approved instructors with their stats
// @route   GET /api/instructors/public
// @access  Public
exports.getPublicInstructors = async (req, res) => {
  try {
    // Get all approved, non-deleted instructors
    const instructors = await User.find({ 
      role: 'instructor',
      instructorStatus: 'approved',
      isDeleted: { $ne: true },
      status: { $ne: 'deleted' }
    })
    .select('name email bio aboutMe expertise socialLinks avatar')
    .lean();

    const instructorIds = instructors.map((i) => i._id);
    const agreements = await InstructorAgreement.find({
      instructor: { $in: instructorIds },
      'introductionVideo.url': { $exists: true, $ne: null }
    })
      .select('instructor introductionVideo')
      .lean();

    const introVideoByInstructorId = new Map();
    agreements.forEach((a) => {
      if (!a?.instructor || !a?.introductionVideo) return;
      introVideoByInstructorId.set(String(a.instructor), a.introductionVideo);
    });

    // Enrich with course and student counts
    const enrichedInstructors = await Promise.all(
      instructors.map(async (instructor) => {
        // Count courses
        const courseCount = await Course.countDocuments({ 
          instructor: instructor._id,
          isPublished: true 
        });

        // Count unique students across all their courses
        const courses = await Course.find({ 
          instructor: instructor._id,
          isPublished: true 
        }).select('_id');
        
        const courseIds = courses.map(c => c._id);
        const enrollments = await Enrollment.distinct('student', {
          course: { $in: courseIds }
        });
        
        const studentCount = enrollments.length;

        const introVideo = introVideoByInstructorId.get(String(instructor._id)) || null;

        return {
          ...instructor,
          // Keep original rich HTML in aboutMe, and provide helpers for UI
          aboutMePlain: stripHtml(instructor.aboutMe || ''),
          aboutMeHtml: instructor.aboutMe || '',
          courseCount,
          studentCount,
          introVideo: introVideo
            ? {
                storageType: introVideo.storageType || null,
                youtubeVideoId: introVideo.youtubeVideoId || null,
                youtubeUrl: introVideo.youtubeUrl || null,
                videoUrl: introVideo.url || null,
                uploadedAt: introVideo.uploadedAt || null
              }
            : null
        };
      })
    );

    res.json({
      success: true,
      count: enrichedInstructors.length,
      instructors: enrichedInstructors
    });
  } catch (error) {
    console.error('Get public instructors error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch instructors',
      error: error.message
    });
  }
};

// @desc    Get single instructor profile with full details
// @route   GET /api/instructors/:id
// @access  Public
exports.getInstructorProfile = async (req, res) => {
  try {
    console.log('[Instructor Profile] Fetching instructor:', req.params.id);
    
    const instructor = await User.findOne({
      _id: req.params.id,
      role: 'instructor',
      instructorStatus: 'approved',
      isDeleted: { $ne: true },
      status: { $ne: 'deleted' }
    })
    .select('name email bio aboutMe expertise socialLinks avatar createdAt ratingValue ratingCount')
    .lean();

    if (!instructor) {
      console.log('[Instructor Profile] Instructor not found or not approved');
      return res.status(404).json({
        success: false,
        message: 'Instructor not found'
      });
    }

    console.log('[Instructor Profile] Instructor found:', instructor.name);

    // Get instructor's courses (both published and unpublished for better debugging)
    const allCourses = await Course.find({ 
      instructor: instructor._id
    })
    .select('name description level duration thumbnail price image category isPublished rating')
    .lean();

    console.log('[Instructor Profile] Total courses found:', allCourses.length);
    console.log('[Instructor Profile] All courses details:', JSON.stringify(allCourses, null, 2));

    // Check if courses exist but are unpublished
    const unpublishedCourses = allCourses.filter(c => c.isPublished === false);
    console.log('[Instructor Profile] Unpublished courses:', unpublishedCourses.length);
    
    // Filter published courses for public display (only include explicitly published courses)
    const courses = allCourses.filter(c => c.isPublished === true);

    console.log('[Instructor Profile] Published courses:', courses.length);
    console.log('[Instructor Profile] Published courses details:', JSON.stringify(courses, null, 2));
    
    // If no published courses but has unpublished, log a warning
    if (courses.length === 0 && unpublishedCourses.length > 0) {
      console.log('[Instructor Profile] ⚠️ WARNING: Instructor has courses but they are not published!');
      console.log('[Instructor Profile] Unpublished course names:', unpublishedCourses.map(c => c.name));
    }

    // Count total students across all courses
    const courseIds = courses.map(c => c._id);
    console.log('[Instructor Profile] Course IDs to check enrollments:', courseIds);
    
    const enrollments = await Enrollment.distinct('student', {
      course: { $in: courseIds }
    });

    console.log('[Instructor Profile] Total unique students:', enrollments.length);
    console.log('[Instructor Profile] Student IDs:', enrollments);
    
    // Also get full enrollment details for debugging
    const allEnrollments = await Enrollment.find({
      course: { $in: courseIds }
    }).select('student course status').lean();
    console.log('[Instructor Profile] All enrollments:', JSON.stringify(allEnrollments, null, 2));

    res.json({
      success: true,
      instructor: {
        ...instructor,
        // Keep rich HTML in aboutMe for profile pages, and also provide helpers
        aboutMePlain: stripHtml(instructor.aboutMe || ''),
        aboutMeHtml: instructor.aboutMe || '',
        courseCount: courses.length,
        studentCount: enrollments.length,
        averageRating: typeof instructor.ratingValue === 'number' ? instructor.ratingValue : 0,
        ratingCount: typeof instructor.ratingCount === 'number' ? instructor.ratingCount : 0,
        courses: courses.map(c => ({
          ...c,
          isPublished: undefined // Remove from public response
        }))
      }
    });
  } catch (error) {
    console.error('[Instructor Profile] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch instructor profile',
      error: error.message
    });
  }
};
