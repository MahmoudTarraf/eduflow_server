const Section = require('../models/Section');
const Group = require('../models/Group');
const Course = require('../models/Course');
const Content = require('../models/Content');
const StudentProgress = require('../models/StudentProgress');

// @desc    Get all sections for a group
// @route   GET /api/groups/:groupId/sections
// @access  Private
exports.getSectionsByGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    
    const sections = await Section.find({ group: groupId, isActive: true })
      .populate('course', 'name cost currency')
      .populate('group', 'name')
      .populate('createdBy', 'name email')
      .sort({ order: 1, createdAt: 1 });
    
    // Populate content count for each section
    const sectionsWithCounts = await Promise.all(
      sections.map(async (section) => {
        const contentCount = await Content.countDocuments({ section: section._id });
        const lectureCount = await Content.countDocuments({ section: section._id, type: 'lecture' });
        const assignmentCount = await Content.countDocuments({ section: section._id, type: 'assignment' });
        const projectCount = await Content.countDocuments({ section: section._id, type: 'project' });

        const priceCents = section.priceCents || 0;
        const isPaid = section.isPaid || (!section.isFree && priceCents > 0);

        return {
          ...section.toObject({ virtuals: true }),
          isPaid,
          priceCents,
          price: priceCents / 100,
          contentCount,
          lectureCount,
          assignmentCount,
          projectCount
        };
      })
    );
    
    res.status(200).json({
      success: true,
      count: sectionsWithCounts.length,
      data: sectionsWithCounts
    });
  } catch (error) {
    console.error('Error fetching sections:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sections',
      error: error.message
    });
  }
};

// @desc    Create section with price validation
// @route   POST /api/groups/:groupId/sections
// @access  Private (Instructor/Admin)
exports.createSection = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, isFree, price, priceCents, currency, order } = req.body;
    
    // Get group and course
    const group = await Group.findById(groupId)
      .populate('course', 'name instructor cost currency');
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }
    
    const course = group.course;
    
    // Check permissions
    if (req.user.role !== 'admin' && course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to create sections for this course'
      });
    }
    
    // Validate pricing
    let finalPriceCents = 0;
    if (!isFree) {
      finalPriceCents = priceCents !== undefined
        ? Number(priceCents)
        : price !== undefined
          ? Math.round(Number(price) * 100)
          : 0;

      if (!finalPriceCents || Number.isNaN(finalPriceCents) || finalPriceCents <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Price must be provided and greater than 0 for paid sections'
        });
      }
    }
    
    // Calculate existing paid sections total (in cents)
    const existingSections = await Section.find({
      course: course._id,
      isFree: false
    });

    const existingTotalCents = existingSections.reduce((sum, sec) => sum + (sec.priceCents || 0), 0);
    const newTotalCents = existingTotalCents + finalPriceCents;

    const courseTotalCents = Math.round(((course.cost || 0) * 100));

    if (newTotalCents > courseTotalCents) {
      const remainingCents = Math.max(courseTotalCents - existingTotalCents, 0);
      return res.status(400).json({
        success: false,
        message: `Price validation failed. Total of paid sections (${(newTotalCents/100).toFixed(2)} SYR) cannot exceed course total (${(courseTotalCents/100).toFixed(2)} SYR). Current paid sections total: ${(existingTotalCents/100).toFixed(2)} SYR. Remaining budget: ${(remainingCents/100).toFixed(2)} SYR.`
      });
    }
    
    const section = await Section.create({
      name,
      description: description || '',
      group: groupId,
      course: course._id,
      isFree: isFree === true,
      isPaid: !isFree && finalPriceCents > 0,
      priceCents: finalPriceCents,
      currency: currency || course.currency || 'USD',
      order: order || 0,
      createdBy: req.user._id
    });
    
    await section.populate('course', 'name cost currency');
    await section.populate('group', 'name');
    
    res.status(201).json({
      success: true,
      message: 'Section created successfully',
      data: section
    });
  } catch (error) {
    console.error('Error creating section:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create section',
      error: error.message
    });
  }
};

// @desc    Update section
// @route   PUT /api/sections/:sectionId
// @access  Private (Instructor/Admin)
exports.updateSection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { name, description, isFree, price, priceCents, currency, order } = req.body;
    
    const section = await Section.findById(sectionId)
      .populate('course', 'name instructor cost currency');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to edit this section'
      });
    }
    
    // Validate pricing if changing to paid or updating price
    if (isFree !== undefined || price !== undefined || priceCents !== undefined) {
      const newIsFree = isFree !== undefined ? isFree : section.isFree;
      let newPriceCents = 0;

      if (!newIsFree) {
        newPriceCents = priceCents !== undefined
          ? Number(priceCents)
          : price !== undefined
            ? Math.round(Number(price) * 100)
            : section.priceCents;

        if (!newPriceCents || Number.isNaN(newPriceCents) || newPriceCents <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Price must be greater than 0 for paid sections'
          });
        }
      }

      // Calculate total excluding current section (in cents)
      const otherSections = await Section.find({
        course: section.course._id,
        _id: { $ne: sectionId },
        isFree: false
      });

      const otherTotalCents = otherSections.reduce((sum, sec) => sum + (sec.priceCents || 0), 0);
      const newTotalCents = otherTotalCents + newPriceCents;

      const courseTotalCents = Math.round(((section.course.cost || 0) * 100));

      if (newTotalCents > courseTotalCents) {
        return res.status(400).json({
          success: false,
          message: `Price validation failed. Total of paid sections (${(newTotalCents/100).toFixed(2)} SYR) cannot exceed course total (${(courseTotalCents/100).toFixed(2)} SYR). Other sections total: ${(otherTotalCents/100).toFixed(2)} SYR.`
        });
      }
      
      section.isFree = newIsFree;
      section.isPaid = !newIsFree && newPriceCents > 0;
      section.priceCents = newIsFree ? 0 : newPriceCents;
      if (currency !== undefined) {
        section.currency = currency;
      }
    }

    if (name !== undefined) section.name = name;
    if (description !== undefined) section.description = description;
    if (order !== undefined) section.order = order;
    
    await section.save();
    await section.populate('course', 'name cost currency');
    await section.populate('group', 'name');
    
    res.status(200).json({
      success: true,
      message: 'Section updated successfully',
      data: section
    });
  } catch (error) {
    console.error('Error updating section:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update section',
      error: error.message
    });
  }
};

// @desc    Delete section
// @route   DELETE /api/sections/:sectionId
// @access  Private (Instructor/Admin)
exports.deleteSection = async (req, res) => {
  try {
    const { sectionId } = req.params;
    
    const section = await Section.findById(sectionId).populate('course');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }
    
    // Check permissions
    if (req.user.role !== 'admin' && section.course.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this section'
      });
    }
    
    // Delete associated content and files
    const contentItems = await Content.find({ section: sectionId });
    const fs = require('fs').promises;
    const path = require('path');
    
    for (const item of contentItems) {
      if (item.video && item.video.path) {
        try {
          await fs.unlink(path.join(__dirname, '..', item.video.path));
        } catch (err) {
          console.log('File deletion error:', err.message);
        }
      }
      if (item.file && item.file.path) {
        try {
          await fs.unlink(path.join(__dirname, '..', item.file.path));
        } catch (err) {
          console.log('File deletion error:', err.message);
        }
      }
    }
    
    // Delete content records
    await Content.deleteMany({ section: sectionId });
    
    // Delete progress records
    await StudentProgress.deleteMany({ section: sectionId });
    
    // Delete section
    await Section.findByIdAndDelete(sectionId);
    
    res.status(200).json({
      success: true,
      message: 'Section and associated content deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete section',
      error: error.message
    });
  }
};

module.exports = exports;
