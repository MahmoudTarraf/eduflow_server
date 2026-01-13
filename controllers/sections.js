const Section = require('../models/Section');
const Group = require('../models/Group');
const Course = require('../models/Course');
const Content = require('../models/Content');
const SectionPayment = require('../models/SectionPayment');
const Enrollment = require('../models/Enrollment');

// @desc    Get all sections for a group
// @route   GET /api/sections/group/:groupId
// @access  Private
exports.getSectionsByGroup = async (req, res) => {
  try {
    const { groupId } = req.params;

    // Section-level archiving has been removed; all active sections for the group
    // are now returned regardless of previous archive status.
    const sectionQuery = { group: groupId, isActive: true };

    const sections = await Section.find(sectionQuery)
      .populate('createdBy', 'name email')
      .sort('order');

    const isStudentUser = req.user?.role === 'student';
    const isInstructorOrAdmin = req.user?.role === 'instructor' || req.user?.role === 'admin';
    const enrollmentByCourse = new Map();
    const latestPaymentBySection = new Map();

    if (isStudentUser && sections.length > 0) {
      const sectionIds = sections.map((section) => section._id);
      const courseIds = [...new Set(sections.map((section) => {
        if (section.course && section.course._id) {
          return section.course._id.toString();
        }
        return section.course.toString();
      }))];

      const [enrollments, payments] = await Promise.all([
        Enrollment.find({
          student: req.user.id,
          course: { $in: courseIds }
        }).lean(),
        SectionPayment.find({
          student: req.user.id,
          section: { $in: sectionIds }
        }).sort({ submittedAt: -1 }).lean()
      ]);

      enrollments.forEach((enrollment) => {
        enrollmentByCourse.set(enrollment.course.toString(), enrollment);
      });

      payments.forEach((payment) => {
        const sectionKey = payment.section.toString();
        if (!latestPaymentBySection.has(sectionKey)) {
          latestPaymentBySection.set(sectionKey, payment);
        }
      });
    }

    // Get content count for each section
    const sectionsWithCounts = await Promise.all(
      sections.map(async (section) => {
        const contentCounts = await Content.aggregate([
          { $match: { section: section._id } },
          { $group: { _id: '$type', count: { $sum: 1 } } }
        ]);

        const counts = {
          lectures: 0,
          assignments: 0,
          projects: 0
        };

        contentCounts.forEach(({ _id, count }) => {
          counts[_id + 's'] = count;
        });

        const sectionObj = section.toObject({ virtuals: true });

        const priceCents = typeof sectionObj.priceCents === 'number' ? sectionObj.priceCents : 0;
        const currency = sectionObj.currency || 'USD';
        const isPaid = sectionObj.isPaid || (!sectionObj.isFree && priceCents > 0);

        const sectionIdStr = section._id.toString();
        const courseIdStr = section.course && section.course._id
          ? section.course._id.toString()
          : section.course.toString();

        let isUnlockedForCurrentUser = sectionObj.isUnlockedByDefault;
        let paymentStatusForCurrentUser = 'none';
        let latestPayment = null;

        if (isInstructorOrAdmin) {
          isUnlockedForCurrentUser = true;
        } else if (isStudentUser) {
          const enrollment = enrollmentByCourse.get(courseIdStr);
          if (enrollment && enrollment.isSectionEnrolled(section._id)) {
            isUnlockedForCurrentUser = true;
            paymentStatusForCurrentUser = 'approved';
          } else {
            latestPayment = latestPaymentBySection.get(sectionIdStr) || null;
            if (latestPayment) {
              paymentStatusForCurrentUser = latestPayment.status;
              if (latestPayment.status === 'approved') {
                isUnlockedForCurrentUser = true;
              }
            }
          }
        }

        return {
          ...sectionObj,
          isPaid,
          priceCents,
          currency,
          price: priceCents / 100,
          contentCounts: counts,
          isUnlockedForCurrentUser,
          paymentStatusForCurrentUser,
          latestPaymentForCurrentUser: latestPayment ? {
            id: latestPayment._id,
            status: latestPayment.status,
            submittedAt: latestPayment.submittedAt,
            processedAt: latestPayment.processedAt
          } : null
        };
      })
    );

    res.json({
      success: true,
      count: sections.length,
      data: sectionsWithCounts
    });
  } catch (error) {
    console.error('Get sections error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sections',
      error: error.message
    });
  }
};

// @desc    Get single section by ID
// @route   GET /api/sections/:id
// @access  Private
exports.getSectionById = async (req, res) => {
  try {
    const section = await Section.findById(req.params.id)
      .populate('group', 'name')
      .populate('course', 'name')
      .populate('createdBy', 'name email');

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    // Get all content for this section
    const content = await Content.find({ section: section._id })
      .sort('order type')
      .lean();

    res.json({
      success: true,
      data: {
        ...section.toObject(),
        content
      }
    });
  } catch (error) {
    console.error('Get section error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch section',
      error: error.message
    });
  }
};

// @desc    Create new section
// @route   POST /api/sections
// @access  Private (Instructor/Admin)
exports.createSection = async (req, res) => {
  try {
    const { name, description, groupId, courseId, isFree, price, priceCents, currency, order } = req.body;

    // Validate required fields
    if (!name || !groupId || !courseId) {
      return res.status(400).json({
        success: false,
        message: 'Name, group ID, and course ID are required'
      });
    }

    // Verify group exists
    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Verify course exists
    const course = await Course.findById(courseId);
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // If section is paid, validate price doesn't exceed course total
    let normalizedPriceCents = 0;
    if (!isFree) {
      normalizedPriceCents = priceCents !== undefined
        ? Number(priceCents)
        : price !== undefined
          ? Math.round(Number(price) * 100)
          : undefined;

      if (normalizedPriceCents === undefined || Number.isNaN(normalizedPriceCents) || normalizedPriceCents <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Price must be provided and greater than 0 for paid sections'
        });
      }

      const existingSections = await Section.find({ 
        course: courseId, 
        isFree: false,
        isActive: true
      });

      const totalExistingPrice = existingSections.reduce((sum, sec) => sum + (sec.priceCents || 0), 0); // cents
      const newTotal = totalExistingPrice + normalizedPriceCents; // cents

      // Normalize course total to cents
      const courseTotalBase = (course.cost || 0);
      const courseTotalCents = Math.round(Number(courseTotalBase) * 100);

      if (courseTotalCents > 0 && newTotal > courseTotalCents) {
        const available = Math.max(courseTotalCents - totalExistingPrice, 0);
        return res.status(400).json({
          success: false,
          message: `Section price would exceed course total. Course total: ${(courseTotalCents/100).toFixed(2)}, Already allocated: ${(totalExistingPrice/100).toFixed(2)}, Available: ${(available/100).toFixed(2)}`
        });
      }
    }

    // Create section
    const section = await Section.create({
      name,
      description: description || '',
      group: groupId,
      course: courseId,
      isFree: isFree !== undefined ? isFree : false,
      isPaid: !isFree,
      priceCents: isFree ? 0 : normalizedPriceCents,
      currency: currency || 'USD',
      order: order || 0,
      createdBy: req.user.id
    });

    await section.populate('createdBy', 'name email');

    res.status(201).json({
      success: true,
      message: 'Section created successfully',
      data: section
    });
  } catch (error) {
    console.error('Create section error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create section',
      error: error.message
    });
  }
};

// @desc    Update section
// @route   PUT /api/sections/:id
// @access  Private (Instructor/Admin)
exports.updateSection = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isFree, price, priceCents, currency, order, isActive } = req.body;

    const section = await Section.findById(id);
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    // If changing price, validate against course total
    let incomingPriceCents;
    if (!section.isFree || isFree === false || price !== undefined || priceCents !== undefined) {
      incomingPriceCents = priceCents !== undefined
        ? Number(priceCents)
        : price !== undefined
          ? Math.round(Number(price) * 100)
          : section.priceCents;

      if ((isFree === false || !section.isFree) && (incomingPriceCents === undefined || Number.isNaN(incomingPriceCents) || incomingPriceCents <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'Price must be greater than 0 for paid sections'
        });
      }

      if (incomingPriceCents !== undefined && incomingPriceCents !== section.priceCents) {
        const course = await Course.findById(section.course);
        const existingSections = await Section.find({ 
          course: section.course, 
          isFree: false,
          isActive: true,
          _id: { $ne: id } // Exclude current section
        });

        const totalExistingPrice = existingSections.reduce((sum, sec) => sum + (sec.priceCents || 0), 0); // cents
        const newTotal = totalExistingPrice + incomingPriceCents; // cents

        const courseTotalBase = (course.cost || 0);
        const courseTotalCents = Math.round(Number(courseTotalBase) * 100);

        if (courseTotalCents > 0 && newTotal > courseTotalCents) {
          const available = Math.max(courseTotalCents - totalExistingPrice, 0);
          return res.status(400).json({
            success: false,
            message: `Section price would exceed course total. Available: ${(available/100).toFixed(2)}`
          });
        }
      }
    }

    // Update fields
    if (name !== undefined) section.name = name;
    if (description !== undefined) section.description = description;
    if (isFree !== undefined) {
      section.isFree = isFree;
      if (isFree) {
        section.isPaid = false;
        section.priceCents = 0;
      }
    }
    if (!section.isFree && incomingPriceCents !== undefined) {
      section.isPaid = incomingPriceCents > 0;
      section.priceCents = incomingPriceCents;
    }
    if (currency !== undefined) {
      section.currency = currency;
    }
    if (order !== undefined) section.order = order;
    if (isActive !== undefined) section.isActive = isActive;

    await section.save();
    await section.populate('createdBy', 'name email');

    res.json({
      success: true,
      message: 'Section updated successfully',
      data: section
    });
  } catch (error) {
    console.error('Update section error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update section',
      error: error.message
    });
  }
};

// @desc    Delete section
// @route   DELETE /api/sections/:id
// @access  Private (Admin)
exports.deleteSection = async (req, res) => {
  try {
    const { id } = req.params;

    const section = await Section.findById(id);
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    // Check if section has content
    const contentCount = await Content.countDocuments({ section: id });
    if (contentCount > 0) {
      // Soft delete
      section.isActive = false;
      await section.save();

      // Remove section from parent Group and Course
      await Group.updateOne(
        { _id: section.group },
        { $pull: { sections: id } }
      );

      await Course.updateOne(
        { _id: section.course },
        { $pull: { sections: id } }
      );

      return res.json({
        success: true,
        message: 'Section deactivated (has content)'
      });
    }

    // Hard delete if no content
    await Section.findByIdAndDelete(id);

    // Remove section from parent Group and Course
    await Group.updateOne(
      { _id: section.group },
      { $pull: { sections: id } }
    );

    await Course.updateOne(
      { _id: section.course },
      { $pull: { sections: id } }
    );

    res.json({
      success: true,
      message: 'Section deleted successfully'
    });
  } catch (error) {
    console.error('Delete section error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete section',
      error: error.message
    });
  }
};

// @desc    Get section access for student
// @route   GET /api/sections/:id/access
// @access  Private (Student)
exports.checkSectionAccess = async (req, res) => {
  try {
    const { id } = req.params;
    const studentId = req.user.id;

    const section = await Section.findById(id).populate('course', 'currency instructor');
    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Section not found'
      });
    }

    const priceCents = typeof section.priceCents === 'number' ? section.priceCents : 0;
    const currency = section.currency || section.course?.currency || 'USD';

    // Free sections are always accessible
    if (section.isFree || priceCents === 0) {
      return res.json({
        success: true,
        hasAccess: true,
        reason: 'free',
        priceCents,
        price: priceCents / 100,
        currency
      });
    }

    // Check enrollment record
    const enrollment = await Enrollment.findOne({
      student: studentId,
      course: section.course._id
    });

    if (enrollment && enrollment.isSectionEnrolled(section._id)) {
      return res.json({
        success: true,
        hasAccess: true,
        reason: 'paid',
        priceCents,
        price: priceCents / 100,
        currency
      });
    }

    // Check latest section payment
    const latestPayment = await SectionPayment.findOne({
      student: studentId,
      section: section._id
    }).sort({ submittedAt: -1 }).lean();

    if (latestPayment) {
      if (latestPayment.status === 'approved') {
        return res.json({
          success: true,
          hasAccess: true,
          reason: 'paid',
          priceCents,
          price: priceCents / 100,
          currency,
          latestPayment: {
            id: latestPayment._id,
            status: latestPayment.status,
            submittedAt: latestPayment.submittedAt,
            processedAt: latestPayment.processedAt
          }
        });
      }

      return res.json({
        success: true,
        hasAccess: false,
        reason: latestPayment.status === 'pending' ? 'payment_pending' : 'payment_required',
        priceCents,
        price: priceCents / 100,
        currency,
        latestPayment: {
          id: latestPayment._id,
          status: latestPayment.status,
          submittedAt: latestPayment.submittedAt,
          processedAt: latestPayment.processedAt,
          rejectionReason: latestPayment.rejectionReason || null
        }
      });
    }

    return res.json({
      success: true,
      hasAccess: false,
      reason: enrollment ? 'payment_required' : 'not_enrolled',
      priceCents,
      price: priceCents / 100,
      currency
    });
  } catch (error) {
    console.error('Check section access error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check section access',
      error: error.message
    });
  }
};
