const StudentProgress = require('../models/StudentProgress');
const Content = require('../models/Content');
const Section = require('../models/Section');
const Group = require('../models/Group');

// @desc    Get student progress for a section
// @route   GET /api/progress/section/:sectionId
// @access  Private (Student)
exports.getProgressBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const studentId = req.user.id;

    const progress = await StudentProgress.find({
      student: studentId,
      section: sectionId
    }).populate('content', 'title type order');

    // Get all content for the section
    const allContent = await Content.find({ section: sectionId, isPublished: true });

    // Calculate completion stats
    const totalItems = allContent.length;
    const completedItems = progress.filter(p => p.completed).length;
    const completionPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    res.json({
      success: true,
      data: {
        progress,
        stats: {
          total: totalItems,
          completed: completedItems,
          percentage: completionPercentage
        }
      }
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get student progress for a group
// @route   GET /api/progress/group/:groupId
// @access  Private (Student)
exports.getProgressByGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const studentId = req.user.id;

    const progress = await StudentProgress.find({
      student: studentId,
      group: groupId
    })
      .populate('content', 'title type order')
      .populate('section', 'name');

    // Get all sections and content for the group
    const sections = await Section.find({ group: groupId, isActive: true });
    const allContent = await Content.find({ 
      group: groupId, 
      isPublished: true 
    });

    // Calculate stats by section
    const sectionStats = await Promise.all(
      sections.map(async (section) => {
        const sectionContent = allContent.filter(
          c => c.section.toString() === section._id.toString()
        );
        const sectionProgress = progress.filter(
          p => p.section.toString() === section._id.toString()
        );
        const completed = sectionProgress.filter(p => p.completed).length;
        const total = sectionContent.length;

        return {
          section: {
            _id: section._id,
            name: section.name,
            isFree: section.isFree,
            priceSYR: section.priceSYR
          },
          total,
          completed,
          percentage: total > 0 ? Math.round((completed / total) * 100) : 0
        };
      })
    );

    // Overall stats
    const totalItems = allContent.length;
    const completedItems = progress.filter(p => p.completed).length;
    const completionPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    res.json({
      success: true,
      data: {
        progress,
        sectionStats,
        overallStats: {
          total: totalItems,
          completed: completedItems,
          percentage: completionPercentage
        }
      }
    });
  } catch (error) {
    console.error('Get group progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get all students' progress for a section (Instructor view)
// @route   GET /api/progress/section/:sectionId/all
// @access  Private (Instructor/Admin)
exports.getAllStudentsProgressBySection = async (req, res) => {
  try {
    const { sectionId } = req.params;

    const section = await Section.findById(sectionId).populate('group');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    // Get all enrolled students from the group
    const group = await Group.findById(section.group).populate('students.student', 'name email');
    const enrolledStudents = group.students.filter(s => s.status === 'enrolled');

    // Get all content for the section
    const content = await Content.find({ section: sectionId, isPublished: true });

    // Get progress for all students
    const studentsProgress = await Promise.all(
      enrolledStudents.map(async (enrollment) => {
        const studentId = enrollment.student._id;
        const progress = await StudentProgress.find({
          student: studentId,
          section: sectionId
        }).populate('content', 'title type');

        const completed = progress.filter(p => p.completed).length;
        const total = content.length;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

        return {
          student: {
            _id: studentId,
            name: enrollment.student.name,
            email: enrollment.student.email
          },
          progress,
          stats: {
            total,
            completed,
            percentage
          }
        };
      })
    );

    res.json({
      success: true,
      data: {
        section: {
          _id: section._id,
          name: section.name
        },
        studentsProgress
      }
    });
  } catch (error) {
    console.error('Get all students progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get all students' progress for a group (Instructor view)
// @route   GET /api/progress/group/:groupId/all
// @access  Private (Instructor/Admin)
exports.getAllStudentsProgressByGroup = async (req, res) => {
  try {
    const { groupId } = req.params;

    const group = await Group.findById(groupId).populate('students.student', 'name email');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const enrolledStudents = group.students.filter(s => s.status === 'enrolled');

    // Get all sections and content
    const sections = await Section.find({ group: groupId, isActive: true });
    const allContent = await Content.find({ group: groupId, isPublished: true });

    // Get progress for all students
    const studentsProgress = await Promise.all(
      enrolledStudents.map(async (enrollment) => {
        const studentId = enrollment.student._id;
        const progress = await StudentProgress.find({
          student: studentId,
          group: groupId
        })
          .populate('content', 'title type')
          .populate('section', 'name');

        const completed = progress.filter(p => p.completed).length;
        const total = allContent.length;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

        // Progress by section
        const sectionProgress = sections.map(section => {
          const sectionContent = allContent.filter(
            c => c.section.toString() === section._id.toString()
          );
          const sectionProg = progress.filter(
            p => p.section.toString() === section._id.toString()
          );
          const sectionCompleted = sectionProg.filter(p => p.completed).length;
          const sectionTotal = sectionContent.length;

          return {
            section: {
              _id: section._id,
              name: section.name
            },
            total: sectionTotal,
            completed: sectionCompleted,
            percentage: sectionTotal > 0 ? Math.round((sectionCompleted / sectionTotal) * 100) : 0
          };
        });

        return {
          student: {
            _id: studentId,
            name: enrollment.student.name,
            email: enrollment.student.email
          },
          overallStats: {
            total,
            completed,
            percentage
          },
          sectionProgress
        };
      })
    );

    res.json({
      success: true,
      data: {
        group: {
          _id: group._id,
          name: group.name
        },
        studentsProgress
      }
    });
  } catch (error) {
    console.error('Get all students group progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get detailed progress for a specific student
// @route   GET /api/progress/student/:studentId/group/:groupId
// @access  Private (Instructor/Admin)
exports.getStudentDetailedProgress = async (req, res) => {
  try {
    const { studentId, groupId } = req.params;

    const progress = await StudentProgress.find({
      student: studentId,
      group: groupId
    })
      .populate('content', 'title type order maxScore')
      .populate('section', 'name')
      .sort('section order');

    if (progress.length === 0) {
      return res.json({
        success: true,
        message: 'No progress found',
        data: []
      });
    }

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Get student detailed progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};
