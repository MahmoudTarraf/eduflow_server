const { validationResult } = require('express-validator');
const Group = require('../models/Group');
const User = require('../models/User');
const Course = require('../models/Course');
const { sendEmail } = require('../utils/sendEmail');

// @desc    Get all groups
// @route   GET /api/groups
// @access  Private (Admin/Instructor)
exports.getGroups = async (req, res) => {
  try {
    const { course, level, page = 1, limit = 10 } = req.query;
    
    let query = {};
    
    if (course) {
      query.course = course;
    }
    
    if (level) {
      query.level = level;
    }

    // If user is instructor, only show their groups
    if (req.user.role === 'instructor') {
      query.instructor = req.user.id;
    }

    const groups = await Group.find(query)
      .populate('course', 'name level category')
      .populate('instructor', 'name email')
      .populate('students.student', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Group.countDocuments(query);

    res.json({
      success: true,
      count: groups.length,
      total,
      groups
    });
  } catch (error) {
    console.error('Get groups error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single group
// @route   GET /api/groups/:id
// @access  Private (Admin/Instructor)
exports.getGroup = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('course', 'name level category description cost currency')
      .populate('instructor', 'name email avatar')
      .populate('students.student', 'name email avatar phone');

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Check if user is instructor and owns this group
    if (req.user.role === 'instructor' && group.instructor._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this group'
      });
    }

    // Enhance students with progress data and calculate accurate payment status
    const Progress = require('../models/Progress');
    const CourseGrade = require('../models/CourseGrade');
    const Section = require('../models/Section');
    const SectionPayment = require('../models/SectionPayment');
    const groupObj = group.toObject();
    
    if (groupObj.students && groupObj.students.length > 0) {
      // Get all sections for this course to check payment completeness
      const sections = await Section.find({ course: group.course._id });
      const totalSections = sections.length;
      const freeSectionIds = sections.filter(s => s.isFree).map(s => s._id.toString());
      
      groupObj.students = await Promise.all(
        groupObj.students.map(async (studentEntry) => {
          if (studentEntry.student && studentEntry.student._id) {
            // Get actual grade from CourseGrade model
            const courseGrade = await CourseGrade.findOne({
              student: studentEntry.student._id,
              course: group.course._id
            });
            
            // Get progress tracking from Progress model (fallback)
            const progress = await Progress.findOne({
              student: studentEntry.student._id,
              course: group.course._id
            });
            
            // Calculate accurate payment status based on approved section payments
            const approvedPayments = await SectionPayment.find({
              student: studentEntry.student._id,
              course: group.course._id,
              status: 'approved'
            });

            const paidSectionIds = approvedPayments.map(p => p.section?.toString()).filter(Boolean);
            const allPaidSections = [...new Set([...freeSectionIds, ...paidSectionIds])];
            
            // Determine overall payment status
            let calculatedPaymentStatus = 'pending';
            if (totalSections === 0 || allPaidSections.length >= totalSections) {
              calculatedPaymentStatus = 'verified'; // All sections paid
            } else if (allPaidSections.length > 0) {
              calculatedPaymentStatus = 'partial'; // Some sections paid
            }
            
            return {
              ...studentEntry,
              progress: {
                total: courseGrade?.overallGrade || progress?.overallProgress?.total || 0,
                lectures: courseGrade?.lecturesCompleted || progress?.overallProgress?.lectures || 0,
                assignments: courseGrade?.assignmentsCompleted || progress?.overallProgress?.assignments || 0,
                projects: courseGrade?.projectsCompleted || progress?.overallProgress?.projects || 0
              },
              // Use calculated status
              paymentStatus: calculatedPaymentStatus,
              paidSections: allPaidSections.length,
              totalSections: totalSections
            };
          }
          return studentEntry;
        })
      );
    }

    res.json({
      success: true,
      group: groupObj
    });
  } catch (error) {
    console.error('Get group error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get group enrollment details (public info for enrollment)
// @route   GET /api/groups/:id/enrollment-info
// @access  Public
exports.getGroupEnrollmentInfo = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .select('name paymentType enrollmentFee maxStudents currentStudents startDate endDate schedule')
      .populate('course', 'name level');

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    res.json({
      success: true,
      group
    });
  } catch (error) {
    console.error('Get group enrollment info error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Create group
// @route   POST /api/groups
// @access  Private (Admin/Instructor)
exports.createGroup = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // If instructor, force instructor to current user and verify ownership of course
    let payload = { ...req.body };
    if (req.user.role === 'instructor') {
      // Verify the course belongs to this instructor
      const course = await Course.findById(req.body.course);
      if (!course) {
        return res.status(404).json({ success: false, message: 'Course not found' });
      }
      if (course.instructor.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to create groups for this course' });
      }
      payload.instructor = req.user.id;
    }

    const group = await Group.create(payload);

    // Add group to course
    await Course.findByIdAndUpdate(
      req.body.course,
      { $push: { groups: group._id } }
    );

    res.status(201).json({
      success: true,
      group
    });
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Add content to group (video/assignment/project)
// @route   POST /api/groups/:id/content
// @access  Private (Instructor/Admin)
exports.addGroupContent = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const group = await Group.findById(req.params.id).populate('course', 'instructor');
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

		if (group.isArchived || group.course?.isArchived) {
		  return res.status(400).json({
		    success: false,
		    message: 'This group is archived and no longer accepts new enrollments.'
		  });
		}

    // Ownership: instructor must own the course/group
    if (req.user.role === 'instructor') {
      if (group.course.instructor.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to manage this group' });
      }
    }

    const contentData = {
      type: req.body.type,
      title: req.body.title,
      description: req.body.description || '',
      priceFlag: req.body.priceFlag || 'paid',
      price: req.body.price || 0
    };

    // Check if file was uploaded
    if (req.file) {
      contentData.sourceType = 'upload';
      contentData.url = `/uploads/${req.file.filename}`;
      console.log(`✅ File uploaded: ${req.file.filename}`);
    } else if (req.body.url) {
      contentData.sourceType = 'url';
      contentData.url = req.body.url;
    } else {
      return res.status(400).json({ success: false, message: 'URL or file required' });
    }

    group.content.push(contentData);
    await group.save();

    res.status(201).json({
      success: true,
      content: group.content[group.content.length - 1],
      message: 'Content added successfully'
    });
  } catch (error) {
    console.error('Add group content error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// @desc    Delete content from group
// @route   DELETE /api/groups/:id/content/:contentId
// @access  Private (Instructor/Admin)
exports.deleteGroupContent = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id).populate('course', 'instructor');
    
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    
    // Check ownership
    if (req.user.role === 'instructor' && group.course.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    const content = group.content.id(req.params.contentId);
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }

    // Remove content
    content.remove();
    await group.save();
    
    res.json({ success: true, message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Enroll student to group (group-level enrollment)
// @route   POST /api/groups/:id/enroll
// @access  Private (Student)
exports.enrollInGroup = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('course', 'name cost currency isArchived');
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    if (group.isArchived || group.course?.isArchived) {
      return res.status(400).json({
        success: false,
        message: 'This group is archived and no longer accepts new enrollments.'
      });
    }

    // Capacity check
    if (group.currentStudents >= group.maxStudents) {
      return res.status(400).json({ success: false, message: 'Group is full' });
    }

    // Check if already in group
    const already = group.students.find(s => s.student.toString() === req.user.id);
    if (already) {
      return res.status(400).json({ success: false, message: 'Already requested/enrolled in this group' });
    }

    const { paymentMethod, receiptUrl, entryFeeReceiptUrl } = req.body;
    
    // Calculate entry fee from course cost if not set
    if (!group.entryFee && group.course?.cost > 0 && group.entryFeePercentage > 0) {
      group.entryFee = (group.course.cost * group.entryFeePercentage) / 100;
      await group.save();
    }

    // If group requires payment, validate payment info
    if (group.paymentType !== 'free' && group.enrollmentFee > 0) {
      if (!paymentMethod || paymentMethod === 'none') {
        return res.status(400).json({ success: false, message: 'Payment method is required for this group' });
      }
    }

    // Add student to group with pending status and payment info
    const studentData = {
      student: req.user.id,
      status: 'pending',
      paymentStatus: group.paymentType === 'free' ? 'verified' : 'pending',
      paymentMethod: paymentMethod || 'none',
      receiptUrl: receiptUrl || '',
      entryFeePaid: group.entryFee === 0,
      entryFeeReceiptUrl: entryFeeReceiptUrl || ''
    };

    // Initialize payment history for monthly payments
    if (group.paymentType === 'monthly' && group.enrollmentFee > 0) {
      const currentMonth = new Date().toISOString().slice(0, 7); // Format: "2025-10"
      studentData.paymentHistory = [{
        month: currentMonth,
        amount: group.enrollmentFee,
        paidAt: new Date(),
        receiptUrl: receiptUrl || '',
        paymentMethod: paymentMethod,
        status: 'pending'
      }];
    }

    group.students.push(studentData);
    await group.save();

    // Also record in user's enrolledCourses for course visibility if not present
    const user = await User.findById(req.user.id);
    const hasCourse = user.enrolledCourses.find(e => e.course.toString() === group.course.toString());
    if (!hasCourse) {
      user.enrolledCourses.push({ course: group.course, group: group._id, status: 'pending' });
      await user.save();
    }

    const message = group.paymentType === 'free' 
      ? 'Enrollment successful! You can now access the course.'
      : 'Enrollment request submitted. Please wait for payment verification.';
    
    res.status(201).json({ success: true, message });
  } catch (error) {
    console.error('Enroll in group error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Confirm payment for a student
// @route   POST /api/groups/:id/confirmPayment
// @access  Private (Admin/Instructor)
exports.confirmPayment = async (req, res) => {
  try {
    const { studentId, action, month, type, sectionId } = req.body; // action: 'verify' or 'reject'
    const group = await Group.findById(req.params.id);
    
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Ownership check for instructor
    if (req.user.role === 'instructor' && group.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to manage this group' });
    }

    const studentIndex = group.students.findIndex(s => s.student.toString() === studentId);
    if (studentIndex === -1) {
      return res.status(404).json({ success: false, message: 'Student not found in this group' });
    }

    const studentEntry = group.students[studentIndex];

    // Handle entry fee payment
    if (type === 'entry_fee') {
      if (action === 'verify') {
        studentEntry.entryFeePaid = true;
        studentEntry.entryFeeVerifiedAt = new Date();
      }
    }
    // Handle section payment
    else if (type === 'section' && sectionId && studentEntry.sectionPayments) {
      const paymentIndex = studentEntry.sectionPayments.findIndex(sp => sp.sectionId.toString() === sectionId);
      if (paymentIndex !== -1) {
        studentEntry.sectionPayments[paymentIndex].status = action === 'verify' ? 'verified' : 'rejected';
        studentEntry.sectionPayments[paymentIndex].verifiedAt = new Date();
        studentEntry.sectionPayments[paymentIndex].verifiedBy = req.user.id;
      }
    }
    // Handle monthly payment
    else if (month && studentEntry.paymentHistory) {
      const paymentIndex = studentEntry.paymentHistory.findIndex(p => p.month === month);
      if (paymentIndex !== -1) {
        studentEntry.paymentHistory[paymentIndex].status = action === 'verify' ? 'verified' : 'rejected';
        studentEntry.paymentHistory[paymentIndex].verifiedAt = new Date();
        studentEntry.paymentHistory[paymentIndex].verifiedBy = req.user.id;
      }
    }
    // Handle initial enrollment payment
    else {
      studentEntry.paymentStatus = action === 'verify' ? 'verified' : 'rejected';
      if (action === 'verify') {
        studentEntry.status = 'enrolled';
        
        // Update user enrolledCourses status
        const user = await User.findById(studentId);
        if (user) {
          const courseIndex = user.enrolledCourses.findIndex(e => e.course.toString() === group.course.toString());
          if (courseIndex !== -1) {
            user.enrolledCourses[courseIndex].status = 'enrolled';
            await user.save();
          }
        }
      }
    }

    await group.save();

    const message = action === 'verify' ? 'Payment verified successfully' : 'Payment rejected';
    res.json({ success: true, message });
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Submit section payment
// @route   POST /api/groups/:id/paySection
// @access  Private (Student)
exports.paySectionPayment = async (req, res) => {
  try {
    const { sectionId, paymentMethod, receiptUrl } = req.body;
    const group = await Group.findById(req.params.id)
      .populate('course', 'name sections cost currency');

    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const studentEntry = group.students.find(s => s.student.toString() === req.user.id);
    if (!studentEntry) {
      return res.status(404).json({ success: false, message: 'You are not enrolled in this group' });
    }

    // Find section in course
    const course = group.course;
    const section = course.sections?.find(s => s._id.toString() === sectionId);
    if (!section) {
      return res.status(404).json({ success: false, message: 'Section not found' });
    }

    // Check if already paid for this section
    const existingPayment = studentEntry.sectionPayments?.find(sp => sp.sectionId.toString() === sectionId);
    if (existingPayment && existingPayment.status === 'verified') {
      return res.status(400).json({ success: false, message: 'Section already paid' });
    }

    // Add or update section payment
    if (!studentEntry.sectionPayments) {
      studentEntry.sectionPayments = [];
    }

    if (existingPayment) {
      // Update existing pending payment
      existingPayment.receiptUrl = receiptUrl;
      existingPayment.paymentMethod = paymentMethod;
      existingPayment.paidAt = new Date();
      existingPayment.status = 'pending';
    } else {
      // Add new section payment
      studentEntry.sectionPayments.push({
        sectionId: section._id,
        sectionTitle: section.title,
        amount: section.price,
        paidAt: new Date(),
        receiptUrl,
        paymentMethod,
        status: 'pending'
      });
    }

    await group.save();

    res.json({
      success: true,
      message: 'Section payment submitted. Waiting for verification.'
    });
  } catch (error) {
    console.error('Pay section error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get all pending payments
// @route   GET /api/groups/pending-payments
// @access  Private (Admin/Instructor)
exports.getPendingPayments = async (req, res) => {
  try {
    let query = {};
    
    // If instructor, only show their groups
    if (req.user.role === 'instructor') {
      query.instructor = req.user.id;
    }

    const groups = await Group.find(query)
      .populate('course', 'name')
      .populate('students.student', 'name email')
      .populate('instructor', 'name email')
      .lean();

    const pendingPayments = [];

    groups.forEach(group => {
      group.students.forEach(s => {
        // Check for pending entry fee
        if (group.entryFee > 0 && !s.entryFeePaid && s.entryFeeReceiptUrl) {
          pendingPayments.push({
            groupId: group._id,
            groupName: group.name,
            courseName: group.course?.name,
            student: s.student,
            enrollmentDate: s.enrollmentDate,
            paymentMethod: s.paymentMethod,
            receiptUrl: s.entryFeeReceiptUrl,
            amount: group.entryFee,
            type: 'entry_fee',
            paymentStatus: 'pending'
          });
        }

        // Check for pending initial payment
        if (s.paymentStatus === 'pending') {
          pendingPayments.push({
            groupId: group._id,
            groupName: group.name,
            courseName: group.course?.name,
            student: s.student,
            enrollmentDate: s.enrollmentDate,
            paymentMethod: s.paymentMethod,
            receiptUrl: s.receiptUrl,
            amount: group.enrollmentFee,
            type: 'enrollment',
            paymentStatus: s.paymentStatus
          });
        }

        // Check for pending monthly payments
        if (s.paymentHistory) {
          s.paymentHistory.forEach(p => {
            if (p.status === 'pending') {
              pendingPayments.push({
                groupId: group._id,
                groupName: group.name,
                courseName: group.course?.name,
                student: s.student,
                month: p.month,
                amount: p.amount,
                paidAt: p.paidAt,
                receiptUrl: p.receiptUrl,
                paymentMethod: p.paymentMethod,
                type: 'monthly',
                paymentStatus: p.status
              });
            }
          });
        }

        // Check for pending section payments
        if (s.sectionPayments) {
          s.sectionPayments.forEach(sp => {
            if (sp.status === 'pending') {
              pendingPayments.push({
                groupId: group._id,
                groupName: group.name,
                courseName: group.course?.name,
                student: s.student,
                sectionId: sp.sectionId,
                sectionTitle: sp.sectionTitle,
                amount: sp.amount,
                paidAt: sp.paidAt,
                receiptUrl: sp.receiptUrl,
                paymentMethod: sp.paymentMethod,
                type: 'section',
                paymentStatus: sp.status
              });
            }
          });
        }
      });
    });

    res.json({ success: true, pendingPayments, count: pendingPayments.length });
  } catch (error) {
    console.error('Get pending payments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Remove student from group
// @route   DELETE /api/groups/:id/students/:studentId
// @access  Private (Admin/Instructor)
exports.removeStudent = async (req, res) => {
  try {
    const { id, studentId } = req.params;
    const group = await Group.findById(id).populate('course');
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Ownership for instructor
    if (req.user.role === 'instructor' && group.instructor.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to manage this group' });
    }

    const before = group.students.length;
    group.students = group.students.filter(s => s.student.toString() !== studentId);
    await group.save();

    // Update user enrolledCourses for this course
    const student = await User.findById(studentId);
    if (student) {
      student.enrolledCourses = student.enrolledCourses.filter(e => e.course.toString() !== group.course._id.toString());
      await student.save();
    }

    if (group.students.length === before) {
      return res.status(404).json({ success: false, message: 'Student not found in this group' });
    }

    // Clean up all related data for this student in this course
    const Progress = require('../models/Progress');
    const CourseGrade = require('../models/CourseGrade');
    const CertificateRequest = require('../models/CertificateRequest');
    const StudentPayment = require('../models/StudentPayment');
    const Section = require('../models/Section');

    // Delete progress records
    await Progress.deleteMany({ 
      student: studentId, 
      course: group.course._id 
    });

    // Delete grade records
    await CourseGrade.deleteMany({ 
      student: studentId, 
      course: group.course._id 
    });

    // Delete certificate requests
    await CertificateRequest.deleteMany({ 
      student: studentId, 
      course: group.course._id 
    });

    // Get all sections for this course/group and remove student payments
    const sections = await Section.find({ course: group.course._id });
    const sectionIds = sections.map(s => s._id);
    
    await StudentPayment.deleteMany({ 
      student: studentId, 
      course: group.course._id 
    });

    // Also delete section-specific payments
    await StudentPayment.deleteMany({ 
      student: studentId, 
      section: { $in: sectionIds }
    });

    console.log(`Cleaned up all data for student ${studentId} in course ${group.course._id}`);

    res.json({ 
      success: true, 
      message: 'Student removed from group and all related data cleaned up successfully' 
    });
  } catch (error) {
    console.error('Remove student error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Update group
// @route   PUT /api/groups/:id
// @access  Private (Admin/Instructor - own groups only)
exports.updateGroup = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id).populate('course', 'instructor');

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Check ownership for instructors
    if (req.user.role === 'instructor') {
      // Check if instructor owns the course
      if (group.course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to update this group'
        });
      }
    }

    const updatedGroup = await Group.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('course', 'name')
     .populate('instructor', 'name email');

    res.json({
      success: true,
      group: updatedGroup,
      message: 'Group updated successfully'
    });
  } catch (error) {
    console.error('Update group error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Delete group
// @route   DELETE /api/groups/:id
// @access  Private (Admin/Instructor - own groups only)
exports.deleteGroup = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id).populate('course', 'instructor');

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Check ownership for instructors
    if (req.user.role === 'instructor') {
      // Check if instructor owns the course
      if (group.course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to delete this group'
        });
      }
    }

    console.log(`Deleting group ${group._id} and removing from course ${group.course._id}`);

    // Remove group from course
    await Course.findByIdAndUpdate(
      group.course,
      { $pull: { groups: group._id } }
    );

    // Remove group from users' enrolledCourses
    await User.updateMany(
      { 'enrolledCourses.group': group._id },
      { $pull: { enrolledCourses: { group: group._id } } }
    );

    await group.deleteOne();

    res.json({
      success: true,
      message: 'Group deleted successfully'
    });
  } catch (error) {
    console.error('Delete group error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get group students
// @route   GET /api/groups/:id/students
// @access  Private (Admin/Instructor)
exports.getGroupStudents = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id)
      .populate('students.student', 'name email avatar phone enrolledCourses')
      .populate('course', 'name level cost currency');

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Check if user is instructor and owns this group
    if (req.user.role === 'instructor' && group.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this group'
      });
    }

    // Enhance students with progress data
    const Progress = require('../models/Progress');
    const studentsWithProgress = await Promise.all(
      group.students.map(async (studentEntry) => {
        if (studentEntry.student && studentEntry.student._id) {
          const progress = await Progress.findOne({
            student: studentEntry.student._id,
            course: group.course._id
          });
          
          return {
            ...studentEntry.toObject(),
            progress: {
              total: progress?.overallProgress?.total || 0,
              lectures: progress?.overallProgress?.lectures || 0,
              assignments: progress?.overallProgress?.assignments || 0,
              projects: progress?.overallProgress?.projects || 0
            }
          };
        }
        return studentEntry;
      })
    );

    res.json({
      success: true,
      students: studentsWithProgress
    });
  } catch (error) {
    console.error('Get group students error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Approve student enrollment
// @route   PUT /api/groups/:id/students/:studentId/approve
// @access  Private (Admin)
exports.approveStudent = async (req, res) => {
  try {
    const { id: groupId, studentId } = req.params;

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const studentIndex = group.students.findIndex(
      s => s.student.toString() === studentId
    );

    if (studentIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Student not found in this group'
      });
    }

    // Update student status in group
    group.students[studentIndex].status = 'enrolled';
    await group.save();

    // Update student enrollment status
    const student = await User.findById(studentId);
    const enrollmentIndex = student.enrolledCourses.findIndex(
      e => e.course.toString() === group.course.toString()
    );

    if (enrollmentIndex !== -1) {
      student.enrolledCourses[enrollmentIndex].status = 'enrolled';
      await student.save();
    }

    // Send approval email
    try {
      await sendEmail({
        email: student.email,
        subject: 'Enrollment Approved - EduFlow Academy',
        message: `Your enrollment in ${group.name} has been approved.`,
        html: `
          <h2>Enrollment Approved!</h2>
          <p>Congratulations! Your enrollment in <strong>${group.name}</strong> has been approved.</p>
          <p>You can now access your course materials and start learning.</p>
          <p>Best regards,<br>EduFlow Academy Team</p>
        `
      });
    } catch (error) {
      console.log('Email sending failed:', error);
    }

    res.json({
      success: true,
      message: 'Student enrollment approved successfully'
    });
  } catch (error) {
    console.error('Approve student error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reject student enrollment
// @route   PUT /api/groups/:id/students/:studentId/reject
// @access  Private (Admin)
exports.rejectStudent = async (req, res) => {
  try {
    const { id: groupId, studentId } = req.params;

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const studentIndex = group.students.findIndex(
      s => s.student.toString() === studentId
    );

    if (studentIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Student not found in this group'
      });
    }

    // Remove student from group
    group.students.splice(studentIndex, 1);
    await group.save();

    // Remove enrollment from student
    const student = await User.findById(studentId);
    student.enrolledCourses = student.enrolledCourses.filter(
      e => e.course.toString() !== group.course.toString()
    );
    await student.save();

    // Send rejection email
    try {
      await sendEmail({
        email: student.email,
        subject: 'Enrollment Update - EduFlow Academy',
        message: `Your enrollment in ${group.name} has been declined.`,
        html: `
          <h2>Enrollment Update</h2>
          <p>We regret to inform you that your enrollment in <strong>${group.name}</strong> has been declined.</p>
          <p>You can explore other available courses on our platform.</p>
          <p>Best regards,<br>EduFlow Academy Team</p>
        `
      });
    } catch (error) {
      console.log('Email sending failed:', error);
    }

    res.json({
      success: true,
      message: 'Student enrollment rejected successfully'
    });
  } catch (error) {
    console.error('Reject student error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
