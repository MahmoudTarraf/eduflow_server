const Category = require('../models/Category');
const cache = require('../utils/cache');

// @desc    Get all categories
// @route   GET /api/categories
// @access  Public
exports.getCategories = async (req, res) => {
  try {
    const cacheKey = 'categories_public_v1';
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        count: cached.length,
        categories: cached
      });
    }

    let categories = await Category.find({ isActive: true })
      .select('name slug description icon')
      .sort({ name: 1 })
      .lean();

    // If no categories exist, create default ones
    if (categories.length === 0) {
      console.log('No categories found, creating defaults...');
      const User = require('../models/User');
      const admin = await User.findOne({ role: 'admin' });
      
      if (admin) {
        // Use create() instead of insertMany() to trigger pre-save hooks for slug generation
        const programmingCat = await Category.create({
          name: 'Programming',
          description: 'Programming and software development courses',
          icon: 'code',
          createdBy: admin._id
        });
        
        const languagesCat = await Category.create({
          name: 'Languages',
          description: 'Language learning and linguistics courses',
          icon: 'language',
          createdBy: admin._id
        });
        
        categories = [programmingCat, languagesCat];
        console.log('Default categories created successfully');
      }
    }

    // Cache for 10 minutes
    cache.set(cacheKey, categories, 10 * 60 * 1000);

    res.json({
      success: true,
      count: categories.length,
      categories
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Public
exports.getCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id).lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      category
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Create category
// @route   POST /api/categories
// @access  Private (Admin)
exports.createCategory = async (req, res) => {
  try {
    const { name, description, icon } = req.body;

    // Check if category already exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });

    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category already exists'
      });
    }

    const category = await Category.create({
      name,
      description,
      icon,
      createdBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
};

// @desc    Get category statistics with courses and instructors
// @route   GET /api/categories/:id/stats
// @access  Private (Admin)
exports.getCategoryStats = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const Course = require('../models/Course');
    const courses = await Course.find({ category: category.slug })
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
      category,
      stats: {
        totalCourses: courses.length,
        totalInstructors: instructorIds.size,
        courses: courses
      }
    });
  } catch (error) {
    console.error('Get category stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private (Admin)
exports.updateCategory = async (req, res) => {
  try {
    const { name, description, icon, isActive } = req.body;

    let category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const oldSlug = category.slug;

    // Check if new name conflicts with existing category
    if (name && name !== category.name) {
      const existingCategory = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: req.params.id }
      });

      if (existingCategory) {
        return res.status(400).json({
          success: false,
          message: 'Category name already exists'
        });
      }
    }

    category.name = name || category.name;
    category.description = description !== undefined ? description : category.description;
    category.icon = icon !== undefined ? icon : category.icon;
    category.isActive = isActive !== undefined ? isActive : category.isActive;

    await category.save();

    // If slug changed, update all courses using this category
    if (oldSlug !== category.slug) {
      const Course = require('../models/Course');
      await Course.updateMany(
        { category: oldSlug },
        { $set: { category: category.slug } }
      );
    }

    res.json({
      success: true,
      message: 'Category updated successfully',
      category
    });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete category with course reassignment
// @route   DELETE /api/categories/:id
// @access  Private (Admin)
exports.deleteCategory = async (req, res) => {
  try {
    const { replacementCategoryId } = req.body;
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if any courses use this category
    const Course = require('../models/Course');
    const coursesUsingCategory = await Course.countDocuments({ category: category.slug });

    if (coursesUsingCategory > 0) {
      // Replacement category is required
      if (!replacementCategoryId) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete category. ${coursesUsingCategory} course(s) are using this category. Please provide a replacement category.`,
          requiresReplacement: true,
          affectedCourses: coursesUsingCategory
        });
      }

      // Verify replacement category exists
      const replacementCategory = await Category.findById(replacementCategoryId);
      if (!replacementCategory) {
        return res.status(400).json({
          success: false,
          message: 'Replacement category not found'
        });
      }

      // Don't allow replacing with the same category
      if (replacementCategoryId === req.params.id) {
        return res.status(400).json({
          success: false,
          message: 'Cannot replace category with itself'
        });
      }

      // Reassign all courses to the replacement category
      await Course.updateMany(
        { category: category.slug },
        { $set: { category: replacementCategory.slug } }
      );
    }

    await category.deleteOne();

    res.json({
      success: true,
      message: coursesUsingCategory > 0 
        ? `Category deleted and ${coursesUsingCategory} course(s) reassigned successfully`
        : 'Category deleted successfully',
      reassignedCourses: coursesUsingCategory
    });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Get all categories with course counts (Admin view)
// @route   GET /api/categories/admin/all
// @access  Private (Admin)
exports.getAllCategoriesAdmin = async (req, res) => {
  try {
    const categories = await Category.find()
      .populate('createdBy', 'name email')
      .sort({ name: 1 })
      .lean();

    const Course = require('../models/Course');
    
    // Get course counts for each category
    const categoriesWithCounts = await Promise.all(
      categories.map(async (category) => {
        const courses = await Course.find({ category: category.slug })
          .populate('instructor', 'name email')
          .lean();
        
        // Get unique instructors
        const instructorIds = new Set();
        courses.forEach(course => {
          if (course.instructor) {
            instructorIds.add(course.instructor._id.toString());
          }
        });

        return {
          ...category,
          courseCount: courses.length,
          instructorCount: instructorIds.size
        };
      })
    );

    res.json({
      success: true,
      count: categoriesWithCounts.length,
      categories: categoriesWithCounts
    });
  } catch (error) {
    console.error('Get all categories admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};
