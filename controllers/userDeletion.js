const User = require('../models/User');
const crypto = require('crypto');
const Course = require('../models/Course');
const Section = require('../models/Section');
const Content = require('../models/Content');
const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');
const CertificateRequest = require('../models/CertificateRequest');
const Rating = require('../models/Rating');
const Comment = require('../models/Comment');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const YouTubeVideo = require('../models/YouTubeVideo');
const Submission = require('../models/Submission');
const Group = require('../models/Group');
const SectionPayment = require('../models/SectionPayment');
const StudentProgress = require('../models/StudentProgress');
const StudentContentGrade = require('../models/StudentContentGrade');
const StudentSectionGrade = require('../models/StudentSectionGrade');
const CourseGrade = require('../models/CourseGrade');
const TestAttempt = require('../models/TestAttempt');
const StudentPayment = require('../models/StudentPayment');
const AdminEarning = require('../models/AdminEarning');
const InstructorEarning = require('../models/InstructorEarning');
const Achievement = require('../models/Achievement');
const Notification = require('../models/Notification');
const Message = require('../models/Message');
const { deleteAgreementPDF } = require('../utils/pdfGenerator');
const { getYouTubeService, setCredentials } = require('../config/youtube');
const YouTubeToken = require('../models/YouTubeToken');
const fs = require('fs').promises;
const path = require('path');

/**
 * Delete a student account while preserving audit/history data.
 * POLICY: Keep certificates, enrollments, progress, submissions, ratings, and payment history.
 * Only delete the user account and user-authored comments; avatar file is removed from disk.
 */
exports.deleteStudent = async (req, res) => {
  try {
    const { userId } = req.params;
    const student = await User.findById(userId);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    if (student.role !== 'student') {
      return res.status(400).json({
        success: false,
        message: 'User is not a student'
      });
    }

    console.log(`🗑️ Starting deletion process for student: ${student.name} (${student.email})`);

    const mode = (req.body && req.body.mode) || 'anonymize';
    const hardDelete =
      mode === 'hard_delete' ||
      mode === 'delete_all' ||
      mode === 'deleteEverything';

    if (hardDelete) {
      const userId = student._id;

      await Enrollment.deleteMany({ student: userId });
      await Progress.deleteMany({ student: userId });
      await StudentProgress.deleteMany({ student: userId });
      await StudentContentGrade.deleteMany({ student: userId });
      await StudentSectionGrade.deleteMany({ student: userId });
      await CourseGrade.deleteMany({ student: userId });
      await Submission.deleteMany({ student: userId });
      await TestAttempt.deleteMany({ student: userId });
      await CertificateRequest.deleteMany({ student: userId });
      await SectionPayment.deleteMany({ student: userId });
      await StudentPayment.deleteMany({ student: userId });
      await AdminEarning.deleteMany({ student: userId });
      await InstructorEarning.deleteMany({ student: userId });
      await Rating.deleteMany({ student: userId });
      await Comment.deleteMany({ user: userId });
      await Message.deleteMany({ $or: [{ sender: userId }, { recipient: userId }] });
      await Achievement.deleteMany({ student: userId });
      await Notification.deleteMany({ user: userId });

      await Group.updateMany(
        { 'students.student': userId },
        { $pull: { students: { student: userId } } }
      );

      const avatarPath = student.avatar || student.profilePicture;
      if (avatarPath) {
        const isLocalFile = !String(avatarPath).includes('cloudinary');
        if (isLocalFile && String(avatarPath).includes('/uploads/')) {
          const filePath = path.join(
            __dirname,
            '..',
            String(avatarPath).replace('/uploads/', '/uploads/')
          );
          try {
            await fs.unlink(filePath);
            console.log(`✅ Deleted avatar: ${filePath}`);
          } catch (err) {
            console.warn(`⚠️ Could not delete avatar`, err.message);
          }
        }
      }

      await User.findByIdAndDelete(userId);
      console.log(`✅ Hard-deleted student user record`);

      try { require('../utils/cache').clear(); } catch (e) {}

      return res.json({
        success: true,
        mode: 'hard_delete',
        message: `Student ${student.name} and all related records deleted permanently.`
      });
    }

    // Ensure placeholder user exists. If DELETED_USER_EMAIL is provided, use global placeholder.
    // Otherwise, create a per-student placeholder to avoid unique index collisions.
    // NOTE: The User email regex only allows word characters in the local part and 2-3 letter TLDs,
    // so we must avoid '+' and long/unknown TLDs here.
    const safeId = String(userId || '').replace(/[^a-zA-Z0-9]/g, '');
    const placeholderEmail = process.env.DELETED_USER_EMAIL || `deleted_${safeId || 'student'}@eduflow.com`;
    let placeholder = await User.findActiveByEmail(placeholderEmail);
    if (!placeholder) {
      const created = await User.create([
        {
          name: 'Deleted User',
          email: placeholderEmail,
          password: crypto.randomBytes(24).toString('hex'),
          role: 'student',
          isEmailVerified: true
        }
      ]);
      placeholder = created[0];
    }

    // Count records before reassignment (for response summary)
    const kept = {
      enrollments: await Enrollment.countDocuments({ student: userId }),
      progress: await Progress.countDocuments({ student: userId }),
      studentProgress: await StudentProgress.countDocuments({ student: userId }),
      contentGrades: await StudentContentGrade.countDocuments({ student: userId }),
      sectionGrades: await StudentSectionGrade.countDocuments({ student: userId }),
      courseGrades: await CourseGrade.countDocuments({ student: userId }),
      submissions: await Submission.countDocuments({ student: userId }),
      testAttempts: await TestAttempt.countDocuments({ student: userId }),
      certificateRequests: await CertificateRequest.countDocuments({ student: userId }),
      sectionPayments: await SectionPayment.countDocuments({ student: userId }),
      studentPayments: await StudentPayment.countDocuments({ student: userId }),
      adminEarnings: await AdminEarning.countDocuments({ student: userId }),
      instructorEarnings: await InstructorEarning.countDocuments({ student: userId }),
      ratings: await Rating.countDocuments({ student: userId }),
      comments: await Comment.countDocuments({ user: userId }),
      messagesSent: await Message.countDocuments({ sender: userId }),
      messagesReceived: await Message.countDocuments({ recipient: userId }),
      groupMemberships: await Group.countDocuments({ 'students.student': userId }),
      achievements: await Achievement.countDocuments({ student: userId }),
      notifications: await Notification.countDocuments({ user: userId })
    };

    // Reassign all student-owned references to placeholder
    const pid = placeholder._id;
    await Enrollment.updateMany({ student: userId }, { $set: { student: pid } });
    await Progress.updateMany({ student: userId }, { $set: { student: pid } });
    await StudentProgress.updateMany({ student: userId }, { $set: { student: pid } });
    await StudentContentGrade.updateMany({ student: userId }, { $set: { student: pid } });
    await StudentSectionGrade.updateMany({ student: userId }, { $set: { student: pid } });
    await CourseGrade.updateMany({ student: userId }, { $set: { student: pid } });
    await Submission.updateMany({ student: userId }, { $set: { student: pid } });
    await TestAttempt.updateMany({ student: userId }, { $set: { student: pid } });
    await CertificateRequest.updateMany({ student: userId }, { $set: { student: pid } });
    await SectionPayment.updateMany({ student: userId }, { $set: { student: pid } });
    await StudentPayment.updateMany({ student: userId }, { $set: { student: pid } });
    await AdminEarning.updateMany({ student: userId }, { $set: { student: pid } });
    await InstructorEarning.updateMany({ student: userId }, { $set: { student: pid } });
    await Rating.updateMany({ student: userId }, { $set: { student: pid } });
    await Comment.updateMany({ user: userId }, { $set: { user: pid } });
    await Message.updateMany({ sender: userId }, { $set: { sender: pid } });
    await Message.updateMany({ recipient: userId }, { $set: { recipient: pid } });
    await Achievement.updateMany({ student: userId }, { $set: { student: pid } });
    await Notification.updateMany({ user: userId }, { $set: { user: pid } });
    await Group.updateMany(
      { 'students.student': userId },
      { $set: { 'students.$[elem].student': pid } },
      { arrayFilters: [{ 'elem.student': userId }] }
    );

    // Delete student's avatar file if local
    const avatarPath = student.avatar || student.profilePicture;
    if (avatarPath) {
      const isLocalFile = !String(avatarPath).includes('cloudinary');
      if (isLocalFile && String(avatarPath).includes('/uploads/')) {
        const filePath = path.join(__dirname, '..', String(avatarPath).replace('/uploads/', '/uploads/'));
        try {
          await fs.unlink(filePath);
          console.log(`✅ Deleted avatar: ${filePath}`);
        } catch (err) {
          console.warn(`⚠️ Could not delete avatar`, err.message);
        }
      }
    }

    // Finally, delete the student user record
    await User.findByIdAndDelete(userId);
    console.log(`✅ Deleted student user record`);

    // Clear caches after change
    try { require('../utils/cache').clear(); } catch (e) {}

    res.json({
      success: true,
      message: `Student ${student.name} deleted. All records reassigned to placeholder user for strong anonymization.`,
      reassigned: kept
    });

  } catch (error) {
    console.error('❌ Error deleting student:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete student',
      error: error.message
    });
  }
};

/**
 * Delete an instructor account while keeping courses and financial history.
 * POLICY: Keep courses/content/files/students/progress/payments/earnings/payout history.
 * Set course.instructor to null, mark as orphaned, preserve originalInstructor. Archive earnings agreements.
 */
exports.deleteInstructor = async (req, res) => {
  try {
    const { userId } = req.params;
    // SECURITY POLICY: Always keep courses. Ignore any deleteCourses request body to avoid accidental data loss.
    const instructor = await User.findById(userId);

    if (!instructor) {
      return res.status(404).json({
        success: false,
        message: 'Instructor not found'
      });
    }

    if (instructor.role !== 'instructor') {
      return res.status(400).json({
        success: false,
        message: 'User is not an instructor'
      });
    }

    console.log(`🗑️ Starting deletion process for instructor: ${instructor.name} (${instructor.email})`);

    const courses = await Course.find({ instructor: userId });
    console.log(`📚 Found ${courses.length} courses by this instructor`);

    // Always keep courses: set instructor to null, mark as orphaned, preserve originalInstructor
    await Course.updateMany(
      { instructor: userId },
      {
        instructor: null,
        isOrphaned: true,
        originalInstructor: userId
      }
    );
    console.log(`✅ Updated ${courses.length} courses to orphaned state (instructor set to null)`);

    // Archive earnings agreements instead of deleting (preserve financial history)
    const agreements = await InstructorEarningsAgreement.find({ instructor: userId });
    let archived = 0;
    for (const agreement of agreements) {
      if (agreement.isActive || agreement.status !== 'expired') {
        agreement.isActive = false;
        agreement.status = 'expired';
        await agreement.save();
        archived++;
      }
    }
    console.log(`📄 Archived ${archived} instructor earnings agreements`);

    // Delete YouTube token
    await YouTubeToken.deleteOne({ instructor: userId });

    // Delete InstructorApplication; archive InstructorAgreement for audit continuity
    const InstructorApplication = require('../models/InstructorApplication');
    await InstructorApplication.deleteOne({ userId: userId });
    const InstructorAgreement = require('../models/InstructorAgreement');
    await InstructorAgreement.updateMany(
      { instructor: userId, archived: { $ne: true } },
      { $set: { archived: true, archivedAt: new Date() } }
    );

    // Delete instructor's avatar file
    const instructorAvatar = instructor.avatar || instructor.profilePicture;
    if (instructorAvatar) {
      const isLocalFile = !String(instructorAvatar).includes('cloudinary');
      if (isLocalFile && String(instructorAvatar).includes('/uploads/')) {
        const filePath = path.join(__dirname, '..', String(instructorAvatar).replace('/uploads/', '/uploads/'));
        try {
          await fs.unlink(filePath);
          console.log(`✅ Deleted avatar`);
        } catch (err) {
          console.warn(`⚠️ Could not delete avatar`);
        }
      }
    }

    // Soft-delete instructor user account and anonymize sensitive fields
    const originalEmail = instructor.email;
    instructor.deletedEmail = originalEmail;
    const safeInstructorId = String(instructor._id || '').replace(/[^a-zA-Z0-9]/g, '');
    instructor.email = `deleted_${safeInstructorId}@deleteduser.com`;
    instructor.phone = undefined;
    instructor.country = undefined;
    instructor.city = undefined;
    instructor.school = undefined;
    instructor.bio = '';
    instructor.aboutMe = '';
    instructor.jobRole = '';
    instructor.avatar = '';
    instructor.profilePicture = undefined;
    instructor.socialLinks = {};
    instructor.paymentReceivers = [];
    instructor.instructorPayoutSettings = undefined;
    instructor.twoFactorEnabled = false;
    instructor.twoFactorSecret = undefined;
    instructor.twoFactorBackupCodes = [];
    instructor.trustedDevices = [];
    instructor.isDeleted = true;
    instructor.status = 'deleted';
    instructor.deletedAt = new Date();
    instructor.deletedBy = req.user && req.user.id ? req.user.id : undefined;
    if (req.body && typeof req.body.reason === 'string') {
      instructor.deletedReason = req.body.reason.slice(0, 500);
    }
    await instructor.save();
    console.log(`✅ Soft-deleted instructor user record (ID: ${instructor._id})`);

    // Clear caches after destructive change
    try { require('../utils/cache').clear(); } catch (e) {}

    res.json({
      success: true,
      message: `Instructor ${instructor.name} deleted. Courses retained and marked as orphaned with instructor removed. Financial history preserved.`,
      coursesUpdated: courses.length,
      agreementsArchived: archived
    });

  } catch (error) {
    console.error('❌ Error deleting instructor:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete instructor',
      error: error.message
    });
  }
};

/**
 * Get deletion preview - show what will be deleted
 * @route GET /api/users/:userId/deletion-preview
 * @access Private/Admin
 */
exports.getDeletionPreview = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const preview = {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    };

    if (user.role === 'student') {
      const enrollments = await Enrollment.countDocuments({ student: userId });
      const progress = await Progress.countDocuments({ student: userId });
      const certificateRequests = await CertificateRequest.countDocuments({ student: userId });
      const submissions = await Submission.countDocuments({ student: userId });
      const ratings = await Rating.countDocuments({ student: userId });
      const comments = await Comment.countDocuments({ user: userId });

      preview.willDelete = {
        enrollments,
        progress,
        certificateRequests,
        submissions,
        ratings,
        comments
      };

    } else if (user.role === 'instructor') {
      const courses = await Course.find({ instructor: userId });
      const courseIds = courses.map(c => c._id);
      
      const sections = await Section.countDocuments({ course: { $in: courseIds } });
      const enrollments = await Enrollment.countDocuments({ course: { $in: courseIds } });
      const ratings = await Rating.countDocuments({ course: { $in: courseIds } });
      const cloudinaryAssets = 0; // Cloudinary deprecated
      const youtubeVideos = await YouTubeVideo.countDocuments({ course: { $in: courseIds } });
      const agreements = await InstructorEarningsAgreement.countDocuments({ instructor: userId });

      preview.courses = courses.map(c => ({
        id: c._id,
        title: c.title,
        enrollments: 0 // Will be filled below
      }));

      // Get enrollments per course
      for (const course of preview.courses) {
        course.enrollments = await Enrollment.countDocuments({ course: course.id });
      }

      preview.willDelete = {
        courses: courses.length,
        sections,
        enrollments,
        ratings,
        cloudinaryAssets,
        youtubeVideos,
        agreements
      };
    }

    res.json({
      success: true,
      data: preview
    });

  } catch (error) {
    console.error('Error getting deletion preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get deletion preview',
      error: error.message
    });
  }
};
