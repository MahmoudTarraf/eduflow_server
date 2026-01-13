const Group = require('../models/Group');
const Content = require('../models/Content');
const StudentProgress = require('../models/StudentProgress');
const Enrollment = require('../models/Enrollment');
const AdminSettings = require('../models/AdminSettings');
const StudentContentGrade = require('../models/StudentContentGrade');
const ActiveTest = require('../models/ActiveTest');
const TestAttempt = require('../models/TestAttempt');
const { calculateCourseGrade } = require('../services/gradingService');

const ELIGIBILITY_STATUSES = {
  GROUP_NOT_COMPLETED: 'GROUP_NOT_COMPLETED',
  GROUP_COMPLETED_BUT_GRADE_TOO_LOW: 'GROUP_COMPLETED_BUT_GRADE_TOO_LOW',
  GROUP_COMPLETED_AND_ELIGIBLE: 'GROUP_COMPLETED_AND_ELIGIBLE',
  CERTIFICATES_DISABLED: 'CERTIFICATES_DISABLED',
  CAN_REQUEST: 'CAN_REQUEST',
  AUTO_GRANT: 'AUTO_GRANT'
};

/**
 * Unified evaluation for certificate eligibility at GROUP level.
 * A Group is treated like an independent course: completion and grade
 * are computed only from that group's sections and content.
 *
 * @param {string} studentId
 * @param {string} groupId
 * @returns {Promise<{ status: string, eligible: boolean, details: object }>}
 */
async function isStudentEligibleForCertificate(studentId, groupId) {
  const group = await Group.findById(groupId).populate('course', 'offersCertificate certificateMode instructorCertificateRelease');
  if (!group) {
    throw new Error('Group not found');
  }

  const course = group.course;
  if (!course) {
    throw new Error('Group is not linked to a course');
  }

  // Ensure student is enrolled in this course+group
  const enrollment = await Enrollment.findOne({
    student: studentId,
    course: course._id,
    group: group._id
  });

  if (!enrollment) {
    return {
      status: ELIGIBILITY_STATUSES.GROUP_NOT_COMPLETED,
      eligible: false,
      details: {
        reason: 'NOT_ENROLLED',
        courseId: course._id,
        groupId: group._id
      }
    };
  }

  const settings = await AdminSettings.getSettings();
  const passingGrade = typeof settings.passingGrade === 'number' ? settings.passingGrade : 60;

  const certificateMode = course.certificateMode || 'automatic';
  const offersCertificate = course.offersCertificate !== false;

  if (!offersCertificate || certificateMode === 'disabled') {
    return {
      status: ELIGIBILITY_STATUSES.CERTIFICATES_DISABLED,
      eligible: false,
      details: {
        courseId: course._id,
        groupId: group._id,
        certificateMode,
        offersCertificate
      }
    };
  }

  // Compute group completion based on existing graded content only
  // 1) Load all graded content (lectures, assignments, projects) in this group
  const contents = await Content.find({
    group: group._id,
    isPublished: true
  }).select('_id type');

  const contentIds = contents.map((c) => c._id);

  // Load grading data for these contents
  const contentGrades = await StudentContentGrade.find({
    student: studentId,
    content: { $in: contentIds }
  }).select('content status gradePercent');

  const gradeMap = new Map();
  for (const g of contentGrades) {
    gradeMap.set(g.content.toString(), g);
  }

  // Load StudentProgress as a fallback for legacy/manual completion flows
  const progressDocs = await StudentProgress.find({
    student: studentId,
    group: group._id,
    content: { $in: contentIds }
  }).select('content item completed type contentType');

  const progressMap = new Map();
  for (const p of progressDocs) {
    const id = (p.content || p.item)?.toString();
    if (id) {
      progressMap.set(id, p);
    }
  }

  let gradedItemsTotal = 0;
  let gradedItemsCompleted = 0;

  for (const content of contents) {
    gradedItemsTotal += 1;
    const idStr = content._id.toString();
    const grade = gradeMap.get(idStr);
    const progress = progressMap.get(idStr);
    const type = content.type;

    let isCompleted = false;

    if (type === 'lecture') {
      // Lecture is complete if fully watched or explicitly marked complete
      isCompleted =
        (grade && grade.status === 'watched') ||
        (progress && progress.completed);
    } else if (type === 'assignment' || type === 'project') {
      // Assignment/Project is complete once submitted (graded or pending)
      isCompleted =
        (grade && (grade.status === 'graded' || grade.status === 'submitted_ungraded')) ||
        (progress && progress.completed);
    } else {
      // Fallback for any future content types
      isCompleted = !!(progress && progress.completed);
    }

    if (isCompleted) {
      gradedItemsCompleted += 1;
    }
  }

  // 2) Include active tests in this group as graded content items
  const tests = await ActiveTest.find({
    group: group._id,
    isActive: true
  }).select('_id');

  if (tests.length > 0) {
    const testIds = tests.map((t) => t._id);
    const attempts = await TestAttempt.find({
      student: studentId,
      test: { $in: testIds },
      status: 'graded'
    }).select('test score');

    const hasGradedAttempt = new Set(attempts.map((a) => a.test.toString()));

    for (const test of tests) {
      gradedItemsTotal += 1;
      if (hasGradedAttempt.has(test._id.toString())) {
        gradedItemsCompleted += 1;
      }
    }
  }

  const totalItems = gradedItemsTotal;
  const completedItems = gradedItemsCompleted;

  const completionPercentage = totalItems > 0
    ? Math.round((completedItems / totalItems) * 100)
    : 0;

  const groupCompleted = totalItems > 0 && completedItems >= totalItems;

  // Compute group-based grade using gradingService (sections filtered by group)
  const { courseGrade, stats } = await calculateCourseGrade(studentId, course._id.toString(), group._id.toString());
  const overallGrade = typeof courseGrade === 'number' ? courseGrade : 0;

  if (!groupCompleted) {
    return {
      status: ELIGIBILITY_STATUSES.GROUP_NOT_COMPLETED,
      eligible: false,
      details: {
        courseId: course._id,
        groupId: group._id,
        totalItems,
        completedItems,
        completionPercentage,
        overallGrade,
        passingGrade,
        sectionsCount: stats?.sectionsCount ?? null,
        sectionsCompleted: stats?.sectionsCompleted ?? null
      }
    };
  }

  if (overallGrade < passingGrade) {
    return {
      status: ELIGIBILITY_STATUSES.GROUP_COMPLETED_BUT_GRADE_TOO_LOW,
      eligible: false,
      details: {
        courseId: course._id,
        groupId: group._id,
        totalItems,
        completedItems,
        completionPercentage,
        overallGrade,
        passingGrade,
        sectionsCount: stats?.sectionsCount ?? null,
        sectionsCompleted: stats?.sectionsCompleted ?? null
      }
    };
  }

  // At this point, group is fully completed AND grade >= global passing grade
  // Decide mode-specific outcome
  if (certificateMode === 'automatic') {
    return {
      status: ELIGIBILITY_STATUSES.AUTO_GRANT,
      eligible: true,
      details: {
        courseId: course._id,
        groupId: group._id,
        totalItems,
        completedItems,
        completionPercentage,
        overallGrade,
        passingGrade,
        certificateMode,
        sectionsCount: stats?.sectionsCount ?? null,
        sectionsCompleted: stats?.sectionsCompleted ?? null
      }
    };
  }

  if (certificateMode === 'manual_instructor') {
    if (course.instructorCertificateRelease) {
      return {
        status: ELIGIBILITY_STATUSES.CAN_REQUEST,
        eligible: true,
        details: {
          courseId: course._id,
          groupId: group._id,
          totalItems,
          completedItems,
          completionPercentage,
          overallGrade,
          passingGrade,
          certificateMode,
          instructorCertificateRelease: true,
          sectionsCount: stats?.sectionsCount ?? null,
          sectionsCompleted: stats?.sectionsCompleted ?? null
        }
      };
    }

    // Manual mode but instructor has not opened requests yet
    return {
      status: ELIGIBILITY_STATUSES.GROUP_COMPLETED_AND_ELIGIBLE,
      eligible: true,
      details: {
        courseId: course._id,
        groupId: group._id,
        totalItems,
        completedItems,
        completionPercentage,
        overallGrade,
        passingGrade,
        certificateMode,
        instructorCertificateRelease: false,
        sectionsCount: stats?.sectionsCount ?? null,
        sectionsCompleted: stats?.sectionsCompleted ?? null
      }
    };
  }

  // Fallback for any future/unknown modes
  return {
    status: ELIGIBILITY_STATUSES.GROUP_COMPLETED_AND_ELIGIBLE,
    eligible: true,
    details: {
      courseId: course._id,
      groupId: group._id,
      totalItems,
      completedItems,
      completionPercentage,
      overallGrade,
      passingGrade,
      certificateMode,
      sectionsCount: stats?.sectionsCount ?? null,
      sectionsCompleted: stats?.sectionsCompleted ?? null
    }
  };
}

module.exports = {
  ELIGIBILITY_STATUSES,
  isStudentEligibleForCertificate
};
