const CertificateRequest = require('../models/CertificateRequest');
const CourseGrade = require('../models/CourseGrade');
const Course = require('../models/Course');
const Group = require('../models/Group');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');
const Message = require('../models/Message');
const AdminSettings = require('../models/AdminSettings');
const { sendEmail } = require('../utils/sendEmail');
const { calculateCourseGrade } = require('../services/gradingService');
const { ELIGIBILITY_STATUSES, isStudentEligibleForCertificate } = require('../services/certificateEligibilityService');
const { sendCertificateReceivedEmail } = require('../utils/emailNotifications');
const { constructUploadPath, constructFileUrl } = require('../utils/urlHelper');
const { emitInstructorPendingSummaryUpdate } = require('./instructorDashboard');

// @desc    Request certificate
// @route   POST /api/certificates/request
// @access  Private (Student)
exports.requestCertificate = async (req, res) => {
  try {
    const { courseId, groupId } = req.body;
    
    // Check if course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    
    // Determine effective certificate mode
    const certificateMode = course.certificateMode || 'automatic';

    // Check if course offers certificates and mode is not disabled
    if (!course.offersCertificate || certificateMode === 'disabled') {
      return res.status(403).json({ 
        success: false, 
        message: 'This course does not offer a certificate upon completion' 
      });
    }
    
    // Check if student is enrolled
    const user = await User.findById(req.user.id);
    const enrollment = await Enrollment.findOne({
      student: req.user.id,
      course: courseId
    });
    
    if (!enrollment) {
      return res.status(403).json({ success: false, message: 'You are not enrolled in this course' });
    }
    
    // Check if already requested
    const existing = await CertificateRequest.findOne({
      student: req.user.id,
      course: courseId
    });
    
    // If already requested and not rejected, don't allow re-request
    if (existing && existing.status !== 'rejected') {
      return res.status(400).json({
        success: false,
        message: `Certificate request already ${existing.status}`
      });
    }
    
    // If rejected, delete the old request to allow re-requesting
    if (existing && existing.status === 'rejected') {
      await CertificateRequest.findByIdAndDelete(existing._id);
    }
    
    // Manual instructor mode: instructor must open certificate requests first
    if (certificateMode === 'manual_instructor' && !course.instructorCertificateRelease) {
      return res.status(403).json({
        success: false,
        message: 'The instructor has not yet enabled certificate requests for this course'
      });
    }
    
    // Calculate course grade using unified grading service (group-aware)
    const { courseGrade, sectionGrades, stats } = await calculateCourseGrade(req.user.id, courseId, groupId);

    // Get CourseGrade record and global passing grade to check completion
    const [courseGradeRecord, settings] = await Promise.all([
      CourseGrade.findOne({
        student: req.user.id,
        course: courseId
      }),
      AdminSettings.getSettings()
    ]);

    const passingGrade = typeof settings.passingGrade === 'number' ? settings.passingGrade : 60;

    console.log('[CertificateRequest] Course completion check:', {
      studentId: req.user.id,
      courseId,
      groupId,
      courseGrade,
      hasGradeRecord: Boolean(courseGradeRecord),
      isComplete: courseGradeRecord?.isComplete,
      sectionsCompleted: courseGradeRecord?.sectionsCompleted,
      sectionsTotal: courseGradeRecord?.sectionsCount,
      overallGrade: courseGradeRecord?.overallGrade,
      passingGrade,
      stats
    });

    // Use CourseGrade helper to enforce new 100% definition:
    // - all sections completed (isComplete)
    // - overall grade >= AdminSettings.passingGrade
    const canRequestFromGrade = courseGradeRecord
      ? courseGradeRecord.canRequestCertificate(passingGrade)
      : false;

    if (!courseGradeRecord || !courseGradeRecord.isComplete || !canRequestFromGrade) {
      const completionDetails = courseGradeRecord
        ? {
            sectionsCompleted: courseGradeRecord.sectionsCompleted,
            sectionsTotal: courseGradeRecord.sectionsCount,
            percentage:
              courseGradeRecord.sectionsCount > 0
                ? Math.round(
                    (courseGradeRecord.sectionsCompleted / courseGradeRecord.sectionsCount) * 100
                  )
                : 0,
            overallGrade: courseGradeRecord.overallGrade,
            passingGrade
          }
        : null;

      console.warn('[CertificateRequest] Course not eligible by completion/grade:', {
        studentId: req.user.id,
        courseId,
        completionDetails
      });

      const baseMessage = completionDetails
        ? `You must complete all sections of the course and reach the minimum overall grade of ${passingGrade}%.`
        : 'You must complete all sections of the course before requesting a certificate';

      const progressMessage = completionDetails
        ? ` Progress: ${completionDetails.sectionsCompleted}/${completionDetails.sectionsTotal} sections (${completionDetails.percentage}%), grade: ${Math.round(
            completionDetails.overallGrade || 0
          )}% (required: ${passingGrade}%).`
        : '';

      return res.status(403).json({
        success: false,
        message: `${baseMessage}${progressMessage}`,
        courseGrade,
        stats,
        completionStatus: completionDetails
      });
    }
    
    // Create request
    const request = await CertificateRequest.create({
      student: req.user.id,
      course: courseId,
      group: groupId || enrollment.group,
      courseGrade,
      status: 'requested'
    });
    
    // Notify instructor via Socket.IO and refresh instructor pending summary strip
    const io = req.app.get('io');
    if (io && course.instructor) {
      io.to(`user:${course.instructor}`).emit('certificate_requested', {
        requestId: request._id,
        studentName: user.name,
        courseName: course.name
      });

      try {
        await emitInstructorPendingSummaryUpdate(io, course.instructor.toString());
      } catch (e) {
        console.error('Failed to emit instructor pending summary after certificate request:', e.message);
      }
    }
    
    // Send email notifications
    let instructor = null;
    
    // Send email to instructor
    try {
      instructor = await User.findById(course.instructor);
      if (instructor && instructor.email) {
        await sendEmail({
          email: instructor.email,
          subject: 'New Certificate Request - EduFlow Academy',
          html: `
            <h2>New Certificate Request</h2>
            <p>Dear ${instructor.name},</p>
            <p>A student has requested a certificate for your course.</p>
            <p><strong>Student:</strong> ${user.name} (${user.email})</p>
            <p><strong>Course:</strong> ${course.name}</p>
            <p><strong>Final Grade:</strong> ${courseGrade}%</p>
            <p>Please review and process this request in your dashboard.</p>
            <br>
            <p>Best regards,<br>EduFlow Academy Team</p>
          `
        });
        console.log(`[Certificate Request] Email sent to instructor: ${instructor.email}`);
      }
    } catch (emailError) {
      console.error('[Certificate Request] Instructor email failed:', emailError.message);
    }
    
    // Send email to admin
    try {
      const admin = await User.findOne({ role: 'admin' });
      if (admin && admin.email) {
        await sendEmail({
          email: admin.email,
          subject: 'New Certificate Request - EduFlow Academy',
          html: `
            <h2>New Certificate Request</h2>
            <p>Dear Admin,</p>
            <p>A student has requested a certificate.</p>
            <p><strong>Student:</strong> ${user.name} (${user.email})</p>
            <p><strong>Course:</strong> ${course.name}</p>
            <p><strong>Instructor:</strong> ${instructor?.name || 'Unknown'}</p>
            <p><strong>Final Grade:</strong> ${courseGrade}%</p>
            <p>Please review this request in the admin dashboard.</p>
            <br>
            <p>Best regards,<br>EduFlow Academy System</p>
          `
        });
        console.log(`[Certificate Request] Email sent to admin: ${admin.email}`);
      }
    } catch (emailError) {
      console.error('[Certificate Request] Admin email failed:', emailError.message);
    }
    
    res.status(201).json({
      success: true,
      request,
      message: 'Certificate request submitted successfully'
    });
  } catch (error) {
    console.error('Request certificate error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// @desc    Get certificate requests (for instructor/admin)
// @route   GET /api/certificates/requests
// @access  Private (Instructor/Admin)
exports.getCertificateRequests = async (req, res) => {
  try {
    let query = {};
    
    // If instructor, only show requests for their courses
    if (req.user.role === 'instructor') {
      const courses = await Course.find({ instructor: req.user.id }).select('_id');
      query.course = { $in: courses.map(c => c._id) };
    }
    
    // Filter by status if provided
    if (req.query.status) {
      query.status = req.query.status;
    }
    
    const requests = await CertificateRequest.find(query)
      .populate('student', 'name email avatar')
      .populate('course', 'name level')
      .populate('group', 'name')
      .populate('issuedBy', 'name')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      count: requests.length,
      requests
    });
  } catch (error) {
    console.error('Get certificate requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get my certificates
// @route   GET /api/certificates/my
// @access  Private (Student)
exports.getMyCertificates = async (req, res) => {
  try {
    const certificates = await CertificateRequest.find({
      student: req.user.id,
      status: 'issued'
    })
      .populate('course', 'name level category')
      .populate('group', 'name')
      .sort({ issuedAt: -1 });
    
    res.json({
      success: true,
      count: certificates.length,
      certificates
    });
  } catch (error) {
    console.error('Get my certificates error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get all my certificate requests (all statuses)
// @route   GET /api/certificates/my-requests
// @access  Private (Student)
exports.getMyRequests = async (req, res) => {
  try {
    const requests = await CertificateRequest.find({
      student: req.user.id
    })
      .populate('course', 'name level category')
      .populate('group', 'name')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      count: requests.length,
      requests
    });
  } catch (error) {
    console.error('Get my requests error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.getMyCertificateEligibility = async (req, res) => {
  try {
    const enrollments = await Enrollment.find({
      student: req.user.id,
      status: { $in: ['approved', 'enrolled', 'completed'] }
    })
      .populate('course', 'name image level category duration cost instructor offersCertificate certificateMode instructorCertificateRelease')
      .populate('group', 'name startDate endDate schedule')
      .sort({ createdAt: -1 });

    const enrollmentSummaries = [];

    for (const enrollment of enrollments) {
      if (!enrollment.course || !enrollment.group) {
        continue;
      }

      let eligibility = null;

      try {
        eligibility = await isStudentEligibleForCertificate(
          req.user.id,
          enrollment.group._id.toString()
        );
      } catch (err) {
        console.error('[getMyCertificateEligibility] Error evaluating eligibility', {
          studentId: req.user.id,
          enrollmentId: enrollment._id,
          courseId: enrollment.course?._id,
          groupId: enrollment.group?._id,
          error: err.message
        });
      }

      const details = eligibility?.details || {};
      const overallGrade =
        typeof details.overallGrade === 'number'
          ? details.overallGrade
          : 0;

      const hasGrade = typeof details.overallGrade === 'number';

      enrollmentSummaries.push({
        _id: enrollment._id,
        course: enrollment.course,
        group: enrollment.group,
        status: enrollment.status === 'approved' ? 'enrolled' : enrollment.status,
        enrolledAt: enrollment.createdAt,
        overallGrade,
        hasGrade,
        eligibilityStatus: eligibility?.status || null,
        eligibilityDetails: details
      });
    }

    res.json({
      success: true,
      enrolledCourses: enrollmentSummaries
    });
  } catch (error) {
    console.error('Get my certificate eligibility error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Approve certificate and upload file
// @route   POST /api/certificates/:id/approve
// @access  Private (Instructor/Admin)
exports.approveCertificate = async (req, res) => {
  try {
    const request = await CertificateRequest.findById(req.params.id)
      .populate('course', 'instructor name')
      .populate('student', 'name email');
    
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    // Check ownership for instructors
    if (req.user.role === 'instructor' && request.course.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    // Require certificate file upload (PDF or image)
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Certificate file (PDF, JPG, or PNG) is required'
      });
    }
    
    request.status = 'issued';
    request.issuedAt = new Date();
    request.issuedBy = req.user.id;
    request.certificateFile = {
      originalName: req.file.originalname,
      storedName: req.file.filename,
      url: constructUploadPath('certificates', req.file.filename),
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date()
    };
    
    await request.save();

    // Update instructor pending summary (one fewer pending certificate)
    try {
      const io = req.app.get('io');
      if (io && request.course && request.course.instructor) {
        await emitInstructorPendingSummaryUpdate(io, request.course.instructor.toString());
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after certificate approval:', e.message);
    }

    // Create in-app message
    const messageContent = `Hi ${request.student.name}, your certificate for "${request.course.name}" is ready. Download from your certificates page.`;
    const subject = `Certificate available for ${request.course.name}`;
    
    await Message.create({
      sender: req.user.id,
      recipient: request.student._id,
      conversationType: 'direct',
      subject,
      content: messageContent,
      course: request.course._id,
      group: request.group
    });
    
    // Notify student via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${request.student._id}`).emit('certificate_issued', {
        certificateId: request._id,
        courseName: request.course.name,
        certificateUrl: request.certificateFile.url
      });
    }
    
    // Send email notification
    try {
      await sendCertificateReceivedEmail(
        request.student.email,
        request.student.name,
        request.course.name,
        request.certificateFile.url
      );
    } catch (emailError) {
      console.error('Email send error:', emailError);
    }
    
    res.json({
      success: true,
      request,
      message: 'Certificate approved and student notified'
    });
  } catch (error) {
    console.error('Approve certificate error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// @desc    Reject certificate request
// @route   POST /api/certificates/:id/reject
// @access  Private (Instructor/Admin)
exports.rejectCertificate = async (req, res) => {
  try {
    const request = await CertificateRequest.findById(req.params.id)
      .populate('course', 'instructor');
    
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    // Check ownership for instructors
    if (req.user.role === 'instructor' && request.course.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    request.status = 'rejected';
    request.rejectionReason = req.body.reason || 'Did not meet requirements';
    
    await request.save();

    // Update instructor pending summary (one fewer pending certificate)
    try {
      const io = req.app.get('io');
      if (io && request.course && request.course.instructor) {
        await emitInstructorPendingSummaryUpdate(io, request.course.instructor.toString());
      }
    } catch (e) {
      console.error('Failed to emit instructor pending summary after certificate rejection:', e.message);
    }

    res.json({
      success: true,
      message: 'Certificate request rejected'
    });
  } catch (error) {
    console.error('Reject certificate error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Delete certificate request
// @route   DELETE /api/certificates/:id
// @access  Private (Admin)
exports.deleteCertificateRequest = async (req, res) => {
  try {
    const request = await CertificateRequest.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    
    await request.deleteOne();
    
    res.json({
      success: true,
      message: 'Certificate request deleted'
    });
  } catch (error) {
    console.error('Delete certificate request error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
