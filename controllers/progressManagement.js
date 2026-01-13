const StudentProgress = require('../models/StudentProgress');
const Content = require('../models/Content');
const Section = require('../models/Section');
const Group = require('../models/Group');

// @desc    Mark content as completed
// @route   POST /api/progress/markCompleted
// @access  Private (Student)
exports.markCompleted = async (req, res) => {
  try {
    const { itemId, sectionId, groupId, courseId } = req.body;
    
    const content = await Content.findById(itemId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }
    
    // Find or create progress
    let progress = await StudentProgress.findOne({
      student: req.user._id,
      item: itemId
    });
    
    if (progress) {
      progress.completed = true;
      progress.completedAt = new Date();
      await progress.save();
    } else {
      progress = await StudentProgress.create({
        student: req.user._id,
        course: courseId || content.course,
        group: groupId || content.group,
        section: sectionId || content.section,
        item: itemId,
        content: itemId, // Legacy field
        type: content.type,
        contentType: content.type, // Legacy field
        completed: true,
        completedAt: new Date()
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Content marked as completed',
      data: progress
    });
  } catch (error) {
    console.error('Error marking completed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark as completed',
      error: error.message
    });
  }
};

// @desc    Update video watch progress
// @route   POST /api/progress/updateWatch
// @access  Private (Student)
exports.updateWatchProgress = async (req, res) => {
  try {
    const { itemId, watchTime, lastPosition } = req.body;
    
    const content = await Content.findById(itemId);
    if (!content) {
      return res.status(404).json({
        success: false,
        message: 'Content not found'
      });
    }
    
    let progress = await StudentProgress.findOne({
      student: req.user._id,
      item: itemId
    });
    
    if (progress) {
      progress.watchTime = watchTime;
      progress.lastPosition = lastPosition;
      progress.viewedAt = new Date();
      
      // Auto-complete if watched 90% or more
      if (content.video && content.video.duration) {
        const watchPercentage = (watchTime / content.video.duration) * 100;
        if (watchPercentage >= 90 && !progress.completed) {
          progress.completed = true;
          progress.completedAt = new Date();
        }
      }
      
      await progress.save();
    } else {
      progress = await StudentProgress.create({
        student: req.user._id,
        course: content.course,
        group: content.group,
        section: content.section,
        item: itemId,
        content: itemId,
        type: content.type,
        contentType: content.type,
        watchTime,
        lastPosition,
        viewedAt: new Date()
      });
    }
    
    res.status(200).json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Error updating watch progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update progress',
      error: error.message
    });
  }
};

// @desc    Get student progress for a section
// @route   GET /api/progress/student/:studentId/section/:sectionId
// @access  Private
exports.getStudentProgressForSection = async (req, res) => {
  try {
    const { studentId, sectionId } = req.params;
    
    const progress = await StudentProgress.find({
      student: studentId,
      section: sectionId
    }).populate('item', 'title type');
    
    // Calculate completion percentage
    const totalItems = await Content.countDocuments({ section: sectionId });
    const completedItems = progress.filter(p => p.completed).length;
    const percentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    
    res.status(200).json({
      success: true,
      data: {
        progress,
        totalItems,
        completedItems,
        percentage
      }
    });
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get student progress for a group
// @route   GET /api/progress/student/:studentId/group/:groupId
// @access  Private
exports.getStudentProgressForGroup = async (req, res) => {
  try {
    const { studentId, groupId } = req.params;
    
    const progress = await StudentProgress.find({
      student: studentId,
      group: groupId
    }).populate('item', 'title type')
      .populate('section', 'name');
    
    // Calculate overall percentage
    const totalItems = await Content.countDocuments({ group: groupId });
    const completedItems = progress.filter(p => p.completed).length;
    const percentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    
    res.status(200).json({
      success: true,
      data: {
        progress,
        totalItems,
        completedItems,
        percentage
      }
    });
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch progress',
      error: error.message
    });
  }
};

// @desc    Get all students progress for a group (Instructor/Admin)
// @route   GET /api/groups/:groupId/students/progress
// @access  Private (Instructor/Admin)
exports.getAllStudentsProgress = async (req, res) => {
  try {
    const { groupId } = req.params;
    
    const group = await Group.findById(groupId).populate('students.student', 'name email');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    const totalContent = await Content.countDocuments({ group: groupId });
    
    const studentsWithProgress = await Promise.all(
      group.students
        .filter(studentRecord => studentRecord && studentRecord.student)
        .map(async (studentRecord) => {
          const studentId = studentRecord.student._id;
          
          // Get progress
          const progress = await StudentProgress.find({
            student: studentId,
            group: groupId
          });
          
          const completedCount = progress.filter(p => p.completed).length;
          const percentage = totalContent > 0 ? Math.round((completedCount / totalContent) * 100) : 0;
          
          // Get payments
          const StudentPayment = require('../models/StudentPayment');
          const payments = await StudentPayment.find({
            student: studentId,
            group: groupId,
            status: 'paid',
            verified: true
          });
          
          const totalPaid = payments.reduce((sum, p) => sum + (p.amountSYR || 0), 0);
          
          return {
            student: studentRecord.student,
            enrollmentStatus: studentRecord.status,
            progressPercentage: percentage,
            completedItems: completedCount,
            totalItems: totalContent,
            amountPaidSYR: totalPaid,
            payments
          };
        })
    );
    
    res.status(200).json({
      success: true,
      data: studentsWithProgress
    });
  } catch (error) {
    console.error('Error fetching students progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch students progress',
      error: error.message
    });
  }
};

module.exports = exports;
