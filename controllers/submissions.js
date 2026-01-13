const { validationResult } = require('express-validator');
const Submission = require('../models/Submission');
const Course = require('../models/Course');
const User = require('../models/User');
const Content = require('../models/Content');
const StudentProgress = require('../models/StudentProgress');
const StudentSectionGrade = require('../models/StudentSectionGrade');
const Section = require('../models/Section');
const { sendAssignmentGradedEmail } = require('../utils/emailNotifications');

// @desc    Get submissions
// @route   GET /api/submissions
// @access  Private
exports.getSubmissions = async (req, res) => {
  try {
    const { course, group, student, type, page = 1, limit = 10 } = req.query;
    
    let query = {};

    if (course) query.course = course;
    if (group) query.group = group;
    if (student) query.student = student;
    if (type) query.type = type;

    // If user is student, only show their submissions
    if (req.user.role === 'student') {
      query.student = req.user.id;
    }

    // If user is instructor, show submissions for their courses
    if (req.user.role === 'instructor') {
      const instructorCourses = await Course.find({ instructor: req.user.id }).select('_id');
      query.course = { $in: instructorCourses.map(c => c._id) };
    }

    const submissions = await Submission.find(query)
      .populate('student', 'name email avatar')
      .populate('course', 'name level')
      .populate('group', 'name')
      .sort({ submittedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Submission.countDocuments(query);

    res.json({
      success: true,
      count: submissions.length,
      total,
      submissions
    });
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

const recomputeSectionGrade = async (studentId, sectionId) => {
  const contents = await Content.find({ section: sectionId });
  if (!contents.length) return;

  const progress = await StudentProgress.find({ student: studentId, section: sectionId });

  const lectureItems = contents.filter((item) => item.type === 'lecture');
  const assignmentItems = contents.filter((item) => item.type === 'assignment');
  const projectItems = contents.filter((item) => item.type === 'project');

  const lectureScore = averageLectureScore(progress, lectureItems);
  const assignmentScore = averageGradedScore(progress, assignmentItems);
  const projectScore = averageGradedScore(progress, projectItems);

  const components = [];
  if (lectureItems.length) components.push(lectureScore);
  if (assignmentItems.length) components.push(assignmentScore);
  if (projectItems.length) components.push(projectScore);

  if (!components.length) return;

  const sectionGrade = Number((components.reduce((sum, value) => sum + value, 0) / components.length).toFixed(2));

  await StudentSectionGrade.findOneAndUpdate(
    { student: studentId, section: sectionId },
    { student: studentId, section: sectionId, gradePercent: sectionGrade, updatedAt: new Date() },
    { upsert: true, new: true }
  );
};

const averageLectureScore = (progressEntries, lectureItems) => {
  if (!lectureItems.length) return 0;
  const total = lectureItems.reduce((sum, item) => {
    const entry = progressEntries.find((record) => record.content?.toString() === item._id.toString());
    return sum + (entry && entry.completed ? 100 : 0);
  }, 0);
  return total / lectureItems.length;
};

const averageGradedScore = (progressEntries, items) => {
  if (!items.length) return 0;
  const total = items.reduce((sum, item) => {
    const entry = progressEntries.find((record) => record.content?.toString() === item._id.toString());
    if (!entry) return sum;

    if (entry.status === 'graded' && entry.grade?.score !== undefined) {
      return sum + entry.grade.score;
    }

    if (entry.status === 'submitted_ungraded') {
      return sum + 50;
    }

    return sum;
  }, 0);

  return total / items.length;
};

// @desc    Get single submission
// @route   GET /api/submissions/:id
// @access  Private
exports.getSubmission = async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('student', 'name email avatar')
      .populate('course', 'name level')
      .populate('group', 'name')
      .populate('gradedBy', 'name email');

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check authorization
    if (req.user.role === 'student' && submission.student._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this submission'
      });
    }

    res.json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Get submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Create submission
// @route   POST /api/submissions
// @access  Private (Student)
exports.createSubmission = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { course, group, type, assignment, project, files } = req.body;

    // Check if submission already exists
    const existingSubmission = await Submission.findOne({
      student: req.user.id,
      course,
      group,
      type,
      ...(type === 'assignment' ? { assignment } : { project })
    });

    if (existingSubmission) {
      return res.status(400).json({
        success: false,
        message: 'Submission already exists for this item'
      });
    }

    const submission = await Submission.create({
      student: req.user.id,
      course,
      group,
      type,
      assignment: type === 'assignment' ? assignment : undefined,
      project: type === 'project' ? project : undefined,
      files: files || []
    });

    const populatedSubmission = await Submission.findById(submission._id)
      .populate('student', 'name email avatar')
      .populate('course', 'name level')
      .populate('group', 'name');

    if (type === 'assignment' || type === 'project') {
      const contentId = type === 'assignment' ? assignment : project;
      const contentDoc = await Content.findById(contentId).populate('section group course');
      if (!contentDoc) {
        return res.status(404).json({
          success: false,
          message: 'Linked content not found'
        });
      }

      const progressFilter = {
        student: req.user.id,
        content: contentDoc._id
      };

      const progressUpdate = {
        student: req.user.id,
        course: contentDoc.course,
        group: contentDoc.group,
        section: contentDoc.section,
        item: contentDoc._id,
        content: contentDoc._id,
        type: contentDoc.type,
        contentType: contentDoc.type,
        submitted: true,
        submittedAt: new Date(),
        status: 'submitted_ungraded',
        grade: {
          score: 50
        }
      };

      await StudentProgress.findOneAndUpdate(progressFilter, progressUpdate, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      });

      if (contentDoc.section) {
        await recomputeSectionGrade(req.user.id, contentDoc.section);
      }
    }

    res.status(201).json({
      success: true,
      submission: populatedSubmission
    });
  } catch (error) {
    console.error('Create submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update submission
// @route   PUT /api/submissions/:id
// @access  Private (Student)
exports.updateSubmission = async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check if user is the student who made the submission
    if (submission.student.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this submission'
      });
    }

    // Check if submission is already graded
    if (submission.status === 'graded') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update graded submission'
      });
    }

    const updatedSubmission = await Submission.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('student', 'name email avatar')
     .populate('course', 'name level')
     .populate('group', 'name');

    res.json({
      success: true,
      submission: updatedSubmission
    });
  } catch (error) {
    console.error('Update submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Grade submission
// @route   PUT /api/submissions/:id/grade
// @access  Private (Instructor/Admin)
exports.gradeSubmission = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { score, feedback } = req.body;

    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check if user is instructor of the course
    if (req.user.role === 'instructor') {
      const course = await Course.findById(submission.course);
      if (course.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to grade this submission'
        });
      }
    }

    submission.grade = {
      score,
      feedback,
      gradedBy: req.user.id,
      gradedAt: new Date()
    };
    submission.status = 'graded';

    await submission.save();

    // Update student progress status
    const contentId = submission.type === 'assignment' ? submission.assignment : submission.project;
    if (contentId) {
      const contentDoc = await Content.findById(contentId).populate('section group course');
      if (contentDoc) {
        await StudentProgress.findOneAndUpdate(
          {
            student: submission.student,
            content: contentDoc._id
          },
          {
            student: submission.student,
            content: contentDoc._id,
            course: contentDoc.course,
            group: contentDoc.group,
            section: contentDoc.section,
            type: contentDoc.type,
            contentType: contentDoc.type,
            submitted: true,
            submittedAt: submission.createdAt,
            status: 'graded',
            grade: {
              score,
              feedback,
              gradedAt: new Date(),
              gradedBy: req.user.id
            }
          },
          { new: true, upsert: true }
        );

        if (contentDoc.section) {
          await recomputeSectionGrade(submission.student, contentDoc.section);
        }
      }
    }

    // Add notification to student
    const student = await User.findById(submission.student);
    student.notifications.push({
      message: `Your ${submission.type} has been graded. Score: ${score}/100`,
      type: 'info',
      read: false
    });
    await student.save();

    const populatedSubmission = await Submission.findById(submission._id)
      .populate('student', 'name email avatar')
      .populate('course', 'name level')
      .populate('group', 'name')
      .populate('assignment', 'title')
      .populate('project', 'title')
      .populate('gradedBy', 'name email');

    // Send email notification to student
    try {
      const assignmentTitle = populatedSubmission.assignment?.title || populatedSubmission.project?.title || 'Assignment';
      await sendAssignmentGradedEmail(
        populatedSubmission.student.email,
        populatedSubmission.student.name,
        assignmentTitle,
        score,
        populatedSubmission.course.name
      );
    } catch (emailError) {
      console.error('Failed to send assignment graded email:', emailError);
    }

    res.json({
      success: true,
      submission: populatedSubmission
    });
  } catch (error) {
    console.error('Grade submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete submission
// @route   DELETE /api/submissions/:id
// @access  Private (Student)
exports.deleteSubmission = async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check if user is the student who made the submission
    if (submission.student.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this submission'
      });
    }

    // Check if submission is already graded
    if (submission.status === 'graded') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete graded submission'
      });
    }

    await submission.deleteOne();

    res.json({
      success: true,
      message: 'Submission deleted successfully'
    });
  } catch (error) {
    console.error('Delete submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
