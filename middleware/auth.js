const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes
exports.protect = async (req, res, next) => {
  let token;

  // SECURITY: Only accept JWT via Authorization header (Bearer). Query params are forbidden.
  // Reason: tokens in URLs leak via logs/referrers/caches and weaken header-based controls.
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // Limited exception for safe GET content stream/download routes where headers cannot be set by <video>/<a>
  const isSafeContentGet = req.method === 'GET' && (
    (req.path && req.path.includes('/content/') && (req.path.includes('/stream') || req.path.includes('/download'))) ||
    (req.originalUrl && req.originalUrl.includes('/content/') && (req.originalUrl.includes('/stream') || req.originalUrl.includes('/download')))
  );

  if (!token && isSafeContentGet && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }

  try {
    // Verify token using the same secret strategy as generateToken
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);

    if (!secret) {
      return res.status(500).json({
        success: false,
        message: 'Server configuration error. Please contact the administrator.'
      });
    }

    const decoded = jwt.verify(token, secret);

    req.user = await User.findById(decoded.id).select('-password');
    
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'No user found with this token'
      });
    }

    // Block access for soft-deleted accounts
    if (req.user.isDeleted || req.user.status === 'deleted') {
      return res.status(403).json({
        success: false,
        message: 'Account has been deleted. Please contact support if you believe this is an error.',
        isDeleted: true,
        status: 'deleted'
      });
    }

    // Check if user is banned (should not reach here but double-check)
    if (req.user.status === 'banned' || req.user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Account banned. Please contact support.',
        isBanned: true,
        status: 'banned'
      });
    }

    // Suspended users can login and view, but cannot perform actions
    // This check is done in checkSuspension middleware applied to write operations
    
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }
};

exports.optionalProtect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next();
  }

  try {
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
    if (!secret) {
      return next();
    }

    const decoded = jwt.verify(token, secret);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return next();
    }

    // Soft-deleted accounts should not appear as authenticated
    if (user.isDeleted || user.status === 'deleted') {
      return next();
    }

    if (user.status === 'banned' || user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'Account banned. Please contact support.',
        isBanned: true,
        status: 'banned'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return next();
  }
};

exports.protectAllowQuery = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  const isSafeContentGet = req.method === 'GET' && (
    (req.path && req.path.includes('/content/') && (req.path.includes('/stream') || req.path.includes('/download'))) ||
    (req.originalUrl && req.originalUrl.includes('/content/') && (req.originalUrl.includes('/stream') || req.originalUrl.includes('/download')))
  );

  if (!token && isSafeContentGet && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }

  try {
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
    if (!secret) {
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }
    const decoded = require('jsonwebtoken').verify(token, secret);
    req.user = await require('../models/User').findById(decoded.id).select('-password');
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'No user found with this token' });
    }
    if (req.user.isDeleted || req.user.status === 'deleted') {
      return res.status(403).json({ success: false, message: 'Account has been deleted. Please contact support if you believe this is an error.', isDeleted: true, status: 'deleted' });
    }
    if (req.user.status === 'banned' || req.user.isBanned) {
      return res.status(403).json({ success: false, message: 'Account banned. Please contact support.', isBanned: true, status: 'banned' });
    }
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }
};

// Grant access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    console.log('Authorization check:', {
      userRole: req.user?.role,
      allowedRoles: roles,
      userId: req.user?.id
    });
    
    if (!req.user || !req.user.role) {
      return res.status(403).json({
        success: false,
        message: 'User role not found. Please login again.'
      });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role '${req.user.role}' is not authorized to access this route. Required: ${roles.join(', ')}`
      });
    }
    next();
  };
};

// Require approved instructor for certain actions
exports.requireApprovedInstructor = (req, res, next) => {
  if (req.user.role === 'instructor' && req.user.instructorStatus !== 'approved') {
    return res.status(403).json({
      success: false,
      message: 'Instructor account is pending approval'
    });
  }
  next();
};

// Check if user is suspended or banned
exports.checkSuspension = (req, res, next) => {
  if (req.user.status === 'suspended') {
    return res.status(403).json({
      success: false,
      message: 'Your account is suspended. Please contact support.'
    });
  }
  
  if (req.user.status === 'banned') {
    return res.status(403).json({
      success: false,
      message: 'Your account has been banned. Please contact support.'
    });
  }
  
  next();
};

// Check if user is enrolled in course
exports.checkEnrollment = async (req, res, next) => {
  try {
    const courseId = req.params.id || req.params.courseId;
    const Enrollment = require('../models/Enrollment');
    
    if (!courseId) {
      return res.status(400).json({
        success: false,
        message: 'Course ID is required'
      });
    }
    
    // Check using Enrollment model for more reliable enrollment verification
    const enrollment = await Enrollment.findOne({
      student: req.user.id,
      course: courseId
    });

    if (!enrollment) {
      // Also check User model as fallback
      const user = await User.findById(req.user.id);
      if (user) {
        const userEnrollment = user.enrolledCourses.find(
          e => {
            const enrolledCourseId = e.course?._id ? e.course._id.toString() : e.course.toString();
            return enrolledCourseId === courseId.toString();
          }
        );
        
        if (userEnrollment) {
          req.enrollment = userEnrollment;
          return next();
        }
      }
      
      console.log('Enrollment check failed for:', { studentId: req.user.id, courseId });
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in this course'
      });
    }

    req.enrollment = enrollment;
    next();
  } catch (error) {
    console.error('Check enrollment error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Check if user is suspended and block write operations
exports.checkSuspension = (req, res, next) => {
  if (req.user && (req.user.status === 'suspended' || req.user.isSuspended)) {
    return res.status(403).json({
      success: false,
      message: 'Your account is temporarily suspended. You cannot perform this action. Please contact support.',
      isSuspended: true,
      status: 'suspended',
      suspensionReason: req.user.suspensionReason
    });
  }
  next();
};

// Fine-grained suspension enforcement for students (per-action)
exports.requireStudentNotRestricted = (restrictionKey) => {
  return (req, res, next) => {
    try {
      if (!req.user || req.user.role !== 'student') {
        return next();
      }
      if (!req.user.isSuspended && req.user.status !== 'suspended') {
        return next();
      }
      const restrictions = req.user.suspensionRestrictions || {};
      if (!restrictions[restrictionKey]) {
        return next();
      }
      return res.status(403).json({
        success: false,
        message: 'Your account is temporarily suspended from performing this action. Please contact support.',
        isSuspended: true,
        status: 'suspended',
        restriction: restrictionKey
      });
    } catch (error) {
      return next(error);
    }
  };
};

// Fine-grained suspension enforcement for instructors (per-permission)
exports.requireInstructorNotRestricted = (permissionKey) => {
  return (req, res, next) => {
    try {
      if (!req.user || req.user.role !== 'instructor') {
        return next();
      }
      if (!req.user.isSuspended && req.user.status !== 'suspended') {
        return next();
      }
      const restrictions = req.user.instructorSuspensionRestrictions || {};
      if (!restrictions[permissionKey]) {
        return next();
      }
      return res.status(403).json({
        success: false,
        message: 'Your instructor account is temporarily suspended from performing this action. Please contact support.',
        isSuspended: true,
        status: 'suspended',
        restriction: permissionKey
      });
    } catch (error) {
      return next(error);
    }
  };
};
