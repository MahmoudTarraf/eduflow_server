const { validationResult } = require('express-validator');
const Course = require('../models/Course');
const User = require('../models/User');
const Group = require('../models/Group');
const ActiveTest = require('../models/ActiveTest');
const Progress = require('../models/Progress');
const Submission = require('../models/Submission');
const Enrollment = require('../models/Enrollment');
const Message = require('../models/Message');
const { sendEmail } = require('../utils/sendEmail');
const cache = require('../utils/cache');

const {
  calculateOverallGrade,
  determineSectionAccess,
  getLatestPaymentsForStudent,
  getLatestPaymentsForStudents,
  getSectionGradesForStudent,
  getSectionGradesForStudents,
  getStudentEnrollment,
  loadCourseSections,
  toPlainPayment
} = require('../utils/gradeUtils');

// @desc    Get instructor's courses
// @route   GET /api/courses/my-courses
// @access  Private (Instructor)
exports.getInstructorCourses = async (req, res) => {
  try {
    console.log('========== GET INSTRUCTOR COURSES DEBUG ==========');
    console.log('Request User:', {
      id: req.user.id,
      _id: req.user._id,
      email: req.user.email,
      role: req.user.role
    });

    // First, check total courses in database
    const totalCourses = await Course.countDocuments({});
    console.log(`Total courses in database: ${totalCourses}`);

    // Try to find courses with instructor matching user id
    let courses = await Course.find({ instructor: req.user.id })
      .populate('instructor', 'name email avatar')
      .populate('groups', 'name currentStudents maxStudents startDate endDate')
      .populate('lectures', 'title url duration')
      .sort({ createdAt: -1 });

    console.log(`Found ${courses.length} courses with instructor === req.user.id`);

    // If no courses found, try with _id field as backup
    if (courses.length === 0 && req.user._id) {
      console.log('Trying with req.user._id as fallback...');
      courses = await Course.find({ instructor: req.user._id })
        .populate('instructor', 'name email avatar')
        .populate('groups', 'name currentStudents maxStudents startDate endDate')
        .populate('lectures', 'title url duration')
        .sort({ createdAt: -1 });
      console.log(`Found ${courses.length} courses with instructor === req.user._id`);
    }

    // Debug: Check what instructor IDs exist in courses
    if (courses.length === 0) {
      const allCourses = await Course.find({}).select('name instructor').populate('instructor', 'email');
      console.log('All courses with instructor info:', allCourses.map(c => ({
        name: c.name,
        instructorId: c.instructor?._id,
        instructorEmail: c.instructor?.email
      })));
    }

    console.log('Final courses being returned:', courses.length);
    console.log('==================================================');

    res.json({
      success: true,
      count: courses.length,
      courses
    });
  } catch (error) {
    console.error('Get instructor courses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get all courses
// @route   GET /api/courses
// @access  Public
exports.getCourses = async (req, res) => {
  try {
    const { category, level, instructor, page = 1, limit = 10 } = req.query;
    
    let query = { isActive: true, isPublished: true, isArchived: { $ne: true } };
    
    if (category) {
      query.category = category;
    }
    
    if (level) {
      query.level = level;
    }
    
    // Filter by instructor if provided
    if (instructor) {
      query.instructor = instructor;
    }

    // Cache default first page without filters (homepage)
    const canCache = false;
    const cacheKey = null;
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.json({ success: true, count: cached.length, total: cached.length, courses: cached });
      }
    }

    const courses = await Course.find(query)
      .select('name description category level image averageRating totalRatings groups duration cost originalCost currency discount instructor isOrphaned originalInstructor')
      .populate('instructor', 'name avatar')
      .populate('originalInstructor', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Course.countDocuments(query);

    if (cacheKey) {
      cache.set(cacheKey, courses, 5 * 60 * 1000); // 5 minutes
    }

    res.json({
      success: true,
      count: courses.length,
      total,
      courses
    });
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all courses for admin (including archived and unpublished)
// @route   GET /api/courses/all
// @access  Private (Admin)
exports.getAllCoursesAdmin = async (req, res) => {
  try {
    const { category, level, instructor, page = 1, limit = 50 } = req.query;

    const query = {};

    if (category) {
      query.category = category;
    }

    if (level) {
      query.level = level;
    }

    if (instructor) {
      query.instructor = instructor;
    }

    const courses = await Course.find(query)
      .select('name description category level image averageRating totalRatings groups duration cost originalCost currency discount instructor isArchived isActive isPublished approvalStatus isOrphaned originalInstructor')
      .populate('instructor', 'name email avatar isDeleted status')
      .populate('originalInstructor', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Course.countDocuments(query);

    res.json({
      success: true,
      count: courses.length,
      total,
      courses
    });
  } catch (error) {
    console.error('Get all courses (admin) error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reassign course instructor (Admin only)
// @route   PUT /api/courses/:id/reassign-instructor
// @access  Private (Admin)
exports.reassignCourseInstructor = async (req, res) => {
  try {
    const { id } = req.params; // courseId
    const { newInstructorId } = req.body || {};

    if (!newInstructorId) {
      return res.status(400).json({
        success: false,
        message: 'New instructor ID is required'
      });
    }

    const course = await Course.findById(id).populate('instructor', 'name email isDeleted status');

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    const newInstructor = await User.findById(newInstructorId).select('role isDeleted status name email');

    if (!newInstructor || newInstructor.role !== 'instructor') {
      return res.status(400).json({
        success: false,
        message: 'Target user is not a valid instructor'
      });
    }

    if (newInstructor.isDeleted || newInstructor.status === 'deleted') {
      return res.status(400).json({
        success: false,
        message: 'Cannot assign course to a deleted instructor'
      });
    }

    const oldInstructorId = course.instructor ? (course.instructor._id || course.instructor) : null;

    // Preserve originalInstructor if already set. If not set and there is an old instructor,
    // lock originalInstructor to the previous instructor before reassignment.
    if (!course.originalInstructor && oldInstructorId) {
      course.originalInstructor = oldInstructorId;
    }

    // Reassign ownership to the new instructor and clear orphaned state
    course.instructor = newInstructor._id;
    course.isOrphaned = false;
    await course.save();

    // Update all groups under this course to point to the new instructor
    await Group.updateMany(
      { course: course._id },
      { $set: { instructor: newInstructor._id } }
    );

    // Update active tests for this course so that only the new instructor can manage them
    await ActiveTest.updateMany(
      { course: course._id },
      { $set: { instructor: newInstructor._id } }
    );

    console.log('✅ Course instructor reassigned', {
      courseId: course._id.toString(),
      oldInstructor: oldInstructorId ? oldInstructorId.toString() : null,
      newInstructor: newInstructor._id.toString()
    });

    return res.json({
      success: true,
      message: 'Course instructor reassigned successfully',
      data: {
        courseId: course._id,
        oldInstructor: oldInstructorId,
        newInstructor: newInstructor._id
      }
    });
  } catch (error) {
    console.error('Reassign course instructor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reassign course instructor',
      error: error.message
    });
  }
};

// @desc    Search courses
// @route   GET /api/courses/search
// @access  Public
exports.searchCourses = async (req, res) => {
  try {
    const { q, category, level, page = 1, limit = 10 } = req.query;
    
   let query = { isActive: true, isPublished: true, isArchived: { $ne: true } };
    
    if (q) {
      query.$or = [
        { name: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } }
      ];
    }
    
    if (category) {
      query.category = category;
    }
    
    if (level) {
      query.level = level;
    }

    const courses = await Course.find(query)
      .select('name description category level image averageRating totalRatings groups duration cost originalCost currency discount instructor isOrphaned originalInstructor')
      .populate('instructor', 'name avatar')
      .populate('originalInstructor', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Course.countDocuments(query);

    res.json({
      success: true,
      count: courses.length,
      total,
      courses
    });
  } catch (error) {
    console.error('Search courses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single course
// @route   GET /api/courses/:id
// @access  Public
exports.getCourse = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate courseId
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        message: 'Invalid course ID'
      });
    }

    const course = await Course.findById(id)
      .populate('instructor', 'name avatar email')
      .populate('originalInstructor', 'name')
      // For instructor editing, we need basic group info plus the enrolled students
      // so that the frontend can compute accurate student counts like the manage-groups page.
      .populate({
        path: 'groups',
        select: 'name currentStudents maxStudents startDate endDate schedule isActive students',
        populate: {
          path: 'students.student',
          select: 'name email avatar'
        }
      });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.isArchived) {
      const role = req.user?.role;

      if (role === 'admin' || role === 'instructor') {
        // allowed
      } else if (role === 'student') {
        const student = await User.findById(req.user.id).select('enrolledCourses');
        const isEnrolled = !!student?.enrolledCourses?.some(
          (enrollment) => enrollment.course?.toString() === course._id.toString()
        );

        if (!isEnrolled) {
          return res.status(404).json({
            success: false,
            message: 'Course not found'
          });
        }
      } else {
        return res.status(404).json({
          success: false,
          message: 'Course not found'
        });
      }
    }

    // For non-admin/non-instructor users, hide archived groups unless the student is enrolled
    const userRole = req.user?.role;
    if (!userRole || (userRole !== 'admin' && userRole !== 'instructor')) {
      course.groups = course.groups.filter(group => {
        if (!group.isArchived) return true;
        const students = group.students || [];
        return students.some(s => String(s.student?._id || s.student) === String(req.user?.id));
      });
    }

    res.json({
      success: true,
      course
    });
  } catch (error) {
    console.error('Get course error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Invalid course ID'
    });
  }
};

// @desc    Get detailed course summary with grades and payments for a student
// @route   GET /api/courses/:id/summary
// @access  Private (Student)
exports.getCourseSummary = async (req, res) => {
  try {
    const courseId = req.params.id;

    const course = await Course.findById(courseId).select('name level currency instructor cost');
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    const sections = await loadCourseSections(courseId);
    const sectionIds = sections.map((section) => section._id);

    const [enrollment, gradesMap, paymentsMap] = await Promise.all([
      getStudentEnrollment(req.user.id, courseId),
      getSectionGradesForStudent(req.user.id, sectionIds),
      getLatestPaymentsForStudent(req.user.id, sectionIds)
    ]);

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in this course'
      });
    }

    const sectionSummaries = sections.map((section) => {
      const sectionIdStr = section._id.toString();
      const gradePercent = gradesMap.get(sectionIdStr) ?? null;
      const paymentDoc = paymentsMap.get(sectionIdStr) || null;
      const access = determineSectionAccess(section, enrollment, paymentDoc);

      return {
        id: section._id,
        name: section.name,
        order: section.order,
        isFree: section.isFree,
        isPaid: section.isPaid,
        priceCents: section.priceCents,
        currency: section.currency,
        gradePercent,
        access,
        latestPayment: access.latestPayment
      };
    });

    const overallGrade = calculateOverallGrade(
      sectionSummaries.map((section) => section.gradePercent)
    );

    res.json({
      success: true,
      course: {
        id: course._id,
        name: course.name,
        level: course.level,
        currency: course.currency,
        cost: course.cost,
        instructor: course.instructor
      },
      enrollment: {
        id: enrollment._id,
        group: enrollment.group,
        enrolledSections: enrollment.enrolledSections
      },
      overallGrade,
      sections: sectionSummaries
    });
  } catch (error) {
    console.error('Get course summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to build course summary'
    });
  }
};

// @desc    Get course gradebook for instructors/admins
// @route   GET /api/courses/:id/grades
// @access  Private (Instructor/Admin)
exports.getCourseGradebook = async (req, res) => {
  try {
    const courseId = req.params.id;

    const course = await Course.findById(courseId).select('name instructor level');
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (
      req.user.role === 'instructor' &&
      course.instructor.toString() !== req.user.id
    ) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this gradebook' });
    }

    const sections = await loadCourseSections(courseId);
    const sectionIds = sections.map((section) => section._id);

    const enrollments = await Enrollment.find({ course: courseId })
      .populate('student', 'name email avatar')
      .populate('group', 'name');

    const studentIds = enrollments.map((enrollment) =>
      enrollment.student && enrollment.student._id
        ? enrollment.student._id
        : enrollment.student
    );

    const [gradesMap, paymentsMap] = await Promise.all([
      getSectionGradesForStudents(studentIds, sectionIds),
      getLatestPaymentsForStudents(studentIds, sectionIds)
    ]);

    const studentSummaries = enrollments.map((enrollment) => {
      const studentDoc = enrollment.student;
      const studentIdStr = (studentDoc && studentDoc._id
        ? studentDoc._id
        : studentDoc).toString();

      const sectionSummaries = sections.map((section) => {
        const sectionIdStr = section._id.toString();
        const key = `${studentIdStr}:${sectionIdStr}`;
        const gradePercent = gradesMap.get(key) ?? null;
        const paymentDoc = paymentsMap.get(key) || null;
        const access = determineSectionAccess(section, enrollment, paymentDoc);

        return {
          id: section._id,
          name: section.name,
          order: section.order,
          gradePercent,
          access,
          latestPayment: access.latestPayment
        };
      });

      const overallGrade = calculateOverallGrade(
        sectionSummaries.map((section) => section.gradePercent)
      );

      return {
        student: {
          id: studentDoc._id || studentDoc,
          name: studentDoc.name || undefined,
          email: studentDoc.email || undefined,
          avatar: studentDoc.avatar || undefined
        },
        enrollment: {
          id: enrollment._id,
          group: enrollment.group,
          enrolledSections: enrollment.enrolledSections
        },
        overallGrade,
        sections: sectionSummaries
      };
    });

    res.json({
      success: true,
      course: {
        id: course._id,
        name: course.name,
        level: course.level,
        sectionCount: sections.length
      },
      sections: sections.map((section) => ({
        id: section._id,
        name: section.name,
        order: section.order,
        isPaid: section.isPaid,
        priceCents: section.priceCents,
        currency: section.currency
      })),
      students: studentSummaries
    });
  } catch (error) {
    console.error('Get course gradebook error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch course gradebook'
    });
  }
};

// @desc    Create course
// @route   POST /api/courses
// @access  Private (Admin/Instructor)
exports.createCourse = async (req, res) => {
  console.log(req.body)
  try {
    const errors = validationResult(req);
    console.log(errors);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Check if instructor is trusted for auto-approval
    const instructorUser = req.user.role === 'instructor' 
      ? await User.findById(req.user.id).select('trustedInstructor')
      : null;
    const isTrusted = instructorUser?.trustedInstructor || false;
    
    if (isTrusted) {
      console.log(`✅ Trusted instructor ${req.user.name} creating course - Auto-approved`);
    }

    const { hasCertificate, ...courseData } = req.body;
    const course = await Course.create({
      ...courseData,
      instructor: req.user.role === 'instructor' ? req.user.id : req.body.instructor,
      offersCertificate: hasCertificate !== undefined ? hasCertificate : true,
      certificate: {
        isAvailable: hasCertificate || false
      },
      // Admins and trusted instructors are auto-approved, regular instructors need approval
      approvalStatus: (req.user.role === 'admin' || isTrusted) ? 'approved' : 'pending',
      approvedBy: (req.user.role === 'admin' || isTrusted) ? req.user.id : null,
      approvedAt: (req.user.role === 'admin' || isTrusted) ? new Date() : null,
      // Admins and trusted instructors can publish immediately
      isPublished: (req.user.role === 'admin' || isTrusted) ? true : false
    });

    // Send notifications based on user role
    try {
      if (req.user.role === 'instructor' && !isTrusted) {
        // Notify admin about pending course approval (only for non-trusted instructors)
        const admin = await User.findOne({ role: 'admin' });
        if (admin) {
          await sendEmail({
            email: admin.email,
            subject: 'New Course Pending Approval - EduFlow',
            html: `
              <h2>New Course Awaiting Approval</h2>
              <p>Dear Admin,</p>
              <p>An instructor has created a new course that requires your approval:</p>
              <p><strong>Course Name:</strong> ${course.name}</p>
              <p><strong>Instructor:</strong> ${req.user.name}</p>
              <p><strong>Category:</strong> ${course.category}</p>
              <p><strong>Level:</strong> ${course.level}</p>
              <p>Please review and approve this course in your admin dashboard.</p>
              <br>
              <p>Best regards,<br>EduFlow System</p>
            `
          });

          // Create in-app message for admin
          const createdAt = course.createdAt || new Date();
          await Message.create({
            sender: req.user.id,
            recipient: admin._id,
            subject: 'New Course Pending Approval',
            content: `A new course "${course.name}" by ${req.user.name} was created on ${createdAt.toLocaleString()} and requires approval before publishing.`,
            isSystemMessage: true
          });

          // Create admin notification so it appears in the notifications center
          try {
            const Notification = require('../models/Notification');
            await Notification.create({
              user: admin._id,
              type: 'course',
              title: 'New course requires approval',
              message: `Course "${course.name}" by ${req.user.name} requires approval before publishing.`,
              priority: 'high',
              link: `/admin/courses/pending`,
              metadata: {
                courseId: course._id,
                instructorId: req.user.id,
                createdAt
              }
            });
          } catch (notifError) {
            console.error('Failed to create course approval notification:', notifError);
          }
        }
      } else if (req.user.role === 'admin') {
        // Admin created course - notify all students
        const { sendNewCourseEmail } = require('../utils/emailNotifications');
        const students = await User.find({ role: 'student' }).select('email name');
        const instructor = await User.findById(course.instructor).select('name');
        
        students.forEach(student => {
          sendNewCourseEmail(student.email, student.name, course.name, instructor.name)
            .catch(err => console.error('Error sending new course email to student:', err));
        });
      }
    } catch (emailError) {
      console.error('Error sending course creation emails:', emailError);
    }

    res.status(201).json({
      success: true,
      course
    });
  } catch (error) {
  console.error('Create course error:', error);

  // Check if the error comes from express-validator
  if (error.array) {
    console.log('Validation errors from express-validator:', error.array());
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: error.array()
    });
  }

  // Check if the error comes from Mongoose validation
  if (error.name === 'ValidationError') {
    const mongooseErrors = Object.keys(error.errors).map(key => ({
      field: key,
      message: error.errors[key].message
    }));
    console.log('Validation errors from Mongoose:', mongooseErrors);
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: mongooseErrors
    });
  }

  // Fallback for other errors
  console.log('Unexpected error:', error.message || error);
  res.status(500).json({
    success: false,
    message: error.message || 'Server error',
    errors: []
  });
}
};

// @desc    Update course
// @route   PUT /api/courses/:id
// @access  Private (Admin/Instructor)
exports.updateCourse = async (req, res) => {
  try {
    let course = await Course.findById(req.params.id).populate('instructor', 'name email');

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if user is the instructor or admin
    if (req.user.role !== 'admin' && course.instructor._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this course'
      });
    }

    const oldCost = course.cost;
    const newCost = req.body.cost;
    const currency = req.body.currency || course.currency;

    // Check if cost is being changed
    if (newCost !== undefined && oldCost !== newCost) {
      console.log(`💰 Course cost changing from ${oldCost} to ${newCost}`);

      const Section = require('../models/Section');
      const Group = require('../models/Group');
      const CoursePriceChange = require('../models/CoursePriceChange');
      const PendingCourseCostChange = require('../models/PendingCourseCostChange');
      const { sendEmail } = require('../utils/sendEmail');
      const Notification = require('../models/Notification');

      // Get all sections for this course across all groups
      const groups = await Group.find({ course: course._id });
      const sections = await Section.find({ course: course._id });

      // Calculate total of all paid section prices
      const totalPaidSections = sections.reduce((sum, section) => {
        return sum + (section.price || 0);
      }, 0);

      let sectionsAdjusted = false;
      let adjustmentDetails = null;

      // Handle price decrease with section adjustment - REQUIRE CONFIRMATION
      if (newCost < oldCost && totalPaidSections > newCost) {
        console.log(`⚠️ Total paid sections (${totalPaidSections}) > new cost (${newCost}). Creating pending change for confirmation...`);

        const scaleFactor = newCost / totalPaidSections;
        const affectedSections = [];

        // Calculate what the adjustments would be (don't apply yet)
        for (const section of sections) {
          if (section.price && section.price > 0) {
            const oldPrice = section.price;
            const newPrice = Math.round(oldPrice * scaleFactor); // Round to whole number (no decimals for currencies like SYP)

            affectedSections.push({
              section: section._id,
              sectionName: section.name,
              oldPrice,
              newPrice
            });

            console.log(`📊 Proposed: Section "${section.name}": ${oldPrice} → ${newPrice}`);
          }
        }

        // Create pending change record
        const pendingChange = await PendingCourseCostChange.create({
          course: course._id,
          instructor: req.user.id,
          oldCost,
          newCost,
          currency,
          totalPaidSections,
          scaleFactor,
          affectedSections,
          reason: req.body.costChangeReason || 'Course cost updated',
          status: 'pending'
        });

        // Notify admin about pending change
        const adminUsers = await User.find({ role: 'admin' });
        for (const admin of adminUsers) {
          await Notification.create({
            user: admin._id,
            type: 'course_update',
            title: 'Course Cost Change Pending Confirmation',
            message: `Instructor "${course.instructor.name}" is attempting to reduce course "${course.name}" cost from ${oldCost} to ${newCost} ${currency}, but total paid sections (${totalPaidSections}) exceed new cost. Awaiting instructor confirmation.`,
            link: `/admin/courses/${course._id}`,
            priority: 'high',
            metadata: {
              pendingChangeId: pendingChange._id,
              requiresAction: true
            }
          });

          // Send email to admin
          try {
            await sendEmail({
              email: admin.email,
              subject: '[Admin Alert] Course Cost Change Requires Confirmation',
              html: `
                <h2>⚠️ Course Cost Change Pending</h2>
                <p><strong>Course:</strong> ${course.name}</p>
                <p><strong>Instructor:</strong> ${course.instructor.name}</p>
                <p><strong>Old Cost:</strong> ${oldCost} ${currency}</p>
                <p><strong>New Cost:</strong> ${newCost} ${currency}</p>
                <p><strong>Total Paid Sections:</strong> ${totalPaidSections} ${currency}</p>
                <p>The instructor needs to confirm how to proceed with section price adjustments.</p>
                <p><strong>Proposed Scale Factor:</strong> ${(scaleFactor * 100).toFixed(2)}%</p>
                <hr>
                <p>Login to the admin dashboard to monitor this change.</p>
              `
            });
          } catch (err) {
            console.error('Failed to email admin about pending change:', err);
          }
        }

        pendingChange.adminNotified = true;
        await pendingChange.save();

        // Revert the cost change - don't apply until confirmed
        console.log('⏸️ Cost change pending confirmation. Reverting to old cost.');
        return res.status(200).json({
          success: false,
          confirmationRequired: true,
          pendingChangeId: pendingChange._id,
          message: `The new course cost (${newCost} ${currency}) is lower than the total already paid (${totalPaidSections} ${currency}). Please confirm how to proceed.`,
          data: {
            oldCost,
            newCost,
            totalPaidSections,
            currency,
            scaleFactor: (scaleFactor * 100).toFixed(2) + '%',
            affectedSections
          }
        });
      }

      // Log price change
      const priceChangeLog = await CoursePriceChange.create({
        course: course._id,
        oldCost,
        newCost,
        currency,
        changedBy: req.user.id,
        changedByRole: req.user.role,
        reason: req.body.costChangeReason || 'Course cost updated',
        sectionsAdjusted,
        adjustmentDetails,
        notificationsSent: {
          email: false,
          inApp: false
        }
      });

      // Prepare notification message
      let notificationMessage = '';
      let emailSubject = '';
      let emailHtml = '';

      if (sectionsAdjusted) {
        notificationMessage = `Course cost reduced from ${oldCost} ${currency} to ${newCost} ${currency}. Section prices were automatically adjusted to maintain correct total.`;
        emailSubject = 'Course Price Reduced - Sections Adjusted';
        emailHtml = `
          <h2>Course Price Update</h2>
          <p>The cost of "${course.name}" has been reduced.</p>
          <p><strong>Old Cost:</strong> ${oldCost} ${currency}<br>
          <strong>New Cost:</strong> ${newCost} ${currency}</p>
          <p>⚠️ <strong>Section prices were automatically adjusted proportionally to maintain the correct total.</strong></p>
          <p>Scale Factor: ${(adjustmentDetails.scaleFactor * 100).toFixed(2)}%</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `;
      } else {
        notificationMessage = `Course cost ${newCost > oldCost ? 'increased' : 'decreased'} from ${oldCost} ${currency} to ${newCost} ${currency}. All section prices remain valid.`;
        emailSubject = 'Course Price Updated';
        emailHtml = `
          <h2>Course Price Update</h2>
          <p>The cost of "${course.name}" has been ${newCost > oldCost ? 'increased' : 'decreased'}.</p>
          <p><strong>Old Cost:</strong> ${oldCost} ${currency}<br>
          <strong>New Cost:</strong> ${newCost} ${currency}</p>
          <p>✅ All section prices remain valid.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `;
      }

      // Send notifications to instructor and admins
      const adminUsers = await User.find({ role: 'admin' });
      const notificationRecipients = [course.instructor._id, ...adminUsers.map(a => a._id)];

      // Send emails
      try {
        // Email to instructor
        if (course.instructor.email) {
          await sendEmail({
            email: course.instructor.email,
            subject: emailSubject,
            html: emailHtml
          });
        }

        // Email to admins
        for (const admin of adminUsers) {
          await sendEmail({
            email: admin.email,
            subject: `[Admin] ${emailSubject}`,
            html: emailHtml
          });
        }

        priceChangeLog.notificationsSent.email = true;
        await priceChangeLog.save();
      } catch (emailError) {
        console.error('Failed to send price change emails:', emailError);
      }

      // Create in-app notifications
      try {
        for (const userId of notificationRecipients) {
          await Notification.create({
            user: userId,
            type: 'course_update',
            title: 'Course Price Updated',
            message: notificationMessage,
            link: `/courses/${course._id}`,
            priority: sectionsAdjusted ? 'high' : 'medium'
          });
        }

        priceChangeLog.notificationsSent.inApp = true;
        await priceChangeLog.save();
      } catch (notifError) {
        console.error('Failed to create price change notifications:', notifError);
      }

      console.log(`Price change logged and notifications sent`);
    }

    // Update the course
    const { hasCertificate, ...updateData } = req.body;
    if (hasCertificate !== undefined) {
      updateData.offersCertificate = hasCertificate;
      // Also update the old field for backward compatibility
      updateData.certificate = {
        ...course.certificate,
        isAvailable: hasCertificate
      };
    }
    course = await Course.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true
    });

      res.json({
      success: true,
      course
    });
  } catch (error) {
    console.error('Update course error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};
// @desc    Archive or unarchive a course
// @route   PATCH /api/courses/:id/archive
// @access  Private (Admin/Instructor - own courses only)
exports.archiveCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { archive, reason } = req.body || {};

    const course = await Course.findById(id);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Instructors can only archive their own courses
    if (req.user.role === 'instructor' && course.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to modify this course'
      });
    }

    const shouldArchive = archive === undefined ? true : Boolean(archive);

    if (shouldArchive) {
      if (course.isArchived) {
        return res.json({
          success: true,
          course,
          message: 'Course is already archived'
        });
      }

      course.isArchived = true;
      course.archivedAt = new Date();
      course.archivedBy = req.user._id || req.user.id;
      if (reason) {
        course.archivedReason = reason;
      }
    } else {
      if (!course.isArchived) {
        return res.json({
          success: true,
          course,
          message: 'Course is already active'
        });
      }

      // Unarchive: keep original approval/publish state
      course.isArchived = false;
      course.archivedAt = null;
      // Keep archivedBy/archivedReason for audit
    }

    await course.save();

    try {
      cache.clear();
    } catch (e) {
      console.warn('Failed to clear courses cache after archive toggle:', e.message);
    }

    res.json({
      success: true,
      course,
      message: shouldArchive
        ? 'Course archived successfully. It will be hidden from the catalog and cannot accept new enrollments, but existing students keep access.'
        : 'Course unarchived successfully.'
    });
  } catch (error) {
    console.error('Archive course error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update course archive status',
      error: error.message
    });
  }
};
// @route   DELETE /api/courses/:id
// @access  Private (Admin only)
exports.deleteCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Only administrators can permanently delete courses
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can permanently delete courses. Instructors can archive courses instead.'
      });
    }

    // Safety rule: do not allow deletion if any students are or were enrolled

    const hasEnrollments = await Enrollment.exists({ course: course._id });
    if (hasEnrollments) {
      return res.status(400).json({
        success: false,
        message: 'This course has enrolled students and cannot be deleted. You can archive it instead.'
      });
    }

    console.log(`Deleting course ${course._id} and all related data...`);

    const Section = require('../models/Section');
    const Content = require('../models/Content');
    const ActiveTest = require('../models/ActiveTest');
    const Progress = require('../models/Progress');

    // Cascade delete all related entities
    const deletionStats = {
      groups: 0,
      sections: 0,
      contents: 0,
      activeTests: 0,
      enrollments: 0,
      progress: 0
    };

    // 1. Delete all groups
    const deletedGroups = await Group.deleteMany({ course: course._id });
    deletionStats.groups = deletedGroups.deletedCount;
    console.log(`✅ Deleted ${deletedGroups.deletedCount} groups`);

    // 2. Delete all sections (and get their IDs for lecture deletion)
    const sections = await Section.find({ course: course._id });
    const sectionIds = sections.map(s => s._id);
    const deletedSections = await Section.deleteMany({ course: course._id });
    deletionStats.sections = deletedSections.deletedCount;
    console.log(`✅ Deleted ${deletedSections.deletedCount} sections`);

    // 3. Delete all contents in those sections
    const deletedContents = await Content.deleteMany({ section: { $in: sectionIds } });
    deletionStats.contents = deletedContents.deletedCount;
    console.log(`✅ Deleted ${deletedContents.deletedCount} contents`);

    // 4. Delete all enrollments for this course
    const deletedEnrollments = await Enrollment.deleteMany({ course: course._id });
    deletionStats.enrollments = deletedEnrollments.deletedCount;
    console.log(`✅ Deleted ${deletedEnrollments.deletedCount} enrollments`);

    // 5. Delete all progress records for this course
    const deletedProgress = await Progress.deleteMany({ course: course._id });
    deletionStats.progress = deletedProgress.deletedCount;
    console.log(`✅ Deleted ${deletedProgress.deletedCount} progress records`);

    // 6. Delete all active tests for this course
    const deletedTests = await ActiveTest.deleteMany({ course: course._id });
    deletionStats.activeTests = deletedTests.deletedCount;
    console.log(`✅ Deleted ${deletedTests.deletedCount} active tests`);

    // 7. Remove course from users' enrolledCourses
    await User.updateMany(
      { 'enrolledCourses.course': course._id },
      { $pull: { enrolledCourses: { course: course._id } } }
    );
    console.log(`✅ Removed course from user enrollments`);

    // 8. Delete the course itself
    await course.deleteOne();
    console.log(`✅ Deleted course: ${course.name}`);

    res.json({
      success: true,
      message: 'Course and all related data deleted successfully',
      deletedData: deletionStats
    });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Enroll in course
// @route   POST /api/courses/:id/enroll
// @access  Private (Student)
exports.enrollInCourse = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { group } = req.body;
    const courseId = req.params.id;

    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }
    if (course.isArchived) {
      return res.status(400).json({
        success: false,
        message: 'This course is archived and no longer accepts new enrollments.'
      });
    }

    // Check if group exists and belongs to course
    const groupDoc = await Group.findOne({ _id: group, course: courseId });
    if (!groupDoc) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or does not belong to this course'
      });
    }

		if (groupDoc.isArchived) {
		  return res.status(400).json({
		    success: false,
		    message: 'This group is archived and no longer accepts new enrollments.'
		  });
		}

    // Check if group has space
    if (groupDoc.currentStudents >= groupDoc.maxStudents) {
      return res.status(400).json({
        success: false,
        message: 'Group is full'
      });
    }

    // Check if user is already enrolled
    const user = await User.findById(req.user.id);
    const existingEnrollment = user.enrolledCourses.find(
      enrollment => enrollment.course.toString() === courseId
    );

    if (existingEnrollment) {
      return res.status(400).json({
        success: false,
        message: 'You are already enrolled in this course'
      });
    }

    // Add enrollment
    user.enrolledCourses.push({
      course: courseId,
      group: group,
      status: 'pending'
    });

    // Add student to group
    groupDoc.students.push({
      student: req.user.id,
      status: 'pending'
    });

    await user.save();
    await groupDoc.save();

    res.status(201).json({
      success: true,
      message: 'Enrollment request submitted successfully. Waiting for approval.'
    });
  } catch (error) {
    console.error('Enroll in course error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Confirm course cost change with auto-adjust
// @route   POST /api/courses/cost-change/:pendingChangeId/confirm-auto
// @access  Private (Instructor)
exports.confirmCostChangeAuto = async (req, res) => {
  try {
    const PendingCourseCostChange = require('../models/PendingCourseCostChange');
    const Section = require('../models/Section');
    const CoursePriceChange = require('../models/CoursePriceChange');
    const Notification = require('../models/Notification');
    const { sendEmail } = require('../utils/sendEmail');

    const pendingChange = await PendingCourseCostChange.findById(req.params.pendingChangeId)
      .populate('course')
      .populate('instructor', 'name email');

    if (!pendingChange) {
      return res.status(404).json({
        success: false,
        message: 'Pending change not found'
      });
    }

    // Verify instructor owns this change
    if (pendingChange.instructor._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (pendingChange.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'This change has already been processed'
      });
    }

    // Apply the proportional adjustments
    for (const adjustment of pendingChange.affectedSections) {
      const section = await Section.findById(adjustment.section);
      if (section) {
        // Update priceCents (the actual stored field), not the virtual price field
        section.priceCents = Math.round(adjustment.newPrice * 100);
        section.isPaid = section.priceCents > 0;
        await section.save();
        console.log(`✅ Section "${section.name}": ${adjustment.oldPrice} → ${adjustment.newPrice} (${section.priceCents} cents)`);
      }
    }

    // Update course cost
    const course = await Course.findById(pendingChange.course._id);
    course.cost = pendingChange.newCost;
    await course.save();

    // Update pending change status
    pendingChange.status = 'approved_auto';
    pendingChange.confirmedAt = new Date();
    await pendingChange.save();

    // Log the change
    await CoursePriceChange.create({
      course: course._id,
      oldCost: pendingChange.oldCost,
      newCost: pendingChange.newCost,
      currency: pendingChange.currency,
      changedBy: req.user.id,
      changedByRole: 'instructor',
      reason: pendingChange.reason || 'Auto-adjusted after confirmation',
      sectionsAdjusted: true,
      adjustmentDetails: {
        scaleFactor: pendingChange.scaleFactor,
        affectedSections: pendingChange.affectedSections
      },
      notificationsSent: {
        email: false,
        inApp: false
      }
    });

    // Notify admins
    const adminUsers = await User.find({ role: 'admin' });
    for (const admin of adminUsers) {
      await Notification.create({
        user: admin._id,
        type: 'course_update',
        title: 'Course Cost Change Confirmed',
        message: `Instructor "${pendingChange.instructor.name}" confirmed auto-adjustment for course "${course.name}". Cost: ${pendingChange.oldCost} → ${pendingChange.newCost} ${pendingChange.currency}`,
        link: `/admin/courses/${course._id}`,
        priority: 'medium'
      });
    }

    res.json({
      success: true,
      message: 'Course cost updated and sections adjusted successfully',
      course
    });
  } catch (error) {
    console.error('Confirm cost change auto error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Cancel course cost change
// @route   POST /api/courses/cost-change/:pendingChangeId/cancel
// @access  Private (Instructor)
exports.cancelCostChange = async (req, res) => {
  try {
    const PendingCourseCostChange = require('../models/PendingCourseCostChange');

    const pendingChange = await PendingCourseCostChange.findById(req.params.pendingChangeId)
      .populate('course')
      .populate('instructor', 'name email');

    if (!pendingChange) {
      return res.status(404).json({
        success: false,
        message: 'Pending change not found'
      });
    }

    // Verify instructor owns this change
    if (pendingChange.instructor._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    if (pendingChange.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'This change has already been processed'
      });
    }

    // Update status
    pendingChange.status = 'cancelled';
    pendingChange.confirmedAt = new Date();
    await pendingChange.save();

    res.json({
      success: true,
      message: 'Course cost change cancelled'
    });
  } catch (error) {
    console.error('Cancel cost change error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get pending cost change
// @route   GET /api/courses/cost-change/:pendingChangeId
// @access  Private (Instructor)
exports.getPendingCostChange = async (req, res) => {
  try {
    const PendingCourseCostChange = require('../models/PendingCourseCostChange');

    const pendingChange = await PendingCourseCostChange.findById(req.params.pendingChangeId)
      .populate('course', 'name')
      .populate('instructor', 'name email')
      .populate('affectedSections.section', 'name');

    if (!pendingChange) {
      return res.status(404).json({
        success: false,
        message: 'Pending change not found'
      });
    }

    // Verify instructor owns this change or is admin
    if (pendingChange.instructor._id.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    res.json({
      success: true,
      data: pendingChange
    });
  } catch (error) {
    console.error('Get pending cost change error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get enrolled courses
// @route   GET /api/courses/enrolled
// @access  Private (Student)
exports.getEnrolledCourses = async (req, res) => {
  try {
    // Get enrollments from Enrollment collection (more reliable)
    const CourseGrade = require('../models/CourseGrade');
    
    const enrollments = await Enrollment.find({
      student: req.user.id,
      status: { $in: ['approved', 'enrolled', 'completed'] } // Include all active statuses
    })
      .populate('course', 'name image level category duration cost instructor offersCertificate certificateMode instructorCertificateRelease')
      .populate('group', 'name startDate endDate schedule')
      .sort({ createdAt: -1 });

    console.log(`[getEnrolledCourses] Found ${enrollments.length} enrollments for student ${req.user.id}`);

    // Get grades for each enrolled course
    const enrolledCoursesWithGrades = await Promise.all(
      enrollments.map(async (enrollment) => {
        if (!enrollment.course) {
          console.log('[getEnrolledCourses] Skipping enrollment - course was deleted');
          return null; // Skip if course was deleted
        }

        // Get course grade if exists
        const courseGrade = await CourseGrade.findOne({
          student: req.user.id,
          course: enrollment.course._id
        });

        const overallGrade = courseGrade ? courseGrade.overallGrade : 0;
        const hasGrade = courseGrade && courseGrade.overallGrade > 0;

        console.log(`[getEnrolledCourses] Course: ${enrollment.course.name}, Grade: ${overallGrade}, HasGrade: ${hasGrade}`);

        return {
          _id: enrollment._id,
          course: enrollment.course,
          group: enrollment.group,
          status: enrollment.status === 'approved' ? 'enrolled' : enrollment.status, // Normalize 'approved' to 'enrolled'
          enrolledAt: enrollment.createdAt,
          overallGrade,
          hasGrade
        };
      })
    );

    // Filter out null entries (deleted courses)
    const validEnrollments = enrolledCoursesWithGrades.filter(e => e !== null);

    console.log(`[getEnrolledCourses] Returning ${validEnrollments.length} valid enrollments`);

    res.json({
      success: true,
      enrolledCourses: validEnrollments
    });
  } catch (error) {
    console.error('Get enrolled courses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get course progress
// @route   GET /api/courses/:id/progress
// @access  Private (Student)
exports.getCourseProgress = async (req, res) => {
  try {
    const progress = await Progress.findOne({
      student: req.user.id,
      course: req.params.id,
      group: req.enrollment.group
    }).populate('course', 'name lectures assignments projects');

    if (!progress) {
      // Create initial progress record
      const newProgress = await Progress.create({
        student: req.user.id,
        course: req.params.id,
        group: req.enrollment.group,
        lectures: [],
        assignments: [],
        projects: []
      });

      return res.json({
        success: true,
        progress: newProgress
      });
    }

    res.json({
      success: true,
      progress
    });
  } catch (error) {
    console.error('Get course progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update course progress
// @route   PUT /api/courses/:id/progress
// @access  Private (Student)
exports.updateProgress = async (req, res) => {
  try {
    const { type, itemId, watched, completed, submitted } = req.body;

    let progress = await Progress.findOne({
      student: req.user.id,
      course: req.params.id,
      group: req.enrollment.group
    });

    if (!progress) {
      progress = await Progress.create({
        student: req.user.id,
        course: req.params.id,
        group: req.enrollment.group,
        lectures: [],
        assignments: [],
        projects: []
      });
    }

    if (type === 'lecture') {
      const lectureIndex = progress.lectures.findIndex(
        l => l.lecture.toString() === itemId
      );

      if (lectureIndex >= 0) {
        progress.lectures[lectureIndex].watched = watched;
        progress.lectures[lectureIndex].completed = completed;
        if (watched) {
          progress.lectures[lectureIndex].watchedAt = new Date();
        }
      } else {
        progress.lectures.push({
          lecture: itemId,
          watched,
          completed,
          watchedAt: watched ? new Date() : null
        });
      }
    } else if (type === 'assignment') {
      const assignmentIndex = progress.assignments.findIndex(
        a => a.assignment.toString() === itemId
      );

      if (assignmentIndex >= 0) {
        progress.assignments[assignmentIndex].submitted = submitted;
        if (submitted) {
          progress.assignments[assignmentIndex].submittedAt = new Date();
        }
      } else {
        progress.assignments.push({
          assignment: itemId,
          submitted,
          submittedAt: submitted ? new Date() : null
        });
      }
    } else if (type === 'project') {
      const projectIndex = progress.projects.findIndex(
        p => p.project.toString() === itemId
      );

      if (projectIndex >= 0) {
        progress.projects[projectIndex].submitted = submitted;
        if (submitted) {
          progress.projects[projectIndex].submittedAt = new Date();
        }
      } else {
        progress.projects.push({
          project: itemId,
          submitted,
          submittedAt: submitted ? new Date() : null
        });
      }
    }

    await progress.save();

    res.json({
      success: true,
      progress
    });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get pending courses (Admin)
// @route   GET /api/courses/pending
// @access  Private (Admin)
exports.getPendingCourses = async (req, res) => {
  try {
    const courses = await Course.find({ approvalStatus: 'pending' })
      .populate('instructor', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      courses
    });
  } catch (error) {
    console.error('Get pending courses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Approve course (Admin)
// @route   PUT /api/courses/:id/approve
// @access  Private (Admin)
exports.approveCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate('instructor', 'name email');
    
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.approvalStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Course is not pending approval'
      });
    }

    course.approvalStatus = 'approved';
    course.approvedBy = req.user.id;
    course.approvedAt = new Date();
    course.isPublished = true; // Publish the course when approved
    await course.save();

    // Notify instructor
    try {
      await sendEmail({
        email: course.instructor.email,
        subject: 'Course Approved - EduFlow',
        html: `
          <h2>Course Approved!</h2>
          <p>Dear ${course.instructor.name},</p>
          <p>Great news! Your course has been approved by the admin:</p>
          <p><strong>Course Name:</strong> ${course.name}</p>
          <p>Your course is now live and visible to students.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });

      await Message.create({
        sender: req.user.id,
        recipient: course.instructor._id,
        subject: 'Course Approved',
        content: `Your course "${course.name}" has been approved and is now live!`,
        isSystemMessage: true
      });
    } catch (emailError) {
      console.error('Failed to notify instructor:', emailError);
    }

    // Notify all students about new course
    try {
      const { sendNewCourseEmail } = require('../utils/emailNotifications');
      const students = await User.find({ role: 'student' }).select('email name');
      
      students.forEach(student => {
        sendNewCourseEmail(student.email, student.name, course.name, course.instructor.name)
          .catch(err => console.error('Error sending new course email to student:', err));
      });
    } catch (emailError) {
      console.error('Error notifying students:', emailError);
    }

    res.json({
      success: true,
      message: 'Course approved successfully',
      course
    });
  } catch (error) {
    console.error('Approve course error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reject course (Admin)
// @route   PUT /api/courses/:id/reject
// @access  Private (Admin)
exports.rejectCourse = async (req, res) => {
  try {
    const { reason } = req.body;
    const course = await Course.findById(req.params.id).populate('instructor', 'name email');
    
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.approvalStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Course is not pending approval'
      });
    }

    // Save course info for notification before deletion
    const courseName = course.name;
    const instructorEmail = course.instructor.email;
    const instructorName = course.instructor.name;
    const instructorId = course.instructor._id;

    // Notify instructor before deletion
    try {
      await sendEmail({
        email: instructorEmail,
        subject: 'Course Rejected - EduFlow',
        html: `
          <h2>Course Rejected</h2>
          <p>Dear ${instructorName},</p>
          <p>We have reviewed your course submission and unfortunately it has been rejected:</p>
          <p><strong>Course Name:</strong> ${courseName}</p>
          <p><strong>Status:</strong> Rejected and Deleted</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>You can create a new course submission after addressing the feedback.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });

      await Message.create({
        sender: req.user.id,
        recipient: instructorId,
        subject: 'Course Rejected and Deleted',
        content: `Your course "${courseName}" was rejected and deleted. ${reason ? `Reason: ${reason}` : 'Please contact admin for details.'}`,
        isSystemMessage: true
      });
    } catch (emailError) {
      console.error('Failed to notify instructor:', emailError);
    }

    // Delete the course and associated data
    await course.deleteOne();

    res.json({
      success: true,
      message: 'Course rejected and deleted successfully'
    });
  } catch (error) {
    console.error('Reject course error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Request course discount
// @route   POST /api/courses/:id/discount/request
// @access  Private (Instructor)
exports.requestDiscount = async (req, res) => {
  try {
    const { discountPrice, timerDays } = req.body;
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if user is the instructor or admin
    if (req.user.role !== 'admin' && course.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    // Validate discount price
    if (!discountPrice || discountPrice >= course.cost) {
      return res.status(400).json({
        success: false,
        message: 'Discount price must be less than current course price'
      });
    }

    // Check if there's already an active discount
    if (course.discount.status === 'pending' || course.discount.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'This course already has an active discount request or discount'
      });
    }

    // Calculate percentage
    const percentage = Math.round(((course.cost - discountPrice) / course.cost) * 100);

    // Update discount fields
    course.discount = {
      price: discountPrice,
      percentage,
      timerDays: timerDays || 7,
      status: 'pending',
      requestedAt: new Date(),
      startDate: null,
      endDate: null,
      reasonReject: null,
      approvedBy: null,
      approvedAt: null
    };

    await course.save();

    // Notify admins via notification and email
    const Notification = require('../models/Notification');
    const { sendEmail } = require('../utils/sendEmail');
    const adminUsers = await User.find({ role: 'admin' });
    
    for (const admin of adminUsers) {
      // Create notification
      await Notification.create({
        user: admin._id,
        type: 'discount_request',
        title: 'New Discount Request',
        message: `Instructor requested ${percentage}% discount for course "${course.name}"`,
        link: `/admin/courses/${course._id}/discount`,
        priority: 'high'
      });

      // Send email
      try {
        if (admin.email) {
          await sendEmail({
            email: admin.email,
            subject: '🎯 New Discount Request - Action Required',
            html: `
              <h2>New Course Discount Request</h2>
              <p>Dear ${admin.name || 'Admin'},</p>
              <p>An instructor has requested a discount approval for a course:</p>
              <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
                <p><strong>Course:</strong> ${course.name}</p>
                <p><strong>Current Price:</strong> ${course.cost} ${course.currency}</p>
                <p><strong>Requested Discount Price:</strong> ${discountPrice} ${course.currency}</p>
                <p><strong>Discount Percentage:</strong> ${percentage}%</p>
                <p><strong>Duration:</strong> ${timerDays || 7} days</p>
              </div>
              <p>Please review and approve or reject this request in the admin dashboard.</p>
              <p><a href="${process.env.CLIENT_URL}/admin/courses" style="background: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">Review in Dashboard</a></p>
              <p>Best regards,<br>EduFlow System</p>
            `
          });
        } else {
          console.log('[Email] ⚠️ Admin has no email address, skipping email notification');
        }
      } catch (emailError) {
        console.error('[Email] ❌ Failed to send to admin:', emailError.message);
      }
    }

    res.json({
      success: true,
      message: 'Discount request submitted successfully',
      discount: course.discount
    });
  } catch (error) {
    console.error('Request discount error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Approve course discount (Admin)
// @route   PUT /api/courses/:id/discount/approve
// @access  Private (Admin)
exports.approveDiscount = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate('instructor', 'name email');

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.discount.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'No pending discount request'
      });
    }

    const Section = require('../models/Section');
    const sections = await Section.find({ course: course._id });
    
    // Calculate total of all paid section prices
    const totalPaidSections = sections.reduce((sum, section) => {
      return sum + (section.price || 0);
    }, 0);

    const oldCost = course.cost;
    const newCost = course.discount.price;
    const currency = course.currency;

    // Adjust section prices if needed (when discount price is less than total section prices)
    let sectionsAdjusted = false;
    if (totalPaidSections > newCost) {
      const scaleFactor = newCost / totalPaidSections;
      
      console.log(`🎯 Discount approved - adjusting section prices`);
      console.log(`Old Cost: ${oldCost}, Discount Price: ${newCost}, Total Sections: ${totalPaidSections}`);
      console.log(`Scale Factor: ${(scaleFactor * 100).toFixed(2)}%`);

      // Apply adjustments to sections
      for (const section of sections) {
        if (section.price && section.price > 0) {
          const oldPrice = section.price;
          const newPrice = Math.round(oldPrice * scaleFactor);
          
          section.priceCents = Math.round(newPrice * 100);
          section.isPaid = section.priceCents > 0;
          await section.save();
          
          console.log(`✅ Section "${section.name}": ${oldPrice} → ${newPrice}`);
        }
      }
      
      sectionsAdjusted = true;
    }

    // Set discount dates
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + course.discount.timerDays);

    // Save original cost before applying discount
    if (!course.originalCost) {
      course.originalCost = course.cost;
    }

    // Apply discount price as new cost
    course.cost = course.discount.price;
    course.discount.status = 'approved';
    course.discount.startDate = startDate;
    course.discount.endDate = endDate;
    course.discount.approvedBy = req.user.id;
    course.discount.approvedAt = new Date();

    await course.save();

    // Send notification and email to instructor
    const { sendNewDiscountEmail } = require('../utils/emailNotifications');
    const Notification = require('../models/Notification');
    
    try {
      await sendNewDiscountEmail(
        course.instructor.email,
        course.instructor.name,
        course.name,
        course.discount.percentage,
        course.discount.timerDays
      );

      let messageContent = `Your ${course.discount.percentage}% discount for "${course.name}" is now live for ${course.discount.timerDays} days!`;
      if (sectionsAdjusted) {
        messageContent += ` Section prices were automatically adjusted to match the new discount price.`;
      }

      await Message.create({
        sender: req.user.id,
        recipient: course.instructor._id,
        subject: 'Discount Approved',
        content: messageContent,
        isSystemMessage: true
      });

      // Create notification
      await Notification.create({
        user: course.instructor._id,
        type: 'discount_approved',
        title: 'Discount Approved!',
        message: messageContent,
        link: `/instructor/courses/${course._id}/edit`,
        priority: 'high'
      });
    } catch (err) {
      console.error('Error notifying instructor:', err);
    }

    // Notify all students
    try {
      const enrollments = await Enrollment.find({ course: course._id })
        .populate('student', 'email name');
      
      const { sendDiscountAnnouncementEmail } = require('../utils/emailNotifications');
      
      for (const enrollment of enrollments) {
        if (enrollment.student && enrollment.student.email && enrollment.student.name) {
          sendDiscountAnnouncementEmail(
            enrollment.student.email,
            enrollment.student.name,
            course.name,
            course.discount.percentage,
            course.discount.timerDays
          ).catch(err => console.error('[Email] ❌ Failed to send to', enrollment.student.email, ':', err.message));
        }
      }
    } catch (err) {
      console.error('Error notifying students:', err);
    }

    res.json({
      success: true,
      message: 'Discount approved successfully',
      discount: course.discount
    });
  } catch (error) {
    console.error('Approve discount error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reject course discount (Admin)
// @route   PUT /api/courses/:id/discount/reject
// @access  Private (Admin)
exports.rejectDiscount = async (req, res) => {
  try {
    const { reason } = req.body;
    const course = await Course.findById(req.params.id).populate('instructor', 'name email');

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.discount.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'No pending discount request'
      });
    }

    // Restore original cost if discount was active
    if (course.originalCost && course.discount.status === 'approved') {
      course.cost = course.originalCost;
      course.originalCost = null;
      console.log(`✅ Restored original cost: ${course.cost} for rejected discount`);
    }

    course.discount.status = 'rejected';
    course.discount.reasonReject = reason || 'No reason provided';
    course.discount.price = 0;
    course.discount.percentage = 0;

    await course.save();

    // Notify instructor
    try {
      await sendEmail({
        email: course.instructor.email,
        subject: 'Discount Request Rejected',
        html: `
          <h2>Discount Request Rejected</h2>
          <p>Dear ${course.instructor.name},</p>
          <p>Your discount request for "${course.name}" has been rejected.</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>You can submit a new discount request after addressing the feedback.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });

      await Message.create({
        sender: req.user.id,
        recipient: course.instructor._id,
        subject: 'Discount Request Rejected',
        content: `Your discount request for "${course.name}" was rejected. ${reason ? `Reason: ${reason}` : ''}`,
        isSystemMessage: true
      });
    } catch (err) {
      console.error('Error notifying instructor:', err);
    }

    res.json({
      success: true,
      message: 'Discount rejected successfully'
    });
  } catch (error) {
    console.error('Reject discount error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Disable course discount (Instructor)
// @route   PUT /api/courses/:id/discount/disable
// @access  Private (Instructor)
exports.disableDiscount = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check authorization
    if (req.user.role !== 'admin' && course.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    // Restore original cost if discount was active
    if (course.originalCost && course.discount.status === 'approved') {
      course.cost = course.originalCost;
      course.originalCost = null;
      console.log(`✅ Restored original cost: ${course.cost} for disabled discount`);
    }

    course.discount.status = 'disabled';
    course.discount.price = 0;
    course.discount.percentage = 0;

    await course.save();

    res.json({
      success: true,
      message: 'Discount disabled successfully'
    });
  } catch (error) {
    console.error('Disable discount error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get pending discount requests (Admin)
// @route   GET /api/courses/discounts/pending
// @access  Private (Admin)
exports.getPendingDiscounts = async (req, res) => {
  try {
    const courses = await Course.find({ 'discount.status': 'pending' })
      .populate('instructor', 'name email')
      .select('name cost discount currency originalCost')
      .sort({ 'discount.requestedAt': -1 });

    res.json({
      success: true,
      count: courses.length,
      discounts: courses
    });
  } catch (error) {
    console.error('Get pending discounts error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending discounts'
    });
  }
};

// @desc    Get all discounts (Admin)
// @route   GET /api/courses/discounts/all
// @access  Private (Admin)
exports.getAllDiscounts = async (req, res) => {
  try {
    const courses = await Course.find({ 
      'discount.status': { $in: ['pending', 'approved', 'rejected', 'expired'] }
    })
      .populate('instructor', 'name email')
      .select('name cost discount currency originalCost')
      .sort({ 'discount.requestedAt': -1 });

    res.json({
      success: true,
      count: courses.length,
      discounts: courses
    });
  } catch (error) {
    console.error('Get all discounts error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch discounts'
    });
  }
};

// @desc    Delete discount and revert cost (Admin)
// @route   DELETE /api/courses/:id/discount
// @access  Private (Admin)
exports.deleteDiscount = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Restore original cost if discount was active
    if (course.originalCost && course.discount.status === 'approved') {
      course.cost = course.originalCost;
      course.originalCost = null;
    }

    // Reset discount
    course.discount = {
      price: 0,
      percentage: 0,
      timerDays: 7,
      startDate: null,
      endDate: null,
      status: 'disabled',
      reasonReject: null,
      requestedAt: null,
      approvedBy: null,
      approvedAt: null
    };

    await course.save();

    res.json({
      success: true,
      message: 'Discount deleted and cost reverted',
      course
    });
  } catch (error) {
    console.error('Delete discount error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete discount'
    });
  }
};
