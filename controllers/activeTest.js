const ActiveTest = require('../models/ActiveTest');
const TestAttempt = require('../models/TestAttempt');
const Section = require('../models/Section');
const Group = require('../models/Group');
const CourseGrade = require('../models/CourseGrade');
const { awardPointsInternal, awardOnceForActivityInternal } = require('./gamification');
const { calculateCourseGrade } = require('../services/gradingService');

// @desc    Create a new active test
// @route   POST /api/active-tests
// @access  Private (Instructor)
exports.createTest = async (req, res) => {
  try {
    const {
      title,
      description,
      sectionId,
      courseId,
      groupId,
      questions,
      timeLimitMinutes,
      passingScore,
      maxAttempts,
      startDate,
      endDate,
      shuffleQuestions,
      shuffleOptions,
      showResultsImmediately,
      showCorrectAnswers
    } = req.body;

    // Validate required fields
    if (!sectionId || !courseId || !groupId) {
      return res.status(400).json({
        success: false,
        message: 'Section ID, Course ID, and Group ID are required'
      });
    }

    // Validate section exists and belongs to the instructor
    const section = await Section.findById(sectionId).populate('group');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Check if user is the instructor of this group
    if (group.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to create tests for this group'
      });
    }

    // Validate questions
    if (!questions || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Test must have at least one question'
      });
    }

    // Validate each question has at least one correct answer
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      if (!question.options || question.options.length < 2) {
        return res.status(400).json({
          success: false,
          message: `Question ${i + 1} must have at least 2 options`
        });
      }
      const hasCorrectAnswer = question.options.some(opt => opt.isCorrect);
      if (!hasCorrectAnswer) {
        return res.status(400).json({
          success: false,
          message: `Question ${i + 1} must have at least one correct answer`
        });
      }
    }

    const test = await ActiveTest.create({
      title,
      description,
      section: sectionId,
      course: courseId,
      group: groupId,
      instructor: req.user.id,
      questions,
      timeLimitMinutes,
      passingScore: passingScore || 60,
      maxAttempts: maxAttempts || 1,
      startDate,
      endDate,
      shuffleQuestions: shuffleQuestions || false,
      shuffleOptions: shuffleOptions || false,
      showResultsImmediately: showResultsImmediately !== false,
      showCorrectAnswers: showCorrectAnswers !== false
    });

    res.status(201).json({
      success: true,
      message: 'Test created successfully',
      test
    });
  } catch (error) {
    console.error('Create test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get all tests for a section
// @route   GET /api/active-tests/section/:sectionId
// @access  Private
exports.getTestsBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;

    const tests = await ActiveTest.find({ 
      section: sectionId,
      isActive: true
    })
      .populate('instructor', 'name email')
      .sort({ createdAt: -1 });

    // For students, hide correct answers
    if (req.user.role === 'student') {
      tests.forEach(test => {
        test.questions.forEach(question => {
          question.options.forEach(option => {
            delete option.isCorrect;
          });
        });
      });
    }

    res.json({
      success: true,
      count: tests.length,
      tests
    });
  } catch (error) {
    console.error('Get tests error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get a single test
// @route   GET /api/active-tests/:id
// @access  Private
exports.getTest = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.id)
      .populate('instructor', 'name email')
      .populate('section', 'name')
      .populate('course', 'name')
      .populate('group', 'name');

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    // For students, hide correct answers unless they've completed the test
    if (req.user.role === 'student') {
      const attempt = await TestAttempt.findOne({
        test: test._id,
        student: req.user.id,
        status: { $in: ['submitted', 'graded'] }
      });

      if (!attempt || !test.showCorrectAnswers) {
        test.questions.forEach(question => {
          question.options.forEach(option => {
            delete option.isCorrect;
          });
        });
      }
    }

    res.json({
      success: true,
      test
    });
  } catch (error) {
    console.error('Get test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update a test
// @route   PUT /api/active-tests/:id
// @access  Private (Instructor)
exports.updateTest = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.id);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    // Check if user is the instructor
    if (test.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this test'
      });
    }

    // Check if test has any graded attempts
    const attemptCount = await TestAttempt.countDocuments({ 
      test: test._id,
      status: 'graded'
    });
    
    // Prepare update data
    const updateData = { ...req.body };
    
    // If there are attempts, prevent question modifications
    if (attemptCount > 0 && req.body.questions) {
      // Check if questions are being changed
      const questionsChanged = JSON.stringify(test.questions) !== JSON.stringify(req.body.questions);
      if (questionsChanged) {
        return res.status(400).json({
          success: false,
          message: `Cannot modify questions after ${attemptCount} student(s) have completed the test. You can update other settings like time limit, passing score, etc.`
        });
      }
    }

    const updatedTest = await ActiveTest.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({
      success: true,
      message: attemptCount > 0 
        ? `Test updated successfully. Note: ${attemptCount} student(s) have already taken this test.`
        : 'Test updated successfully',
      test: updatedTest,
      hasAttempts: attemptCount > 0
    });
  } catch (error) {
    console.error('Update test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete a test
// @route   DELETE /api/active-tests/:id
// @access  Private (Instructor)
exports.deleteTest = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.id);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    // Check if user is the instructor
    if (test.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this test'
      });
    }

    // Delete all attempts for this test
    await TestAttempt.deleteMany({ test: test._id });

    await test.deleteOne();

    res.json({
      success: true,
      message: 'Test and all attempts deleted successfully'
    });
  } catch (error) {
    console.error('Delete test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Start a test attempt
// @route   POST /api/active-tests/:testId/start
// @access  Private (Student)
exports.startTest = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.testId);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    if (!test.isActive) {
      return res.status(400).json({
        success: false,
        message: 'This test is not active'
      });
    }

    // Check if test is within available dates
    const now = new Date();
    if (test.startDate && now < test.startDate) {
      return res.status(400).json({
        success: false,
        message: 'Test has not started yet'
      });
    }
    if (test.endDate && now > test.endDate) {
      return res.status(400).json({
        success: false,
        message: 'Test has ended'
      });
    }

    // Check if student is enrolled in the group
    const group = await Group.findById(test.group);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Test group not found'
      });
    }

    const isEnrolled = group.students.some(
      s => s.student.toString() === req.user.id && s.status === 'enrolled'
    );

    if (!isEnrolled) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in this course group'
      });
    }

    // Check existing attempts
    const allAttempts = await TestAttempt.find({
      test: test._id,
      student: req.user.id
    }).sort({ attemptNumber: -1 });

    // Check for in-progress attempt
    const inProgressAttempt = allAttempts.find(a => a.status === 'in_progress');
    if (inProgressAttempt) {
      // Return test with questions (without correct answers)
      const testObj = test.toObject();
      testObj.questions.forEach(question => {
        question.options.forEach(option => {
          delete option.isCorrect;
        });
      });

      return res.json({
        success: true,
        message: 'Resuming existing attempt',
        attempt: inProgressAttempt,
        test: testObj
      });
    }

    // Check if max attempts reached (only count completed/graded attempts)
    const completedAttempts = allAttempts.filter(a => a.status === 'graded');
    if (completedAttempts.length >= test.maxAttempts) {
      // Get best attempt to show results
      const bestAttempt = completedAttempts.reduce((best, current) => {
        return (current.score || 0) > (best.score || 0) ? current : best;
      }, completedAttempts[0]);

      return res.status(400).json({
        success: false,
        message: `Maximum attempts (${test.maxAttempts}) reached. View your best result.`,
        showResults: true,
        attemptId: bestAttempt._id
      });
    }

    // Calculate total points
    const totalPoints = test.questions.reduce((sum, q) => sum + (q.points || 1), 0);

    // Create new attempt
    const attemptNumber = allAttempts.length + 1;
    const endTime = new Date(Date.now() + test.timeLimitMinutes * 60 * 1000);

    const attempt = await TestAttempt.create({
      test: test._id,
      student: req.user.id,
      section: test.section,
      course: test.course,
      group: test.group,
      startTime: new Date(),
      endTime,
      totalPoints,
      attemptNumber,
      status: 'in_progress'
    });

    // Return test with questions (without correct answers)
    const testObj = test.toObject();
    testObj.questions.forEach(question => {
      question.options.forEach(option => {
        delete option.isCorrect;
      });
    });

    res.json({
      success: true,
      message: 'Test started successfully',
      attempt,
      test: testObj
    });
  } catch (error) {
    console.error('Start test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Submit test attempt
// @route   POST /api/active-tests/:testId/submit
// @access  Private (Student)
exports.submitTest = async (req, res) => {
  try {
    const { attemptId, answers } = req.body;

    const attempt = await TestAttempt.findById(attemptId).populate('test');

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: 'Attempt not found'
      });
    }

    // Verify student owns this attempt
    if (attempt.student.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    if (attempt.status !== 'in_progress') {
      return res.status(400).json({
        success: false,
        message: 'This attempt has already been submitted'
      });
    }

    const test = attempt.test;
    const now = new Date();

    // Check if time expired
    const autoSubmitted = now > attempt.endTime;

    // Grade the test
    let pointsEarned = 0;
    const gradedAnswers = answers.map(answer => {
      const question = test.questions.id(answer.questionId);
      if (!question) {
        return {
          questionId: answer.questionId,
          selectedOptionIndex: answer.selectedOptionIndex,
          isCorrect: false,
          pointsEarned: 0
        };
      }

      const selectedOption = question.options[answer.selectedOptionIndex];
      const isCorrect = selectedOption && selectedOption.isCorrect;
      const points = isCorrect ? (question.points || 1) : 0;
      pointsEarned += points;

      return {
        questionId: answer.questionId,
        selectedOptionIndex: answer.selectedOptionIndex,
        isCorrect,
        pointsEarned: points
      };
    });

    // Calculate score percentage
    const score = attempt.totalPoints > 0 
      ? Math.round((pointsEarned / attempt.totalPoints) * 100) 
      : 0;
    const passed = score >= test.passingScore;

    // Update attempt
    attempt.answers = gradedAnswers;
    attempt.submitTime = now;
    attempt.status = 'graded';
    attempt.score = score;
    attempt.pointsEarned = pointsEarned;
    attempt.passed = passed;
    attempt.autoSubmitted = autoSubmitted;

    await attempt.save();

    // Populate test details for response
    await attempt.populate('test');

    // Trigger grade recalculation for this section
    try {
      const { updateSectionGrade } = require('../services/gradingService');
      await updateSectionGrade(req.user.id, test.section);
    } catch (gradeError) {
      console.error('Error updating section grade after test submission:', gradeError);
      // Don't fail the test submission if grade update fails
    }

    let quizAward = null;
    try {
      if (attempt.passed) {
        quizAward = await awardOnceForActivityInternal({
          studentId: req.user.id,
          activityType: 'testComplete',
          contentId: test._id,
          contentModel: 'ActiveTest',
          contentTitle: test.title,
          courseId: test.course,
          metadata: { score: score, totalPoints: attempt.totalPoints }
        });
      }
    } catch (e) {
      // ignore
    }

    let courseAward = null;
    try {
      const prev = await CourseGrade.findOne({ student: req.user.id, course: test.course });
      await calculateCourseGrade(req.user.id, test.course);
      const now = await CourseGrade.findOne({ student: req.user.id, course: test.course });
      if (!prev?.isComplete && now?.isComplete) {
        courseAward = await awardPointsInternal(req.user.id, 'course');
      }
    } catch (e) {
      // ignore
    }

    const gamification = {};

    if (quizAward && quizAward.success) {
      Object.assign(gamification, quizAward);
    }

    if (courseAward && courseAward.success) {
      gamification.courseAward = courseAward;
    }

    res.json({
      success: true,
      message: 'Test submitted successfully',
      attempt,
      autoSubmitted,
      gamification: Object.keys(gamification).length ? gamification : { success: true, pointsAwarded: 0, awardedBadges: [], assignedTitle: null }
    });
  } catch (error) {
    console.error('Submit test error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get student's attempts for a test
// @route   GET /api/active-tests/:id/attempts
// @access  Private (Student/Instructor)
exports.getTestAttempts = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.id);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    let query = { test: test._id };

    // Students can only see their own attempts
    if (req.user.role === 'student') {
      query.student = req.user.id;
    } else if (req.user.role === 'instructor') {
      // Instructors can see all attempts for their tests
      if (test.instructor.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized'
        });
      }
    }

    const attempts = await TestAttempt.find(query)
      .populate('student', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: attempts.length,
      attempts
    });
  } catch (error) {
    console.error('Get attempts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single attempt by ID
// @route   GET /api/active-tests/attempts/:attemptId
// @access  Private (Student/Instructor)
exports.getSingleAttempt = async (req, res) => {
  try {
    const attempt = await TestAttempt.findById(req.params.attemptId)
      .populate('test')
      .populate('student', 'name email');

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: 'Attempt not found'
      });
    }

    // Students can only see their own attempts
    if (req.user.role === 'student' && attempt.student._id.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this attempt'
      });
    }

    // Instructors can only see attempts for their tests
    if (req.user.role === 'instructor' && attempt.test.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this attempt'
      });
    }

    res.json({
      success: true,
      attempt
    });
  } catch (error) {
    console.error('Get single attempt error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get test statistics (for instructor)
// @route   GET /api/active-tests/:id/statistics
// @access  Private (Instructor)
exports.getTestStatistics = async (req, res) => {
  try {
    const test = await ActiveTest.findById(req.params.id);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    if (test.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const attempts = await TestAttempt.find({ 
      test: test._id,
      status: 'graded'
    }).populate('student', 'name email');

    // Filter out attempts with missing student references to avoid crashes
    const validAttempts = attempts.filter(a => a && a.student);

    const totalAttempts = validAttempts.length;
    const uniqueStudents = new Set(
      validAttempts.map(a => a.student._id.toString())
    ).size;
    
    const scores = validAttempts.map(a => a.score);
    const averageScore = scores.length > 0 
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length 
      : 0;
    
    const passedCount = validAttempts.filter(a => a.passed).length;
    const passRate = totalAttempts > 0 ? (passedCount / totalAttempts) * 100 : 0;

    const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
    const lowestScore = scores.length > 0 ? Math.min(...scores) : 0;

    res.json({
      success: true,
      statistics: {
        totalAttempts,
        uniqueStudents,
        averageScore: Math.round(averageScore * 100) / 100,
        passRate: Math.round(passRate * 100) / 100,
        highestScore,
        lowestScore,
        passedCount,
        failedCount: totalAttempts - passedCount
      },
      attempts: validAttempts
    });
  } catch (error) {
    console.error('Get statistics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Reset student attempts (for instructor)
// @route   DELETE /api/active-tests/:id/attempts/:studentId
// @access  Private (Instructor)
exports.resetStudentAttempts = async (req, res) => {
  try {
    const { id: testId, studentId } = req.params;

    const test = await ActiveTest.findById(testId);

    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    if (test.instructor.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    await TestAttempt.deleteMany({
      test: testId,
      student: studentId
    });

    res.json({
      success: true,
      message: 'Student attempts reset successfully'
    });
  } catch (error) {
    console.error('Reset attempts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
