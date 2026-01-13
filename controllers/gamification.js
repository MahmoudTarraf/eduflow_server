const User = require('../models/User');
const Badge = require('../models/Badge');
const GamificationSettings = require('../models/GamificationSettings');
const Achievement = require('../models/Achievement');
const GamificationActivity = require('../models/GamificationActivity');
const Content = require('../models/Content');
const ActiveTest = require('../models/ActiveTest');
const CourseGrade = require('../models/CourseGrade');
const CertificateRequest = require('../models/CertificateRequest');

// Point values cache (DB-backed)
let SETTINGS_CACHE = null;
let SETTINGS_CACHE_TIME = 0;
const SETTINGS_TTL_MS = 60 * 1000; // 1 minute cache

async function loadPointSettings(force = false) {
  const now = Date.now();
  if (!force && SETTINGS_CACHE && now - SETTINGS_CACHE_TIME < SETTINGS_TTL_MS) {
    return SETTINGS_CACHE;
  }
  let doc = await GamificationSettings.findOne();
  if (!doc) {
    doc = await GamificationSettings.create({});
  }
  SETTINGS_CACHE = {
    lesson: doc.lesson ?? 5,
    quiz: doc.quiz ?? 10,
    course: doc.course ?? 50,
    assignment: doc.assignment ?? 8,
    project: doc.project ?? 12,
    // Include conversion settings
    conversionSettings: {
      pointsRequired: doc.conversionSettings?.pointsRequired ?? 500,
      sypValue: doc.conversionSettings?.sypValue ?? 10000,
      minimumPointsThreshold: doc.conversionSettings?.minimumPointsThreshold ?? 500,
      enableBalancePayments: doc.conversionSettings?.enableBalancePayments !== false,
      lastUpdated: doc.conversionSettings?.lastUpdated,
      updatedBy: doc.conversionSettings?.updatedBy
    }
  };

  SETTINGS_CACHE_TIME = now;
  return SETTINGS_CACHE;
}

// Map external activity types to internal points keys and context labels
function mapActivityToInternal(activityType) {
  switch (activityType) {
    case 'videoWatch':
    case 'lesson':
      return { pointsKey: 'lesson', contentTypeLabel: 'Video' };
    case 'assignmentUpload':
    case 'assignment':
      return { pointsKey: 'assignment', contentTypeLabel: 'Assignment' };
    case 'projectUpload':
    case 'project':
      return { pointsKey: 'project', contentTypeLabel: 'Project' };
    case 'testComplete':
    case 'quiz':
      return { pointsKey: 'quiz', contentTypeLabel: 'Test' };
    case 'courseComplete':
    case 'course':
      return { pointsKey: 'course', contentTypeLabel: 'Course' };
    default:
      return { pointsKey: activityType, contentTypeLabel: '' };
  }
}

// Duplicate-safe awarding with activity log
module.exports.awardOnceForActivityInternal = async (params) => {
  const {
    studentId,
    activityType, // e.g., videoWatch, assignmentUpload, projectUpload, testComplete
    contentId,
    contentModel, // 'Content' | 'ActiveTest' | etc.
    contentTitle,
    courseId,
    metadata = {}
  } = params || {};

  try {
    const student = await User.findById(studentId);
    if (!student || student.role !== 'student') {
      return { success: false, error: 'Student not found' };
    }

    const { pointsKey, contentTypeLabel } = mapActivityToInternal(activityType);
    const uniquenessKey = `${studentId}-${activityType}-${contentId}`;

    // Try to insert activity log first to ensure uniqueness
    try {
      await GamificationActivity.create({
        student: studentId,
        activityType,
        contentId,
        contentModel: contentModel || (activityType === 'testComplete' ? 'ActiveTest' : 'Content'),
        contentTitle: contentTitle || '',
        contentType: contentTypeLabel || '',
        course: courseId || null,
        metadata,
        awardedPoints: 0,
        uniquenessKey
      });
    } catch (e) {
      // Duplicate activity - do not award points again
      if (e && (e.code === 11000 || String(e.message || '').includes('duplicate key'))) {
        return {
          success: true,
          duplicate: true,
          pointsAwarded: 0,
          totalPoints: student.gamification?.points || 0,
          awardedBadges: [],
          assignedTitle: null
        };
      }
      throw e;
    }

    // Not duplicate, award points now
    const pointsToAdd = await getPointValue(pointsKey) || 0;
    student.gamification.points = (student.gamification.points || 0) + pointsToAdd;

    // Update counters based on internal key
    if (pointsKey === 'lesson') {
      student.gamification.lessonsCompleted = (student.gamification.lessonsCompleted || 0) + 1;
    } else if (pointsKey === 'quiz') {
      student.gamification.quizzesCompleted = (student.gamification.quizzesCompleted || 0) + 1;
    } else if (pointsKey === 'course') {
      student.gamification.coursesCompleted = (student.gamification.coursesCompleted || 0) + 1;
    }

    await student.save();

    // Compose descriptive achievement message
    let reason = '';
    if (pointsKey === 'lesson') {
      let pctText = '';
      const wd = Number(metadata?.watchedDuration || 0);
      const td = Number(metadata?.totalDuration || 0);
      if (td > 0) {
        const pct = Math.round((wd / td) * 100);
        pctText = ` (${pct}% watched)`;
      }
      reason = `+${pointsToAdd} point${pointsToAdd === 1 ? '' : 's'} — Watched ${contentTypeLabel.toLowerCase()}: '${contentTitle || 'Content'}'${pctText}`;
    } else if (pointsKey === 'assignment') {
      reason = `+${pointsToAdd} point${pointsToAdd === 1 ? '' : 's'} — Earned for uploading assignment: '${contentTitle || 'Assignment'}'`;
    } else if (pointsKey === 'project') {
      reason = `+${pointsToAdd} point${pointsToAdd === 1 ? '' : 's'} — Earned for uploading project: '${contentTitle || 'Project'}'`;
    } else if (pointsKey === 'quiz') {
      reason = `+${pointsToAdd} point${pointsToAdd === 1 ? '' : 's'} — Completed test: '${contentTitle || 'Test'}'`;
    } else if (pointsKey === 'course') {
      reason = `+${pointsToAdd} point${pointsToAdd === 1 ? '' : 's'} — Course completed`;
    }

    // Log achievement with rich meta for Recent Activities
    try {
      await logAchievement(student._id, 'points', {
        points: pointsToAdd,
        message: reason,
        meta: {
          reason,
          courseId: courseId || null,
          courseName: metadata.courseName || undefined,
          contentId: contentId,
          contentType: contentTypeLabel,
          contentTitle: contentTitle
        }
      });
    } catch (_) {}

    // Update recently created activity with awardedPoints
    try {
      await GamificationActivity.findOneAndUpdate(
        { uniquenessKey },
        { awardedPoints: pointsToAdd }
      );
    } catch (_) {}

    const newlyAwarded = await checkAndAwardBadges(student);

    return {
      success: true,
      pointsAwarded: pointsToAdd,
      totalPoints: student.gamification.points,
      awardedBadges: newlyAwarded,
      assignedTitle: null,
      detailMessage: reason,
      contentTitle: contentTitle || undefined,
      contentType: contentTypeLabel || undefined
    };
  } catch (error) {
    console.error('awardOnceForActivityInternal error:', error);
    return { success: false, error: error.message };
  }
};

async function getPointValue(actionType) {
  const s = await loadPointSettings(false);
  return s[actionType] ?? 0;
}

async function logAchievement(studentId, type, payload = {}) {
  try {
    await Achievement.create({
      student: studentId,
      type,
      message: payload.message || '',
      points: payload.points || 0,
      badgeTitle: payload.badgeTitle || null,
      badgeIcon: payload.badgeIcon || null,
      titleName: payload.titleName || null,
      titleIcon: payload.titleIcon || null,
      meta: payload.meta || {}
    });
  } catch (e) {
    // do not throw
  }
}

// @desc    Get or update point values (Admin only)
// @route   GET/PUT /api/gamification/settings
// @access  Private (Admin)
exports.getPointSettings = async (req, res) => {
  try {
    const vals = await loadPointSettings(false);
    const { conversionSettings, ...pointValues } = vals;
    res.json({ 
      success: true, 
      pointValues: pointValues,
      conversionSettings: conversionSettings
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get public student stats for leaderboard modal
// @route   GET /api/gamification/student/:id/public-stats
// @access  Private (Student/Instructor/Admin)
exports.getPublicStudentStats = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select('name avatar role gamification');
    if (!user || user.role !== 'student') {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const [certificates, completedCoursesCount, assignmentsFinished, testsCompleted, recentAchievements] = await Promise.all([
      CertificateRequest.find({ student: id, status: 'issued' })
        .populate('course', 'name')
        .sort({ issuedAt: -1 })
        .limit(10),
      CourseGrade.countDocuments({ student: id, isComplete: true }),
      // Count distinct submitted or graded assignments/projects
      (async () => {
        const StudentContentGrade = require('../models/StudentContentGrade');
        const contents = await StudentContentGrade.aggregate([
          { $match: { student: user._id, status: { $in: ['submitted_ungraded', 'graded'] } } },
          { $group: { _id: '$content' } }
        ]);
        return contents.length;
      })(),
      // Count distinct graded tests
      (async () => {
        const attempts = await require('../models/TestAttempt').aggregate([
          { $match: { student: user._id, status: 'graded' } },
          { $group: { _id: '$test' } }
        ]);
        return attempts.length;
      })(),
      Achievement.find({ student: id }).sort({ createdAt: -1 }).limit(5)
    ]);

    const stats = {
      name: user.name,
      avatar: user.avatar,
      points: user.gamification?.points || 0,
      badgeCount: Array.isArray(user.gamification?.badges) ? user.gamification.badges.length : 0,
      certificates: certificates.map(c => ({ id: String(c._id), courseName: c.course?.name || 'Course', issuedAt: c.issuedAt })),
      certificatesCount: certificates.length,
      completedCoursesCount,
      assignmentsFinished,
      testsCompleted,
      recentAchievements: recentAchievements.map((a) => ({
        id: String(a._id),
        type: a.type,
        message: a.message,
        points: a.points,
        createdAt: a.createdAt
      }))
    };

    res.json({ success: true, stats });
  } catch (error) {
    console.error('getPublicStudentStats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get recent achievements for current student
// @route   GET /api/gamification/my-achievements
// @access  Private (Student)
exports.getMyAchievements = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const items = await Achievement.find({ student: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit);

    // Enrich with meta fields at top level for improved Recent Activities display
    const achievements = items.map((doc) => {
      const a = doc.toObject();
      const meta = a.meta || {};
      return {
        ...a,
        courseName: meta.courseName || a.courseName,
        contentTitle: meta.contentTitle || a.contentTitle,
        contentType: meta.contentType || a.contentType,
        lessonName: meta.lessonName || a.lessonName,
        videoName: meta.videoName || a.videoName,
        reason: meta.reason || a.message || ''
      };
    });

    res.json({ success: true, achievements });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.updatePointSettings = async (req, res) => {
  try {
    const { lesson, quiz, course, assignment, project } = req.body;
    let doc = await GamificationSettings.findOne();
    if (!doc) doc = new GamificationSettings({});
    if (lesson !== undefined) doc.lesson = lesson;
    if (quiz !== undefined) doc.quiz = quiz;
    if (course !== undefined) doc.course = course;
    if (assignment !== undefined) doc.assignment = assignment;
    if (project !== undefined) doc.project = project;
    await doc.save();
    await loadPointSettings(true);
    res.json({ success: true, pointValues: SETTINGS_CACHE, message: 'Point values updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Update conversion settings (Admin only)
// @route   PUT /api/gamification/conversion-settings
// @access  Private (Admin)
exports.updateConversionSettings = async (req, res) => {
  try {
    const { pointsRequired, sypValue, minimumPointsThreshold, enableBalancePayments } = req.body;
    
    // Validation
    if (!pointsRequired || !sypValue || pointsRequired <= 0 || sypValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Points required and SYP value must be positive numbers'
      });
    }

    if (!Number.isInteger(pointsRequired) || !Number.isInteger(sypValue)) {
      return res.status(400).json({
        success: false,
        message: 'Points required and SYP value must be integers'
      });
    }

    // Optional fields validation
    if (minimumPointsThreshold !== undefined && !Number.isInteger(minimumPointsThreshold)) {
      return res.status(400).json({ success: false, message: 'minimumPointsThreshold must be an integer' });
    }
    if (enableBalancePayments !== undefined && typeof enableBalancePayments !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enableBalancePayments must be a boolean' });
    }

    let doc = await GamificationSettings.findOne();
    if (!doc) {
      doc = new GamificationSettings({});
    }

    // Update conversion settings
    if (!doc.conversionSettings) {
      doc.conversionSettings = {};
    }
    doc.conversionSettings.pointsRequired = pointsRequired;
    doc.conversionSettings.sypValue = sypValue;
    if (minimumPointsThreshold !== undefined) {
      doc.conversionSettings.minimumPointsThreshold = minimumPointsThreshold;
    }
    if (enableBalancePayments !== undefined) {
      doc.conversionSettings.enableBalancePayments = enableBalancePayments;
    }
    doc.conversionSettings.lastUpdated = new Date();
    doc.conversionSettings.updatedBy = req.user.id;

    await doc.save();
    
    // Refresh cache
    await loadPointSettings(true);
    
    res.json({
      success: true,
      message: 'Conversion settings updated successfully',
      conversionSettings: SETTINGS_CACHE.conversionSettings
    });
  } catch (error) {
    console.error('Update conversion settings error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Award points to student
// @route   POST /api/gamification/award-points
// @access  Private (System/Instructor)
exports.awardPoints = async (req, res) => {
  try {
    const { studentId, actionType, amount } = req.body;
    
    const student = await User.findById(studentId);
    if (!student || student.role !== 'student') {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Award points
    const pointsToAdd = amount || await getPointValue(actionType) || 0;
    student.gamification.points += pointsToAdd;
    
    // Update activity counters
    if (actionType === 'lesson') {
      student.gamification.lessonsCompleted += 1;
    } else if (actionType === 'quiz') {
      student.gamification.quizzesCompleted += 1;
    } else if (actionType === 'course') {
      student.gamification.coursesCompleted += 1;
    }
    
    await student.save();
    
    // Check and award badges
    const newlyAwarded = await checkAndAwardBadges(student);
    if (pointsToAdd > 0) {
      await logAchievement(student._id, 'points', { points: pointsToAdd, message: `${actionType} points` });
    }
    
    res.json({
      success: true,
      points: student.gamification.points,
      pointsAwarded: pointsToAdd,
      awardedBadges: newlyAwarded,
      // assignedTitle was previously populated via Title model; this feature is now deprecated
      assignedTitle: null,
      message: `${pointsToAdd} points awarded`
    });
  } catch (error) {
    console.error('Award points error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Update streak
// @route   POST /api/gamification/update-streak
// @access  Private
exports.updateStreak = async (req, res) => {
  try {
    const student = await User.findById(req.user.id);
    
    if (!student || student.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    const now = new Date();
    const lastLogin = student.gamification.lastLogin;
    
    let streakChanged = false;
    if (lastLogin) {
      const hoursSinceLastLogin = (now - lastLogin) / (1000 * 60 * 60);
      
      if (hoursSinceLastLogin < 24) {
        // Same day or within 24 hours, don't increment
        // Just update lastLogin
      } else if (hoursSinceLastLogin < 48) {
        // Next day, increment streak
        student.gamification.streakDays += 1;
        streakChanged = true;
      } else {
        // Streak broken, reset to 1
        student.gamification.streakDays = 1;
        streakChanged = true;
      }
    } else {
      // First time login
      student.gamification.streakDays = 1;
      streakChanged = true;
    }
    
    student.gamification.lastLogin = now;
    await student.save();
    
    // Check for streak badges
    const newlyAwarded = await checkAndAwardBadges(student);
    res.json({
      success: true,
      streakDays: student.gamification.streakDays,
      lastShownStreak: student.lastShownStreak || 0,
      // Title assignment via Title model is deprecated
      assignedTitle: null,
      streakChanged,
      awardedBadges: newlyAwarded,
      streakMessage: streakChanged ? 
        `${student.gamification.streakDays} day${student.gamification.streakDays === 1 ? '' : 's'} streak! 🔥` : 
        null
    });
  } catch (error) {
    console.error('Update streak error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get student stats
// @route   GET /api/gamification/my-stats
// @access  Private (Student)
exports.getMyStats = async (req, res) => {
  try {
    const student = await User.findById(req.user.id).select('gamification name role');
    
    if (!student || student.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    
    // Initialize gamification stats if they don't exist
    if (!student.gamification) {
      student.gamification = {
        points: 0,
        title: '',
        streakDays: 0,
        lessonsCompleted: 0,
        quizzesCompleted: 0,
        coursesCompleted: 0,
        badges: [],
        lastLogin: null
      };
      await student.save();
    }
    
    // Get badge details
    const badgeIds = student.gamification.badges || [];
    const badges = await Badge.find({ title: { $in: badgeIds }, isActive: true });
    
    // Titles based on a separate Title model have been deprecated.
    // Preserve any existing title string on the user document but do not auto-assign.
    const currentTitle = student.gamification.title || '';
    
    // Calculate wallet balance from points
    const settings = await loadPointSettings(false);
    const conversionRate = settings.conversionSettings;
    let walletBalance = 0;
    if (conversionRate && conversionRate.pointsRequired > 0) {
      walletBalance = Math.floor((student.gamification.points / conversionRate.pointsRequired) * conversionRate.sypValue);
    }
    
    res.json({
      success: true,
      stats: {
        points: student.gamification.points || 0,
        title: currentTitle,
        streakDays: student.gamification.streakDays || 0,
        lessonsCompleted: student.gamification.lessonsCompleted || 0,
        quizzesCompleted: student.gamification.quizzesCompleted || 0,
        coursesCompleted: student.gamification.coursesCompleted || 0,
        badges: badges,
        badgeCount: badges.length,
        // Points-to-Balance system
        walletBalance: walletBalance,
        conversionRate: conversionRate
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, message: 'Server error', stats: {
      points: 0,
      title: '',
      streakDays: 0,
      lessonsCompleted: 0,
      quizzesCompleted: 0,
      coursesCompleted: 0,
      badges: [],
      badgeCount: 0
    } });
  }
};

// @desc    Get leaderboard
// @route   GET /api/gamification/leaderboard
// @access  Private (Admin/Instructor)
exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const q = (req.query.q || '').trim();

    const filter = { role: 'student', isDeleted: { $ne: true } };
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } }
      ];
    }

    // Pull minimal fields for page
    const students = await User.find(filter)
      .select('name email avatar gamification')
      .lean();

    // Ensure gamification exists in-memory for sorting
    students.forEach(s => {
      if (!s.gamification) {
        s.gamification = { points: 0, badges: [] };
      }
    });

    // Sort by points desc and paginate
    const sorted = students.sort((a, b) => (b.gamification?.points || 0) - (a.gamification?.points || 0));
    const total = sorted.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const pageItems = sorted.slice(start, end);

    // Compute counts per student (certificates, completed courses)
    const leaderboard = await Promise.all(pageItems.map(async (student, idx) => {
      const [certCount, completedCourses] = await Promise.all([
        CertificateRequest.countDocuments({ student: student._id, status: 'issued' }),
        CourseGrade.countDocuments({ student: student._id, isComplete: true })
      ]);

      return {
        rank: start + idx + 1,
        id: String(student._id),
        name: student.name || 'Unknown',
        email: student.email,
        avatar: student.avatar,
        points: student.gamification?.points || 0,
        badgeCount: Array.isArray(student.gamification?.badges) ? student.gamification.badges.length : 0,
        certificatesCount: certCount,
        completedCoursesCount: completedCourses
      };
    }));

    res.json({
      success: true,
      total,
      page,
      limit,
      leaderboard
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Helper function to check and award badges
async function checkAndAwardBadges(student) {
  try {
    const badges = await Badge.find({ isActive: true });
    
    const newlyAwarded = [];
    for (const badge of badges) {
      // Skip if student already has this badge
      if (student.gamification.badges.includes(badge.title)) {
        continue;
      }
      
      let shouldAward = false;
      
      switch (badge.conditionType) {
        case 'lesson':
          shouldAward = student.gamification.lessonsCompleted >= badge.threshold;
          break;
        case 'quiz':
          shouldAward = student.gamification.quizzesCompleted >= badge.threshold;
          break;
        case 'course':
          shouldAward = student.gamification.coursesCompleted >= badge.threshold;
          break;
        case 'streak':
          shouldAward = student.gamification.streakDays >= badge.threshold;
          break;
        case 'points':
          shouldAward = student.gamification.points >= badge.threshold;
          break;
      }
      
      if (shouldAward) {
        student.gamification.badges.push(badge.title);
        student.gamification.points += badge.pointsReward;
        newlyAwarded.push({ title: badge.title, icon: badge.icon, pointsReward: badge.pointsReward });
        await logAchievement(student._id, 'badge', { badgeTitle: badge.title, badgeIcon: badge.icon, points: badge.pointsReward || 0 });
      }
    }
    
    await student.save();
    return newlyAwarded;
  } catch (error) {
    console.error('Check badges error:', error);
    return [];
  }
}

// Title assignment via a separate Title model has been removed.
// Existing gamification.title strings on the user document are preserved but no longer
// updated automatically based on points.

// @desc    Get all badges (Admin)
// @route   GET /api/gamification/badges
// @access  Private (Admin)
exports.getAllBadges = async (req, res) => {
  try {
    const badges = await Badge.find().sort({ createdAt: -1 });
    
    res.json({
      success: true,
      badges
    });
  } catch (error) {
    console.error('Get badges error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Create badge (Admin)
// @route   POST /api/gamification/badges
// @access  Private (Admin)
exports.createBadge = async (req, res) => {
  try {
    const { title, description, icon, conditionType, threshold, pointsReward } = req.body;
    
    const badge = await Badge.create({
      title,
      description,
      icon: icon || '🏅',
      conditionType,
      threshold,
      pointsReward: pointsReward || 0,
      createdBy: req.user.id
    });
    
    res.status(201).json({
      success: true,
      badge,
      message: 'Badge created successfully'
    });
  } catch (error) {
    console.error('Create badge error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Update badge (Admin)
// @route   PUT /api/gamification/badges/:id
// @access  Private (Admin)
exports.updateBadge = async (req, res) => {
  try {
    const badge = await Badge.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }
    
    res.json({
      success: true,
      badge,
      message: 'Badge updated successfully'
    });
  } catch (error) {
    console.error('Update badge error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Delete badge (Admin)
// @route   DELETE /api/gamification/badges/:id
// @access  Private (Admin)
exports.deleteBadge = async (req, res) => {
  try {
    const badge = await Badge.findById(req.params.id);
    
    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }
    
    await badge.deleteOne();
    
    res.json({
      success: true,
      message: 'Badge deleted successfully'
    });
  } catch (error) {
    console.error('Delete badge error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = exports;

// Internal helper that other controllers can call without HTTP layer
module.exports.awardPointsInternal = async (studentId, actionType, amount) => {
  try {
    const student = await User.findById(studentId);
    if (!student || student.role !== 'student') {
      return { success: false, error: 'Student not found' };
    }

    const pointsToAdd = amount || await getPointValue(actionType) || 0;
    student.gamification.points = (student.gamification.points || 0) + pointsToAdd;

    if (actionType === 'lesson') {
      student.gamification.lessonsCompleted = (student.gamification.lessonsCompleted || 0) + 1;
    } else if (actionType === 'quiz') {
      student.gamification.quizzesCompleted = (student.gamification.quizzesCompleted || 0) + 1;
    } else if (actionType === 'course') {
      student.gamification.coursesCompleted = (student.gamification.coursesCompleted || 0) + 1;
    }

    await student.save();
    const newlyAwarded = await checkAndAwardBadges(student);
    if (pointsToAdd > 0) {
      await logAchievement(student._id, 'points', { points: pointsToAdd, message: `${actionType} points` });
    }

    return {
      success: true,
      pointsAwarded: pointsToAdd,
      totalPoints: student.gamification.points,
      awardedBadges: newlyAwarded,
      // Title assignment is deprecated; keep response key for backward compatibility
      assignedTitle: null
    };
  } catch (error) {
    console.error('awardPointsInternal error:', error);
    return { success: false, error: error.message };
  }
};

// Update lastShownStreak for animation control
exports.updateLastShownStreak = async (req, res) => {
  try {
    const { lastShownStreak } = req.body;
    const userId = req.user.id;
    
    if (typeof lastShownStreak !== 'number' || lastShownStreak < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid lastShownStreak value' 
      });
    }
    
    const user = await User.findByIdAndUpdate(
      userId,
      { lastShownStreak },
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    console.log(`Updated lastShownStreak for user ${user.email} to ${lastShownStreak}`);
    
    res.json({ 
      success: true, 
      lastShownStreak: user.lastShownStreak,
      message: 'Last shown streak updated successfully'
    });
  } catch (error) {
    console.error('Update lastShownStreak error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error updating last shown streak' 
    });
  }
};
