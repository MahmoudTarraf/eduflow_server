const Level = require('../models/Level');

// @desc    Get all levels
// @route   GET /api/levels
// @access  Public
exports.getLevels = async (req, res) => {
  try {
    let levels = await Level.find({ isActive: true })
      .select('name slug description order')
      .sort({ order: 1, name: 1 });

    // If no levels exist, create default ones
    if (levels.length === 0) {
      console.log('No levels found, creating defaults...');
      const User = require('../models/User');
      const admin = await User.findOne({ role: 'admin' });
      
      if (admin) {
        const beginnerLevel = await Level.create({
          name: 'Beginner',
          description: 'Suitable for those starting out with no prior experience',
          order: 1,
          createdBy: admin._id
        });
        
        const intermediateLevel = await Level.create({
          name: 'Intermediate',
          description: 'For learners with some foundational knowledge',
          order: 2,
          createdBy: admin._id
        });
        
        const advancedLevel = await Level.create({
          name: 'Advanced',
          description: 'Designed for experienced learners seeking mastery',
          order: 3,
          createdBy: admin._id
        });
        
        levels = [beginnerLevel, intermediateLevel, advancedLevel];
        console.log('Default levels created successfully');
      }
    }

    res.json({
      success: true,
      count: levels.length,
      levels
    });
  } catch (error) {
    console.error('Get levels error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single level
// @route   GET /api/levels/:id
// @access  Public
exports.getLevel = async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);

    if (!level) {
      return res.status(404).json({
        success: false,
        message: 'Level not found'
      });
    }

    res.json({
      success: true,
      level
    });
  } catch (error) {
    console.error('Get level error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Create level
// @route   POST /api/levels
// @access  Private (Admin, Instructor)
exports.createLevel = async (req, res) => {
  try {
    const { name, description, order } = req.body;

    // Check if level already exists
    const existingLevel = await Level.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });

    if (existingLevel) {
      return res.status(400).json({
        success: false,
        message: 'Level already exists'
      });
    }

    const level = await Level.create({
      name,
      description,
      order: order || 0,
      createdBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Level created successfully',
      level
    });
  } catch (error) {
    console.error('Create level error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
};

// @desc    Get level statistics with courses and instructors
// @route   GET /api/levels/:id/stats
// @access  Private (Admin)
exports.getLevelStats = async (req, res) => {
  try {
    const level = await Level.findById(req.params.id);

    if (!level) {
      return res.status(404).json({
        success: false,
        message: 'Level not found'
      });
    }

    const Course = require('../models/Course');
    const courses = await Course.find({ level: level.slug })
      .populate('instructor', 'name email avatar')
      .select('name instructor status');

    // Get unique instructors
    const instructorIds = new Set();
    courses.forEach(course => {
      if (course.instructor) {
        instructorIds.add(course.instructor._id.toString());
      }
    });

    res.json({
      success: true,
      level,
      stats: {
        totalCourses: courses.length,
        totalInstructors: instructorIds.size,
        courses: courses
      }
    });
  } catch (error) {
    console.error('Get level stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update level
// @route   PUT /api/levels/:id
// @access  Private (Admin)
exports.updateLevel = async (req, res) => {
  try {
    const { name, description, order, isActive } = req.body;

    let level = await Level.findById(req.params.id);

    if (!level) {
      return res.status(404).json({
        success: false,
        message: 'Level not found'
      });
    }

    const oldSlug = level.slug;

    // Check if new name conflicts with existing level
    if (name && name !== level.name) {
      const existingLevel = await Level.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: req.params.id }
      });

      if (existingLevel) {
        return res.status(400).json({
          success: false,
          message: 'Level name already exists'
        });
      }
    }

    level.name = name || level.name;
    level.description = description !== undefined ? description : level.description;
    level.order = order !== undefined ? order : level.order;
    level.isActive = isActive !== undefined ? isActive : level.isActive;

    await level.save();

    // If slug changed, update all courses using this level
    if (oldSlug !== level.slug) {
      const Course = require('../models/Course');
      await Course.updateMany(
        { level: oldSlug },
        { $set: { level: level.slug } }
      );
    }

    res.json({
      success: true,
      message: 'Level updated successfully',
      level
    });
  } catch (error) {
    console.error('Update level error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete level with course reassignment
// @route   DELETE /api/levels/:id
// @access  Private (Admin)
exports.deleteLevel = async (req, res) => {
  try {
    const { replacementLevelId, newLevelName } = req.body;
    const level = await Level.findById(req.params.id);

    if (!level) {
      return res.status(404).json({
        success: false,
        message: 'Level not found'
      });
    }

    // Check if any courses use this level
    const Course = require('../models/Course');
    const coursesUsingLevel = await Course.countDocuments({ level: level.slug });

    if (coursesUsingLevel > 0) {
      // Replacement level or new level name is required
      if (!replacementLevelId && !newLevelName) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete level. ${coursesUsingLevel} course(s) are using this level. Please provide a replacement level or create a new one.`,
          requiresReplacement: true,
          affectedCourses: coursesUsingLevel
        });
      }

      let targetLevelSlug;

      if (newLevelName) {
        // Create new level
        const newLevel = await Level.create({
          name: newLevelName,
          description: `Automatically created as replacement for ${level.name}`,
          order: level.order,
          createdBy: req.user.id
        });
        targetLevelSlug = newLevel.slug;
      } else {
        // Use existing replacement level
        const replacementLevel = await Level.findById(replacementLevelId);
        if (!replacementLevel) {
          return res.status(400).json({
            success: false,
            message: 'Replacement level not found'
          });
        }

        // Don't allow replacing with the same level
        if (replacementLevelId === req.params.id) {
          return res.status(400).json({
            success: false,
            message: 'Cannot replace level with itself'
          });
        }

        targetLevelSlug = replacementLevel.slug;
      }

      // Reassign all courses to the target level
      await Course.updateMany(
        { level: level.slug },
        { $set: { level: targetLevelSlug } }
      );
    }

    await level.deleteOne();

    res.json({
      success: true,
      message: coursesUsingLevel > 0 
        ? `Level deleted and ${coursesUsingLevel} course(s) reassigned successfully`
        : 'Level deleted successfully',
      reassignedCourses: coursesUsingLevel
    });
  } catch (error) {
    console.error('Delete level error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all levels with course counts (Admin view)
// @route   GET /api/levels/admin/all
// @access  Private (Admin)
exports.getAllLevelsAdmin = async (req, res) => {
  try {
    const levels = await Level.find()
      .populate('createdBy', 'name email')
      .sort({ order: 1, name: 1 });

    const Course = require('../models/Course');
    
    // Get course counts for each level
    const levelsWithCounts = await Promise.all(
      levels.map(async (level) => {
        const courses = await Course.find({ level: level.slug })
          .populate('instructor', 'name email');
        
        // Get unique instructors
        const instructorIds = new Set();
        courses.forEach(course => {
          if (course.instructor) {
            instructorIds.add(course.instructor._id.toString());
          }
        });

        return {
          ...level.toObject(),
          courseCount: courses.length,
          instructorCount: instructorIds.size
        };
      })
    );

    res.json({
      success: true,
      count: levelsWithCounts.length,
      levels: levelsWithCounts
    });
  } catch (error) {
    console.error('Get all levels admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
