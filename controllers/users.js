const { validationResult } = require('express-validator');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const EmailChangeRequest = require('../models/EmailChangeRequest');
const { sendInstructorApprovalEmail } = require('../utils/emailNotifications');
const { sendEmail } = require('../utils/sendEmail');
const { constructUploadPath } = require('../utils/urlHelper');
const fs = require('fs');
const path = require('path');
const { isPasswordStrong } = require('../utils/passwordStrength');
const { isDisposableEmail } = require('../utils/disposableEmail');

// @desc    Get all users
// @route   GET /api/users
// @access  Private (Admin)
exports.getUsers = async (req, res) => {
  try {
    const { role, page = 1, limit = 10 } = req.query;
    
    let query = {};
    if (role) {
      query.role = role;
    }

    const users = await User.find(query)
      .select('-password')
      .populate('enrolledCourses.course', 'name level')
      .populate('enrolledCourses.group', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      count: users.length,
      total,
      users
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get admin contact
// @route   GET /api/users/admin
// @access  Private (Student/Instructor)
exports.getAdmin = async (req, res) => {
  try {
    const admin = await User.findOne({ 
      role: 'admin',
      isDeleted: { $ne: true },
      status: { $ne: 'deleted' }
    })
      .select('name email _id');
    
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    res.json({
      success: true,
      admin
    });
  } catch (error) {
    console.error('Get admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get pending instructors
// @route   GET /api/users/instructors/pending
// @access  Private (Admin)
exports.getPendingInstructors = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const pending = await User.find({ role: 'instructor', instructorStatus: 'pending' })
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments({ role: 'instructor', instructorStatus: 'pending' });

    res.json({
      success: true,
      count: pending.length,
      total,
      instructors: pending
    });
  } catch (error) {
    console.error('Get pending instructors error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Approve instructor
// @route   PUT /api/users/instructors/:id/approve
// @access  Private (Admin)
exports.approveInstructor = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user || user.role !== 'instructor') {
      return res.status(404).json({ success: false, message: 'Instructor not found' });
    }
    user.instructorStatus = 'approved';
    await user.save();
    
    // Send approval email with optional reason/message
    try {
      await sendEmail({
        email: user.email,
        subject: 'Instructor Application Approved - EduFlow Academy',
        html: `
          <h2>Congratulations!</h2>
          <p>Dear ${user.name},</p>
          <p>We are pleased to inform you that your instructor application has been <strong>approved</strong>!</p>
          ${reason ? `<p><strong>Message from Admin:</strong> ${reason}</p>` : ''}
          <p>You can now start creating courses and sharing your knowledge with students.</p>
          <p>Welcome to the EduFlow Academy instructor community!</p>
          <br>
          <p>Best regards,<br>EduFlow Academy Team</p>
        `
      });
      console.log(`[Approve Instructor] Approval email sent to: ${user.email}`);
    } catch (emailError) {
      console.error('[Approve Instructor] Email sending failed:', emailError.message);
    }
    
    res.json({ success: true, message: 'Instructor approved', user: { id: user._id, instructorStatus: user.instructorStatus } });
  } catch (error) {
    console.error('Approve instructor error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Reject instructor
// @route   PUT /api/users/instructors/:id/reject
// @access  Private (Admin)
exports.rejectInstructor = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user || user.role !== 'instructor') {
      return res.status(404).json({ success: false, message: 'Instructor not found' });
    }
    
    const userName = user.name;
    const userEmail = user.email;
    
    // Delete the instructor account completely
    await User.findByIdAndDelete(req.params.id);
    
    // Send rejection email
    try {
      await sendEmail({
        email: userEmail,
        subject: 'Instructor Application Rejected - EduFlow Academy',
        html: `
          <h2>Instructor Application Update</h2>
          <p>Dear ${userName},</p>
          <p>We regret to inform you that your instructor application has been rejected.</p>
          ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
          <p>If you have any questions or would like to reapply in the future, please contact our support team.</p>
          <p>Thank you for your interest in EduFlow Academy.</p>
          <br>
          <p>Best regards,<br>EduFlow Academy Team</p>
        `
      });
      console.log(`[Reject Instructor] Rejection email sent to: ${userEmail}`);
    } catch (emailError) {
      console.error('[Reject Instructor] Email sending failed:', emailError.message);
    }
    
    res.json({ success: true, message: 'Instructor rejected and account deleted' });
  } catch (error) {
    console.error('Reject instructor error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Trust instructor (auto-approve courses)
// @route   PUT /api/users/instructors/:id/trust
// @access  Private (Admin)
exports.trustInstructor = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user || user.role !== 'instructor') {
      return res.status(404).json({ 
        success: false, 
        message: 'Instructor not found' 
      });
    }
    
    if (user.instructorStatus !== 'approved') {
      return res.status(400).json({ 
        success: false, 
        message: 'Instructor must be approved first' 
      });
    }
    
    user.isTrustedInstructor = true;
    user.trustedAt = new Date();
    user.trustedBy = req.user.id;
    await user.save();
    
    // Send notification email
    try {
      await sendEmail({
        email: user.email,
        subject: 'Trusted Instructor Status - EduFlow',
        html: `
          <h2>Congratulations!</h2>
          <p>Dear ${user.name},</p>
          <p>You have been granted <strong>Trusted Instructor</strong> status!</p>
          <p>This means your courses will be automatically approved and published without admin review.</p>
          <p>Continue delivering excellent content to our students!</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send trust notification:', emailError);
    }
    
    res.json({ 
      success: true, 
      message: 'Instructor trusted successfully',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        isTrustedInstructor: user.isTrustedInstructor
      }
    });
  } catch (error) {
    console.error('Trust instructor error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Untrust instructor (require approval again)
// @route   PUT /api/users/instructors/:id/untrust
// @access  Private (Admin)
exports.untrustInstructor = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user || user.role !== 'instructor') {
      return res.status(404).json({ 
        success: false, 
        message: 'Instructor not found' 
      });
    }
    
    user.isTrustedInstructor = false;
    user.trustedAt = null;
    user.trustedBy = null;
    await user.save();
    
    // Send notification email
    try {
      await sendEmail({
        email: user.email,
        subject: 'Instructor Status Update - EduFlow',
        html: `
          <h2>Instructor Status Update</h2>
          <p>Dear ${user.name},</p>
          <p>Your trusted instructor status has been removed.</p>
          <p>Your future courses will require admin approval before being published.</p>
          <p>If you have any questions, please contact the admin team.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send untrust notification:', emailError);
    }
    
    res.json({ 
      success: true, 
      message: 'Instructor untrusted successfully',
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        isTrustedInstructor: user.isTrustedInstructor
      }
    });
  } catch (error) {
    console.error('Untrust instructor error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

// @desc    Get students
// @route   GET /api/users/students
// @access  Private (Admin)
exports.getStudents = async (req, res) => {
  try {
    const { page = 1, limit = 1000 } = req.query; // Increased limit to show all students
    const CertificateRequest = require('../models/CertificateRequest');
    const Progress = require('../models/Progress');
    const Group = require('../models/Group');
    const StudentPayment = require('../models/StudentPayment');

    const students = await User.find({ role: 'student' })
      .select('-password')
      .populate('enrolledCourses.course', 'name level category')
      .populate('enrolledCourses.group', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Enhance each student with progress, certificate, and payment data
    const studentsWithDetails = await Promise.all(
      students.map(async (student) => {
        const studentObj = student.toObject();
        
        // Get certificates for this student
        const certificates = await CertificateRequest.find({ 
          student: student._id,
          status: 'issued'
        })
          .populate('course', 'name')
          .select('course certificateNumber issuedDate');
        
        // Get all payments for this student (new SectionPayment model)
        const SectionPayment = require('../models/SectionPayment');
        const payments = await SectionPayment.find({ student: student._id })
          .populate('course', 'name')
          .populate('section', 'name')
          .select('course section amountCents currency status paymentMethod submittedAt processedAt');
        
        // Get progress for each enrolled course
        if (studentObj.enrolledCourses && studentObj.enrolledCourses.length > 0) {
          studentObj.enrolledCourses = await Promise.all(
            studentObj.enrolledCourses.map(async (enrollment) => {
              if (enrollment.course && enrollment.course._id) {
                // Get actual grade from CourseGrade model
                const CourseGrade = require('../models/CourseGrade');
                const courseGrade = await CourseGrade.findOne({
                  student: student._id,
                  course: enrollment.course._id
                });
                
                // Get progress tracking from Progress model
                const progress = await Progress.findOne({
                  student: student._id,
                  course: enrollment.course._id
                });
                
                // Calculate accurate payment status using approved SectionPayments
                const Section = require('../models/Section');
                const sections = await Section.find({ course: enrollment.course._id });
                const totalSections = sections.length;
                const freeSectionIds = sections.filter(s => s.isFree).map(s => s._id.toString());

                const approvedPayments = await SectionPayment.find({
                  student: student._id,
                  course: enrollment.course._id,
                  status: 'approved'
                });

                const paidSectionIds = approvedPayments.map(p => p.section?.toString()).filter(Boolean);
                const allPaidSections = [...new Set([...freeSectionIds, ...paidSectionIds])];
                
                let calculatedPaymentStatus = 'pending';
                if (totalSections === 0 || allPaidSections.length >= totalSections) {
                  calculatedPaymentStatus = 'verified';
                } else if (allPaidSections.length > 0) {
                  calculatedPaymentStatus = 'partial';
                }
                
                // Also get payment info from Group for payment method
                let paymentMethod = 'none';
                let entryFeePaid = false;
                
                if (enrollment.group && enrollment.group._id) {
                  const group = await Group.findById(enrollment.group._id);
                  if (group) {
                    const studentEntry = group.students.find(
                      s => s.student.toString() === student._id.toString()
                    );
                    if (studentEntry) {
                      paymentMethod = studentEntry.paymentMethod || 'none';
                      entryFeePaid = studentEntry.entryFeePaid || false;
                    }
                  }
                }
                
                return {
                  ...enrollment,
                  overallGrade: courseGrade?.overallGrade || 0,
                  completedLectures: courseGrade?.lecturesCompleted || progress?.overallProgress?.lectures || 0,
                  completedAssignments: courseGrade?.assignmentsCompleted || 0,
                  completedProjects: courseGrade?.projectsCompleted || 0,
                  lecturesTotal: courseGrade?.lecturesTotal || 0,
                  assignmentsTotal: courseGrade?.assignmentsTotal || 0,
                  projectsTotal: courseGrade?.projectsTotal || 0,
                  sectionsCompleted: courseGrade?.sectionsCompleted || 0,
                  sectionsCount: courseGrade?.sectionsCount || 0,
                  paymentStatus: calculatedPaymentStatus,
                  paymentMethod: paymentMethod,
                  entryFeePaid: entryFeePaid,
                  paidSections: allPaidSections.length,
                  totalSections: totalSections
                };
              }
              return enrollment;
            })
          );
        }
        
        studentObj.certificates = certificates;
        studentObj.payments = payments;
        return studentObj;
      })
    );

    const total = await User.countDocuments({ role: 'student' });

    res.json({
      success: true,
      count: studentsWithDetails.length,
      total,
      students: studentsWithDetails
    });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get instructors
// @route   GET /api/users/instructors
// @access  Private (Admin)
exports.getInstructors = async (req, res) => {
  try {
    const { page = 1, limit = 10, includeDeleted } = req.query;

    // By default, exclude soft-deleted instructors from all generic lists.
    // Admin pages that need to see deleted instructors explicitly pass includeDeleted=true.
    const includeDeletedFlag = String(includeDeleted || 'false').toLowerCase() === 'true';

    const query = { role: 'instructor' };
    if (!includeDeletedFlag) {
      query.isDeleted = { $ne: true };
      query.status = { $ne: 'deleted' };
    }

    const instructors = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      count: instructors.length,
      total,
      instructors
    });
  } catch (error) {
    console.error('Get instructors error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (Admin)
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('enrolledCourses.course', 'name level category')
      .populate('enrolledCourses.group', 'name');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Create user
// @route   POST /api/users
// @access  Private (Admin)
exports.createUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { name, email, password, role, phone } = req.body;

    if (isDisposableEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Disposable or temporary email addresses are not allowed. Please use a real email address.'
      });
    }

    // Check if user exists (ignore soft-deleted users)
    const existingUser = await User.findActiveByEmail(email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    if (role === 'admin' || role === 'instructor') {
      if (!isPasswordStrong(password)) {
        return res.status(400).json({
          success: false,
          message: 'Password does not meet security requirements. It must be at least 12 characters and include uppercase, lowercase, number, and special character.'
        });
      }
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      phone,
      isEmailVerified: true // Admin created users are auto-verified
    });

    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Admin)
exports.updateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      user: updatedUser
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Admin)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userId = user._id;

    // Common models
    const Enrollment = require('../models/Enrollment');
    const Message = require('../models/Message');
    const CertificateRequest = require('../models/CertificateRequest');
    const Rating = require('../models/Rating');
    const Progress = require('../models/Progress');
    const Submission = require('../models/Submission');
    const PendingRegistration = require('../models/PendingRegistration');

    // Cleanup pending registration
    await PendingRegistration.deleteMany({ email: user.email });

    if (user.role === 'student') {
      const ratedCourseIds = await Rating.find({ student: userId }).distinct('course');
      await Enrollment.deleteMany({ student: userId });
      await CertificateRequest.deleteMany({ student: userId });
      await Rating.deleteMany({ student: userId });
      await Progress.deleteMany({ student: userId });
      await Submission.deleteMany({ student: userId });
      for (const cid of ratedCourseIds) {
        await Rating.getAverageRating(cid);
      }
    } else if (user.role === 'instructor') {
      // Delegate to centralized soft-delete logic that keeps courses and history.
      const userDeletionController = require('./userDeletion');
      req.params = req.params || {};
      req.params.userId = userId.toString();
      return userDeletionController.deleteInstructor(req, res);
    }

    // Messages
    await Message.deleteMany({ $or: [{ sender: userId }, { recipient: userId }] });

    await user.deleteOne();

    try { require('../utils/cache').clear(); } catch (e) {}

    res.json({
      success: true,
      message: 'User and related data deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get user enrollments
// @route   GET /api/users/:id/enrollments
// @access  Private (Admin)
exports.getUserEnrollments = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('enrolledCourses')
      .populate({
        path: 'enrolledCourses.course',
        select: 'name level category'
      })
      .populate({
        path: 'enrolledCourses.group',
        select: 'name instructor students',
        populate: {
          path: 'instructor',
          select: 'name email'
        }
      });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get detailed enrollment info including payment status
    const Group = require('../models/Group');
    const enrollmentsWithDetails = await Promise.all(
      user.enrolledCourses.map(async (enrollment) => {
        if (enrollment.group) {
          const group = await Group.findById(enrollment.group._id);
          const studentEntry = group?.students.find(
            s => s.student.toString() === user._id.toString()
          );
          return {
            ...enrollment.toObject(),
            status: studentEntry?.status || 'unknown',
            paymentStatus: studentEntry?.paymentStatus || 'unknown'
          };
        }
        return enrollment;
      })
    );

    res.json({
      success: true,
      enrollments: enrollmentsWithDetails
    });
  } catch (error) {
    console.error('Get user enrollments error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Send message to user
// @route   POST /api/users/:id/message
// @access  Private (Admin)
exports.sendMessageToUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { subject, content } = req.body;
    const recipientId = req.params.id;

    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Disallow sending messages to soft-deleted accounts
    if (recipient.isDeleted || recipient.status === 'deleted') {
      return res.status(400).json({
        success: false,
        message: 'Cannot send messages to a deleted account.'
      });
    }

    // Create message
    const message = await Message.create({
      sender: req.user.id,
      recipient: recipientId,
      subject,
      content
    });

    // Add notification to user
    recipient.notifications.push({
      message: `New message: ${subject}`,
      type: 'info',
      read: false
    });
    await recipient.save();

    // Send email notification in background (non-blocking)
    sendEmail({
      email: recipient.email,
      subject: `New Message: ${subject}`,
      message: content,
      html: `
        <h2>New Message from EduFlow Academy</h2>
        <h3>${subject}</h3>
        <p>${content}</p>
        <p>Best regards,<br>EduFlow Academy Team</p>
      `
    }).catch(error => {
      console.error('Email sending failed:', error);
    });

    res.status(201).json({
      success: true,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update current user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    let { 
      name, 
      email, 
      phone, 
      bio, 
      aboutMe, 
      jobRole, 
      expertise, 
      socialLinks 
    } = req.body;
    
    // Parse JSON strings if they exist (from FormData)
    if (typeof expertise === 'string') {
      try {
        expertise = JSON.parse(expertise);
      } catch (e) {
        expertise = undefined;
      }
    }
    if (typeof socialLinks === 'string') {
      try {
        socialLinks = JSON.parse(socialLinks);
      } catch (e) {
        socialLinks = undefined;
      }
    }

    // Validate social links: only allow https URLs, no javascript:/data: schemes
    if (socialLinks && typeof socialLinks === 'object') {
      const entries = [
        ['linkedin', 'LinkedIn'],
        ['github', 'GitHub'],
        ['twitter', 'Twitter'],
        ['website', 'Website']
      ];
      for (const [key, label] of entries) {
        const raw = socialLinks[key];
        if (!raw) {
          continue;
        }
        if (typeof raw !== 'string') {
          return res.status(400).json({
            success: false,
            message: `${label} URL is invalid.`
          });
        }
        const value = raw.trim();
        if (!value) {
          socialLinks[key] = '';
          continue;
        }
        let parsed;
        try {
          parsed = new URL(value);
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: `${label} URL is invalid.`
          });
        }
        if (parsed.protocol !== 'https:') {
          return res.status(400).json({
            success: false,
            message: `${label} URL must start with https://`
          });
        }
        socialLinks[key] = value;
      }
    }

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Handle avatar upload
    if (req.file) {
      // Delete old avatar if exists
      if (user.avatar && user.avatar.startsWith('/uploads/avatars/')) {
        const oldAvatarPath = path.join(__dirname, '..', user.avatar);
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      }
      // Set new avatar path
      user.avatar = constructUploadPath('avatars', req.file.filename);
    }

    // Username (name) and email are considered stable identifiers for certificates and agreements.
    // They cannot be changed via this self-service endpoint; only admins may change them via admin APIs.

    // Enforce one-time phone change with uniqueness
    if (phone !== undefined && phone !== user.phone) {
      const newPhone = String(phone).trim();

      if (newPhone) {
        const phoneRegex = /^09\d{8}$/;
        if (!phoneRegex.test(newPhone)) {
          return res.status(400).json({
            success: false,
            message: 'Phone number must be 10 digits starting with 09'
          });
        }

        if ((user.phoneChangeCount || 0) >= 1) {
          return res.status(400).json({
            success: false,
            message: 'You have already changed your phone number'
          });
        }

        const [existingUserWithPhone, existingPendingWithPhone] = await Promise.all([
          User.findOne({ phone: newPhone, _id: { $ne: user._id } }),
          PendingRegistration.findOne({ phone: newPhone })
        ]);

        if (existingUserWithPhone || existingPendingWithPhone) {
          return res.status(400).json({
            success: false,
            message: 'Phone number already exists'
          });
        }

        user.phone = newPhone;
        user.phoneChangeCount = (user.phoneChangeCount || 0) + 1;
      }
    }

    // Update remaining fields if provided
    if (bio !== undefined) user.bio = bio;
    if (aboutMe !== undefined) user.aboutMe = aboutMe;
    if (jobRole !== undefined) user.jobRole = jobRole;
    if (expertise !== undefined) user.expertise = expertise;
    if (socialLinks !== undefined) user.socialLinks = socialLinks;

    await user.save();

    // Return user without password
    const updatedUser = await User.findById(user._id).select('-password');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Request email change (one-time, sends verification code to new email)
// @route   POST /api/users/change-email/request
// @access  Private
exports.requestEmailChange = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty && typeof errors.isEmpty === 'function' && !errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { newEmail } = req.body || {};
    if (!newEmail || typeof newEmail !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'New email is required'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if ((user.emailChangeCount || 0) >= 1) {
      return res.status(400).json({
        success: false,
        message: 'You have already changed your email once'
      });
    }

    const normalizedEmail = newEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: 'New email is required'
      });
    }

    if (normalizedEmail === user.email) {
      return res.status(400).json({
        success: false,
        message: 'New email must be different from current email'
      });
    }

    if (isDisposableEmail && isDisposableEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Disposable or temporary email addresses are not allowed. Please use a real email address.'
      });
    }

    const [maybeExistingUser, existingPending] = await Promise.all([
      User.findActiveByEmail(normalizedEmail),
      PendingRegistration.findOne({ email: normalizedEmail })
    ]);

    const existingUser = maybeExistingUser && maybeExistingUser._id.toString() !== user._id.toString()
      ? maybeExistingUser
      : null;

    if (existingUser || existingPending) {
      return res.status(400).json({
        success: false,
        message: 'This email is already in use'
      });
    }

    const COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown between email change code sends
    const now = Date.now();

    const existingRequest = await EmailChangeRequest.findOne({ user: user._id, newEmail: normalizedEmail });
    if (existingRequest && existingRequest.lastSentAt) {
      const last = new Date(existingRequest.lastSentAt).getTime();
      const diff = now - last;
      if (diff < COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((COOLDOWN_MS - diff) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${remainingSeconds} seconds before requesting a new verification code.`,
          cooldownRemainingSeconds: remainingSeconds
        });
      }
    }

    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(now + 10 * 60 * 1000); // 10 minutes

    await EmailChangeRequest.findOneAndUpdate(
      { user: user._id },
      {
        newEmail: normalizedEmail,
        verificationCode,
        expiresAt,
        attemptCount: 0,
        lastSentAt: new Date(now)
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendEmail({
        email: normalizedEmail,
        subject: 'Email Change Verification Code',
        message: `Your verification code is: ${verificationCode}. It will expire in 10 minutes.`,
        html: `
          <h2>Verify Your New Email</h2>
          <p>You requested to change the email on your ${user.role} account.</p>
          <p>Use the following verification code to confirm this change:</p>
          <div style="background-color: #f3f4f6; padding: 16px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; margin: 16px 0;">
            ${verificationCode}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you did not request this change, you can ignore this email.</p>
        `
      });
    } catch (emailError) {
      console.error('Email change verification send error:', emailError);
      // Continue; the request exists even if email failed
    }

    return res.json({
      success: true,
      message: 'Verification code sent to new email address'
    });
  } catch (error) {
    console.error('Request email change error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to request email change',
      error: error.message
    });
  }
};

// @desc    Verify email change using verification code
// @route   POST /api/users/change-email/verify
// @access  Private
exports.verifyEmailChange = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty && typeof errors.isEmpty === 'function' && !errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { newEmail, verificationCode } = req.body || {};
    if (!newEmail || !verificationCode) {
      return res.status(400).json({
        success: false,
        message: 'New email and verification code are required'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const normalizedEmail = newEmail.trim().toLowerCase();

    const requestDoc = await EmailChangeRequest.findOne({
      user: user._id,
      newEmail: normalizedEmail
    });

    if (!requestDoc) {
      return res.status(400).json({
        success: false,
        message: 'No pending email change request found for this email'
      });
    }

    if (requestDoc.expiresAt <= new Date()) {
      await EmailChangeRequest.deleteOne({ _id: requestDoc._id });
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new code.'
      });
    }

    if (requestDoc.verificationCode !== verificationCode) {
      requestDoc.attemptCount = (requestDoc.attemptCount || 0) + 1;
      await requestDoc.save();

      if (requestDoc.attemptCount >= 5) {
        await EmailChangeRequest.deleteOne({ _id: requestDoc._id });
        return res.status(400).json({
          success: false,
          message: 'Too many invalid attempts. Please request a new code.'
        });
      }

      return res.status(400).json({
        success: false,
        message: 'Invalid verification code'
      });
    }

    if ((user.emailChangeCount || 0) >= 1) {
      await EmailChangeRequest.deleteOne({ _id: requestDoc._id });
      return res.status(400).json({
        success: false,
        message: 'You have already changed your email once'
      });
    }

    const [maybeExistingUserVerify, existingPending] = await Promise.all([
      User.findActiveByEmail(normalizedEmail),
      PendingRegistration.findOne({ email: normalizedEmail })
    ]);

    const existingUser = maybeExistingUserVerify && maybeExistingUserVerify._id.toString() !== user._id.toString()
      ? maybeExistingUserVerify
      : null;

    if (existingUser || existingPending) {
      return res.status(400).json({
        success: false,
        message: 'This email is already in use'
      });
    }

    user.email = normalizedEmail;
    user.isEmailVerified = true;
    user.emailChangeCount = (user.emailChangeCount || 0) + 1;
    await user.save();

    await EmailChangeRequest.deleteOne({ _id: requestDoc._id });

    const updatedUser = await User.findById(user._id).select('-password');

    return res.json({
      success: true,
      message: 'Email changed successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Verify email change error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify email change',
      error: error.message
    });
  }
};

// @desc    Delete current user account and all related data
// @route   DELETE /api/users/account
// @access  Private
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete all related data based on user role
    const Enrollment = require('../models/Enrollment');
    const Message = require('../models/Message');
    const CertificateRequest = require('../models/CertificateRequest');
    const Rating = require('../models/Rating');
    const Progress = require('../models/Progress');
    const Submission = require('../models/Submission');
    const PendingRegistration = require('../models/PendingRegistration');

    // Delete any pending registrations for this email
    await PendingRegistration.deleteMany({ email: user.email });

    if (user.role === 'student') {
      // Delete student-specific data
      const ratedCourseIds = await Rating.find({ student: userId }).distinct('course');
      const StudentProgress = require('../models/StudentProgress');
      const StudentContentGrade = require('../models/StudentContentGrade');
      const StudentSectionGrade = require('../models/StudentSectionGrade');
      const CourseGrade = require('../models/CourseGrade');
      const SectionPayment = require('../models/SectionPayment');
      const Comment = require('../models/Comment');

      await Enrollment.deleteMany({ student: userId });
      await CertificateRequest.deleteMany({ student: userId });
      await Rating.deleteMany({ student: userId });
      await Progress.deleteMany({ student: userId });
      await Submission.deleteMany({ student: userId });
      await StudentProgress.deleteMany({ student: userId });
      await StudentContentGrade.deleteMany({ student: userId });
      await StudentSectionGrade.deleteMany({ student: userId });
      await CourseGrade.deleteMany({ student: userId });
      await SectionPayment.deleteMany({ student: userId });
      await Comment.deleteMany({ user: userId });

      const Achievement = require('../models/Achievement');
      const Notification = require('../models/Notification');
      const StudentPayment = require('../models/StudentPayment');
      const AdminEarning = require('../models/AdminEarning');
      const InstructorEarning = require('../models/InstructorEarning');
      const Group = require('../models/Group');

      await Achievement.deleteMany({ student: userId });
      await Notification.deleteMany({ user: userId });
      await StudentPayment.deleteMany({ student: userId });
      await AdminEarning.deleteMany({ student: userId });
      await InstructorEarning.deleteMany({ student: userId });

      await Group.updateMany(
        { 'students.student': userId },
        { $pull: { students: { student: userId } } }
      );

      // Recalculate course ratings impacted by this student
      for (const cid of ratedCourseIds) {
        await Rating.getAverageRating(cid);
      }
    } else if (user.role === 'instructor') {
      // Instructors use the centralized soft-delete logic that preserves courses and history.
      // Delegate to userDeletion.deleteInstructor so behavior is identical to admin-initiated deletion.
      const userDeletionController = require('./userDeletion');
      req.params = req.params || {};
      req.params.userId = userId;
      return userDeletionController.deleteInstructor(req, res);
    }

    // For non-instructor roles, keep existing behavior: delete messages and the user record
    await Message.deleteMany({ $or: [{ sender: userId }, { recipient: userId }] });

    // Delete the user account
    await user.deleteOne();

    // Clear public course caches
    try { require('../utils/cache').clear(); } catch (e) {}

    res.json({
      success: true,
      message: 'Account and all related data deleted successfully'
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete account',
      error: error.message
    });
  }
};

// @desc    Trust/Untrust an instructor (Admin only)
// @route   PUT /api/users/instructor/:id/trust
// @access  Private (Admin)
exports.toggleInstructorTrust = async (req, res) => {
  try {
    const { id } = req.params;
    const { trusted } = req.body;

    const instructor = await User.findById(id);

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

    instructor.trustedInstructor = trusted;
    await instructor.save();

    console.log(`✅ Instructor ${instructor.name} trust status: ${trusted ? 'TRUSTED' : 'UNTRUSTED'}`);

    res.json({
      success: true,
      message: `Instructor ${trusted ? 'trusted' : 'untrusted'} successfully`,
      instructor: {
        id: instructor._id,
        name: instructor.name,
        email: instructor.email,
        trustedInstructor: instructor.trustedInstructor
      }
    });
  } catch (error) {
    console.error('Toggle instructor trust error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update instructor trust status',
      error: error.message
    });
  }
};

// @desc    Suspend a user (Admin only)
// @route   PUT /api/users/:id/suspend
// @access  Private (Admin)
exports.suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, restrictions } = req.body || {};

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Suspension reason must be at least 5 characters'
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot suspend an admin user'
      });
    }

    user.isSuspended = true;
    user.suspendedAt = new Date();
    user.suspendedBy = req.user.id;
    user.suspensionReason = reason;
    user.status = 'suspended';

    // Persist fine-grained suspension restrictions based on role
    if (user.role === 'student') {
      const r = restrictions || {};
      user.suspensionRestrictions = {
        enrollNewCourses: !!r.enrollNewCourses,
        continueCourses: !!r.continueCourses,
        accessCoursePages: !!r.accessCoursePages,
        requestCertificate: !!r.requestCertificate,
        changeProfile: !!r.changeProfile,
        changeSettings: !!r.changeSettings,
        dashboardAccess: !!r.dashboardAccess
      };
    } else if (user.role === 'instructor') {
      const r = restrictions || {};
      user.instructorSuspensionRestrictions = {
        createEditDeleteLectures: !!r.createEditDeleteLectures,
        createEditDeleteAssignments: !!r.createEditDeleteAssignments,
        manageActiveTests: !!r.manageActiveTests,
        manageGroupsSections: !!r.manageGroupsSections,
        createEditDeleteCourses: !!r.createEditDeleteCourses,
        createDisableDiscounts: !!r.createDisableDiscounts,
        removeStudents: !!r.removeStudents,
        gradeAssignments: !!r.gradeAssignments,
        issueCertificates: !!r.issueCertificates,
        requestPayout: !!r.requestPayout
      };
    }

    await user.save();

    // Log admin action
    const AdminLog = require('../models/AdminLog');
    await AdminLog.create({
      action: 'user_suspended',
      targetUser: user._id,
      targetUserRole: user.role,
      performedBy: req.user.id,
      details: `User suspended. Reason: ${reason}`,
      metadata: { reason: reason.trim() }
    });

    // Send suspension notification email
    const { sendEmail } = require('../utils/sendEmail');
    try {
      await sendEmail({
        email: user.email,
        subject: 'Account Temporarily Suspended - EduFlow',
        html: `
          <h2>Account Temporarily Suspended</h2>
          <p>Hi ${user.name},</p>
          <p>Your account has been temporarily suspended by the administrator.</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p>You can still view your dashboard but cannot take any actions until the suspension is lifted.</p>
          <p>Please contact support for more details at support@eduflow.com</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send suspension notification email:', emailError);
    }

    // Create in-app notification
    const Notification = require('../models/Notification');
    try {
      await Notification.create({
        user: user._id,
        type: 'system',
        title: 'Account Suspended',
        message: `Your account has been temporarily suspended. Reason: ${reason}. Contact support for details.`,
        priority: 'high'
      });
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }

    console.log(`✅ User ${user.name} (${user.role}) suspended by admin`);

    res.json({
      success: true,
      message: 'User suspended successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isSuspended: user.isSuspended,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Suspend user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to suspend user',
      error: error.message
    });
  }
};

// @desc    Unsuspend a user (Admin only)
// @route   PUT /api/users/:id/unsuspend
// @access  Private (Admin)
exports.unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.isSuspended = false;
    user.suspendedAt = null;
    user.suspendedBy = null;
    user.suspensionReason = null;
    user.status = 'active';
    user.suspensionRestrictions = undefined;
    user.instructorSuspensionRestrictions = undefined;
    await user.save();

    // Log admin action
    const AdminLog = require('../models/AdminLog');
    await AdminLog.create({
      action: 'user_unsuspended',
      targetUser: user._id,
      targetUserRole: user.role,
      performedBy: req.user.id,
      details: 'User unsuspended and restored'
    });

    // Send unsuspension notification email
    const { sendEmail } = require('../utils/sendEmail');
    try {
      await sendEmail({
        email: user.email,
        subject: 'Account Restored - EduFlow',
        html: `
          <h2>Account Suspension Lifted</h2>
          <p>Hi ${user.name},</p>
          <p>Good news! Your account suspension has been lifted.</p>
          <p>You can now access all platform features and perform all actions.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send unsuspension notification email:', emailError);
    }

    // Create in-app notification
    const Notification = require('../models/Notification');
    try {
      await Notification.create({
        user: user._id,
        type: 'system',
        title: 'Account Restored',
        message: 'Your account suspension has been lifted. You can now access all features.',
        priority: 'high'
      });
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }

    console.log(`✅ User ${user.name} (${user.role}) unsuspended by admin`);

    res.json({
      success: true,
      message: 'User unsuspended successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isSuspended: user.isSuspended,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Unsuspend user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unsuspend user',
      error: error.message
    });
  }
};

// @desc    Reset email/phone change limits for a user
// @route   PUT /api/users/:id/reset-change-limits
// @access  Private (Admin)
exports.resetChangeLimits = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    user.emailChangeCount = 0;
    user.phoneChangeCount = 0;
    await user.save();

    try {
      await EmailChangeRequest.deleteMany({ user: user._id });
    } catch (cleanupError) {
      console.error('Failed to clear email change requests during reset:', cleanupError);
    }

    return res.json({
      success: true,
      message: 'Email and phone change limits have been reset for this user.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        emailChangeCount: user.emailChangeCount,
        phoneChangeCount: user.phoneChangeCount
      }
    });
  } catch (error) {
    console.error('Reset change limits error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reset email/phone change limits',
      error: error.message
    });
  }
};

// @desc    Get pending registrations (students and instructors)
// @route   GET /api/users/pending-registrations
// @access  Private (Admin)
exports.getPendingRegistrations = async (req, res) => {
  try {
    const { role } = req.query;
    
    let query = {};
    if (role) {
      query.role = role;
    }

    const pendingRegistrations = await PendingRegistration.find(query)
      .select('-password -emailVerificationToken')
      .sort({ createdAt: -1 });

    const studentCount = await PendingRegistration.countDocuments({ role: 'student' });
    const instructorCount = await PendingRegistration.countDocuments({ role: 'instructor' });

    res.json({
      success: true,
      count: pendingRegistrations.length,
      studentCount,
      instructorCount,
      registrations: pendingRegistrations
    });
  } catch (error) {
    console.error('Get pending registrations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Delete pending registration
// @route   DELETE /api/users/pending-registrations/:id
// @access  Private (Admin)
exports.deletePendingRegistration = async (req, res) => {
  try {
    const { id } = req.params;
    
    const registration = await PendingRegistration.findById(id);
    
    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Pending registration not found'
      });
    }

    await registration.deleteOne();

    res.json({
      success: true,
      message: 'Pending registration deleted successfully'
    });
  } catch (error) {
    console.error('Delete pending registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete pending registration',
      error: error.message
    });
  }
};

// @desc    Ban user account
// @route   PUT /api/users/:id/ban
// @access  Private (Admin)
exports.banUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Ban reason is required'
      });
    }
    
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Cannot ban admin users'
      });
    }

    if (user.isBanned) {
      return res.status(400).json({
        success: false,
        message: 'User is already banned'
      });
    }

    user.isBanned = true;
    user.bannedAt = new Date();
    user.bannedBy = req.user.id;
    user.banReason = reason.trim();
    user.status = 'banned';
    await user.save();

    // Log admin action
    const AdminLog = require('../models/AdminLog');
    await AdminLog.create({
      action: 'user_banned',
      targetUser: user._id,
      targetUserRole: user.role,
      performedBy: req.user.id,
      details: `User banned. Reason: ${reason}`,
      metadata: { reason: reason.trim() }
    });

    // Send ban notification email
    const { sendEmail } = require('../utils/sendEmail');
    try {
      await sendEmail({
        email: user.email,
        subject: 'Account Banned - EduFlow',
        html: `
          <h2>Account Banned</h2>
          <p>Hi ${user.name},</p>
          <p>Your account has been permanently banned by EduFlow for violating our terms of service.</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p>You will no longer be able to log in to the platform.</p>
          <p>If you believe this is a mistake, please contact support at support@eduflow.com</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send ban notification email:', emailError);
    }

    // Create in-app notification
    const Notification = require('../models/Notification');
    try {
      await Notification.create({
        user: user._id,
        type: 'system',
        title: 'Account Banned',
        message: `Your account has been banned. Reason: ${reason}`,
        priority: 'high'
      });
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }

    res.json({
      success: true,
      message: 'User banned successfully'
    });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to ban user',
      error: error.message
    });
  }
};

// @desc    Unban user account
// @route   PUT /api/users/:id/unban
// @access  Private (Admin)
exports.unbanUser = async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.isBanned) {
      return res.status(400).json({
        success: false,
        message: 'User is not banned'
      });
    }

    user.isBanned = false;
    user.bannedAt = null;
    user.bannedBy = null;
    user.banReason = null;
    user.status = 'active';
    await user.save();

    // Log admin action
    const AdminLog = require('../models/AdminLog');
    await AdminLog.create({
      action: 'user_unbanned',
      targetUser: user._id,
      targetUserRole: user.role,
      performedBy: req.user.id,
      details: 'User unbanned and restored'
    });

    // Send unban notification email
    const { sendEmail } = require('../utils/sendEmail');
    try {
      await sendEmail({
        email: user.email,
        subject: 'Account Restored - EduFlow',
        html: `
          <h2>Account Restored</h2>
          <p>Hi ${user.name},</p>
          <p>Good news! Your account ban has been lifted.</p>
          <p>You can now log in and access all platform features.</p>
          <br>
          <p>Best regards,<br>EduFlow Team</p>
        `
      });
    } catch (emailError) {
      console.error('Failed to send unban notification email:', emailError);
    }

    // Create in-app notification
    const Notification = require('../models/Notification');
    try {
      await Notification.create({
        user: user._id,
        type: 'system',
        title: 'Account Restored',
        message: 'Your account ban has been lifted. You can now access all features.',
        priority: 'high'
      });
    } catch (notifError) {
      console.error('Failed to create notification:', notifError);
    }

    res.json({
      success: true,
      message: 'User unbanned successfully'
    });
  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to unban user',
      error: error.message
    });
    }
  };

  exports.suspendUser = async (req, res) => {
    try {
      const { id } = req.params;
      const { reason, restrictions } = req.body || {};

      if (!reason || reason.trim().length < 5) {
        return res.status(400).json({
          success: false,
          message: 'Suspension reason must be at least 5 characters'
        });
      }

      const user = await User.findById(id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.role === 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Cannot suspend an admin user'
        });
      }

      user.isSuspended = true;
      user.suspendedAt = new Date();
      user.suspendedBy = req.user.id;
      user.suspensionReason = reason;
      user.status = 'suspended';

      if (user.role === 'student') {
        const r = restrictions || {};
        user.suspensionRestrictions = {
          enrollNewCourses: !!r.enrollNewCourses,
          continueCourses: !!r.continueCourses,
          accessCoursePages: !!r.accessCoursePages,
          requestCertificate: !!r.requestCertificate,
          changeProfile: !!r.changeProfile,
          changeSettings: !!r.changeSettings
        };
      } else if (user.role === 'instructor') {
        const r = restrictions || {};
        user.instructorSuspensionRestrictions = {
          createEditDeleteLectures: !!r.createEditDeleteLectures,
          createEditDeleteAssignments: !!r.createEditDeleteAssignments,
          manageActiveTests: !!r.manageActiveTests,
          manageGroupsSections: !!r.manageGroupsSections,
          createEditDeleteCourses: !!r.createEditDeleteCourses,
          createDisableDiscounts: !!r.createDisableDiscounts,
          removeStudents: !!r.removeStudents,
          gradeAssignments: !!r.gradeAssignments,
          issueCertificates: !!r.issueCertificates,
          requestPayout: !!r.requestPayout
        };
      }

      await user.save();

      const AdminLog = require('../models/AdminLog');
      await AdminLog.create({
        action: 'user_suspended',
        targetUser: user._id,
        targetUserRole: user.role,
        performedBy: req.user.id,
        details: `User suspended. Reason: ${reason}`,
        metadata: { reason: reason.trim() }
      });

      try {
        await sendEmail({
          email: user.email,
          subject: 'Account Temporarily Suspended - EduFlow',
          html: `
            <h2>Account Temporarily Suspended</h2>
            <p>Hi ${user.name},</p>
            <p>Your account has been temporarily suspended by the administrator.</p>
            <p><strong>Reason:</strong> ${reason}</p>
            <p>You can still view your dashboard but cannot take any actions until the suspension is lifted.</p>
            <p>Please contact support for more details at support@eduflow.com</p>
            <br>
            <p>Best regards,<br>EduFlow Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send suspension notification email:', emailError);
      }

      try {
        const Notification = require('../models/Notification');
        await Notification.create({
          user: user._id,
          type: 'system',
          title: 'Account Suspended',
          message: `Your account has been temporarily suspended. Reason: ${reason}. Contact support for details.`,
          priority: 'high'
        });
      } catch (notifError) {
        console.error('Failed to create notification:', notifError);
      }

      console.log(` User ${user.name} (${user.role}) suspended by admin`);

      res.json({
        success: true,
        message: 'User suspended successfully',
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          isSuspended: user.isSuspended,
          status: user.status
        }
      });
    } catch (error) {
      console.error('Suspend user error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to suspend user',
        error: error.message
      });
    }
  };

  exports.unsuspendUser = async (req, res) => {
    try {
      const { id } = req.params;

      const user = await User.findById(id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      user.isSuspended = false;
      user.suspendedAt = null;
      user.suspendedBy = null;
      user.suspensionReason = null;
      user.status = 'active';
      user.suspensionRestrictions = undefined;
      user.instructorSuspensionRestrictions = undefined;
      await user.save();

      const AdminLog = require('../models/AdminLog');
      await AdminLog.create({
        action: 'user_unsuspended',
        targetUser: user._id,
        targetUserRole: user.role,
        performedBy: req.user.id,
        details: 'User unsuspended and restored'
      });

      try {
        await sendEmail({
          email: user.email,
          subject: 'Account Restored - EduFlow',
          html: `
            <h2>Account Suspension Lifted</h2>
            <p>Hi ${user.name},</p>
            <p>Good news! Your account suspension has been lifted.</p>
            <p>You can now access all platform features and perform all actions.</p>
            <br>
            <p>Best regards,<br>EduFlow Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send unsuspension notification email:', emailError);
      }

      try {
        const Notification = require('../models/Notification');
        await Notification.create({
          user: user._id,
          type: 'system',
          title: 'Account Restored',
          message: 'Your account suspension has been lifted. You can now access all features.',
          priority: 'high'
        });
      } catch (notifError) {
        console.error('Failed to create notification:', notifError);
      }

      console.log(` User ${user.name} (${user.role}) unsuspended by admin`);

      res.json({
        success: true,
        message: 'User unsuspended successfully',
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          isSuspended: user.isSuspended,
          status: user.status
        }
      });
    } catch (error) {
      console.error('Unsuspend user error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to unsuspend user',
        error: error.message
      });
    }
  };

  exports.getPendingRegistrations = async (req, res) => {
    try {
      const { role } = req.query;

      const query = role ? { role } : {};

      const pendingRegistrations = await PendingRegistration.find(query)
        .select('-password -emailVerificationToken')
        .sort({ createdAt: -1 });

      const studentCount = await PendingRegistration.countDocuments({ role: 'student' });
      const instructorCount = await PendingRegistration.countDocuments({ role: 'instructor' });

      res.json({
        success: true,
        count: pendingRegistrations.length,
        studentCount,
        instructorCount,
        registrations: pendingRegistrations
      });
    } catch (error) {
      console.error('Get pending registrations error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message
      });
    }
  };

  exports.deletePendingRegistration = async (req, res) => {
    try {
      const { id } = req.params;

      const registration = await PendingRegistration.findById(id);

      if (!registration) {
        return res.status(404).json({
          success: false,
          message: 'Pending registration not found'
        });
      }

      await registration.deleteOne();

      res.json({
        success: true,
        message: 'Pending registration deleted successfully'
      });
    } catch (error) {
      console.error('Delete pending registration error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete pending registration',
        error: error.message
      });
    }
  };

  exports.banUser = async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Ban reason is required'
        });
      }

      const user = await User.findById(id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.role === 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Cannot ban admin users'
        });
      }

      if (user.isBanned) {
        return res.status(400).json({
          success: false,
          message: 'User is already banned'
        });
      }

      user.isBanned = true;
      user.bannedAt = new Date();
      user.bannedBy = req.user.id;
      user.banReason = reason.trim();
      user.status = 'banned';
      await user.save();

      const AdminLog = require('../models/AdminLog');
      await AdminLog.create({
        action: 'user_banned',
        targetUser: user._id,
        targetUserRole: user.role,
        performedBy: req.user.id,
        details: `User banned. Reason: ${reason}`,
        metadata: { reason: reason.trim() }
      });

      try {
        await sendEmail({
          email: user.email,
          subject: 'Account Banned - EduFlow',
          html: `
            <h2>Account Banned</h2>
            <p>Hi ${user.name},</p>
            <p>Your account has been permanently banned by EduFlow for violating our terms of service.</p>
            <p><strong>Reason:</strong> ${reason}</p>
            <p>You will no longer be able to log in to the platform.</p>
            <p>If you believe this is a mistake, please contact support at support@eduflow.com</p>
            <br>
            <p>Best regards,<br>EduFlow Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send ban notification email:', emailError);
      }

      try {
        const Notification = require('../models/Notification');
        await Notification.create({
          user: user._id,
          type: 'system',
          title: 'Account Banned',
          message: `Your account has been banned. Reason: ${reason}`,
          priority: 'high'
        });
      } catch (notifError) {
        console.error('Failed to create notification:', notifError);
      }

      res.json({
        success: true,
        message: 'User banned successfully'
      });
    } catch (error) {
      console.error('Ban user error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to ban user',
        error: error.message
      });
    }
  };

  exports.unbanUser = async (req, res) => {
    try {
      const { id } = req.params;

      const user = await User.findById(id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (!user.isBanned) {
        return res.status(400).json({
          success: false,
          message: 'User is not banned'
        });
      }

      user.isBanned = false;
      user.bannedAt = null;
      user.bannedBy = null;
      user.banReason = null;
      user.status = 'active';
      await user.save();

      const AdminLog = require('../models/AdminLog');
      await AdminLog.create({
        action: 'user_unbanned',
        targetUser: user._id,
        targetUserRole: user.role,
        performedBy: req.user.id,
        details: 'User unbanned and restored'
      });

      try {
        await sendEmail({
          email: user.email,
          subject: 'Account Restored - EduFlow',
          html: `
            <h2>Account Restored</h2>
            <p>Hi ${user.name},</p>
            <p>Good news! Your account ban has been lifted.</p>
            <p>You can now log in and access all platform features.</p>
            <br>
            <p>Best regards,<br>EduFlow Team</p>
          `
        });
      } catch (emailError) {
        console.error('Failed to send unban notification email:', emailError);
      }

      try {
        const Notification = require('../models/Notification');
        await Notification.create({
          user: user._id,
          type: 'system',
          title: 'Account Restored',
          message: 'Your account ban has been lifted. You can now access all features.',
          priority: 'high'
        });
      } catch (notifError) {
        console.error('Failed to create notification:', notifError);
      }

      res.json({
        success: true,
        message: 'User unbanned successfully'
      });
    } catch (error) {
      console.error('Unban user error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to unban user',
        error: error.message
      });
  }
};
