const Group = require('../models/Group');
const Course = require('../models/Course');
const Section = require('../models/Section');
const Content = require('../models/Content');
const StudentProgress = require('../models/StudentProgress');
const fs = require('fs').promises;
const path = require('path');

// @desc    Get all groups for a course
// @route   GET /api/courses/:courseId/groups
// @access  Private (All authenticated users)
exports.getGroupsByCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userRole = req.user.role;

    // Different queries based on user role
    if (userRole === 'student') {
      const groups = await Group.find({
        course: courseId,
        $or: [
          { isArchived: { $ne: true } },
          { 'students.student': req.user.id }
        ]
      })
        .populate('instructor', 'name')
        .populate('course', 'name cost currency')
        .select('name description level startDate endDate maxStudents currentStudents schedule isArchived')
        .sort({ startDate: 1 });

      return res.status(200).json({
        success: true,
        count: groups.length,
        data: groups
      });
    } else {
      // Instructors/Admins see full details including archived groups and student list
      const groups = await Group.find({ course: courseId })
        .populate('instructor', 'name email')
        .populate('course', 'name cost currency')
        .populate('students.student', 'name email')
        .sort({ createdAt: -1 });

      return res.status(200).json({
        success: true,
        count: groups.length,
        groups
      });
    }
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch groups',
      error: error.message
    });
  }
};

// @desc    Create new group
// @route   POST /api/courses/:courseId/groups
// @access  Private (Instructor/Admin)
exports.createGroup = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { name, startDate, endDate, capacity, description, level } = req.body;
    
    // Verify course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to create groups for this course'
      });
    }
    
    const group = await Group.create({
      name,
      course: courseId,
      startDate,
      endDate,
      capacity: capacity || 30,
      maxStudents: capacity || 30,
      description: description || '',
      level: level || course.level,
      instructor: course.instructor,
      createdBy: req.user._id
    });
    
    // Add group to course
    await Course.findByIdAndUpdate(courseId, {
      $push: { groups: group._id }
    });
    
    await group.populate('instructor', 'name email');
    
    res.status(201).json({
      success: true,
      message: 'Group created successfully',
      group
    });
  } catch (error) {
    console.error('Error creating group:', error);

    if (error.name === 'ValidationError') {
      const validationErrors = Object.keys(error.errors || {}).map((key) => ({
        field: key,
        message: error.errors[key].message
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create group',
      error: error.message
    });
  }
};

// @desc    Update group
// @route   PUT /api/groups/:groupId
// @access  Private (Instructor/Admin)
exports.updateGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const updates = req.body;
    
    const group = await Group.findById(groupId).populate('course');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && group.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to edit this group'
      });
    }
    
    const allowedUpdates = ['name', 'startDate', 'endDate', 'capacity', 'description', 'level', 'maxStudents'];
    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        group[key] = updates[key];
      }
    });
    
    await group.save();
    
    res.status(200).json({
      success: true,
      message: 'Group updated successfully',
      group
    });
  } catch (error) {
    console.error('Error updating group:', error);

    if (error.name === 'ValidationError') {
      const validationErrors = Object.keys(error.errors || {}).map((key) => ({
        field: key,
        message: error.errors[key].message
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update group',
      error: error.message
    });
  }
};

// @desc    Archive or unarchive group
// @route   PATCH /api/groups/:groupId/archive
// @access  Private (Instructor/Admin)
exports.archiveGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { archive, reason } = req.body || {};

    const group = await Group.findById(groupId).populate('course', 'instructor');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const userId = req.user._id || req.user.id;

    // Only admin or the course/group instructor can archive
    const courseInstructorId = group.course?.instructor?.toString();
    if (
      req.user.role !== 'admin' &&
      group.instructor.toString() !== String(userId) &&
      (!courseInstructorId || courseInstructorId !== String(userId))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to modify this group'
      });
    }

    const shouldArchive = archive === undefined ? true : Boolean(archive);

    if (shouldArchive) {
      if (group.isArchived) {
        return res.json({
          success: true,
          group,
          message: 'Group is already archived'
        });
      }

      group.isArchived = true;
      group.archivedAt = new Date();
      group.archivedBy = userId;
      if (reason) {
        group.archivedReason = reason;
      }
    } else {
      if (!group.isArchived) {
        return res.json({
          success: true,
          group,
          message: 'Group is already active'
        });
      }

      group.isArchived = false;
      group.archivedAt = null;
      // Keep archivedBy/archivedReason for audit history
    }

    await group.save();

    return res.json({
      success: true,
      group,
      message: shouldArchive
        ? 'Group archived successfully. It will be hidden from new enrollments, but existing students keep access.'
        : 'Group unarchived successfully.'
    });
  } catch (error) {
    console.error('Error archiving group:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update group archive status',
      error: error.message
    });
  }
};

// @desc    Delete group (cascade delete sections and content)
// @route   DELETE /api/groups/:groupId
// @access  Private (Instructor/Admin)
exports.deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    
    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && group.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this group'
      });
    }

    // Instructors cannot delete groups that have enrolled students
    if (req.user.role !== 'admin') {
      const hasStudents = (group.students || []).some(s => s.status === 'enrolled');
      if (hasStudents) {
        return res.status(400).json({
          success: false,
          message: 'This group has enrolled students and cannot be deleted. You can set the group as inactive instead.'
        });
      }
    }
    
    // Find all sections in this group
    const sections = await Section.find({ group: groupId });
    
    // Delete all content files and records
    for (const section of sections) {
      const contentItems = await Content.find({ section: section._id });
      
      for (const item of contentItems) {
        // Delete physical files
        if (item.video && item.video.path) {
          try {
            await fs.unlink(path.join(__dirname, '..', item.video.path));
          } catch (err) {
            console.log('File already deleted or not found:', item.video.path);
          }
        }
        if (item.file && item.file.path) {
          try {
            await fs.unlink(path.join(__dirname, '..', item.file.path));
          } catch (err) {
            console.log('File already deleted or not found:', item.file.path);
          }
        }
        
        // Delete legacy paths
        if (item.videoPath) {
          try {
            await fs.unlink(path.join(__dirname, '..', 'uploads', 'videos', item.videoPath));
          } catch (err) {}
        }
        if (item.filePath) {
          try {
            await fs.unlink(path.join(__dirname, '..', 'uploads', 'files', item.filePath));
          } catch (err) {}
        }
      }
      
      // Delete content records
      await Content.deleteMany({ section: section._id });
      
      // Delete progress records
      await StudentProgress.deleteMany({ section: section._id });
    }
    
    // Delete sections
    await Section.deleteMany({ group: groupId });
    
    // Remove group from course
    await Course.findByIdAndUpdate(group.course, {
      $pull: { groups: groupId }
    });
    
    // Delete group
    await Group.findByIdAndDelete(groupId);
    
    // Audit log (optional - can extend)
    console.log(`Group deleted by ${req.user.email} at ${new Date()}: ${group.name} (ID: ${groupId})`);
    
    res.status(200).json({
      success: true,
      message: 'Group and all associated data deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete group',
      error: error.message
    });
  }
};

module.exports = exports;
