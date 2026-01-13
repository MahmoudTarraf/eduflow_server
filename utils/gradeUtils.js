const Section = require('../models/Section');
const Enrollment = require('../models/Enrollment');
const StudentSectionGrade = require('../models/StudentSectionGrade');
const SectionPayment = require('../models/SectionPayment');

const toNumeric = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value;
  }

  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof value === 'object' && typeof value.toString === 'function') {
    const parsed = parseFloat(value.toString());
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
};

const toPlainPayment = (payment) => {
  if (!payment) {
    return null;
  }

  return {
    id: payment._id,
    status: payment.status,
    submittedAt: payment.submittedAt,
    processedAt: payment.processedAt,
    rejectionReason: payment.rejectionReason || null
  };
};

const calculateOverallGrade = (grades) => {
  const numericGrades = grades.filter(
    (grade) => typeof grade === 'number' && !Number.isNaN(grade)
  );

  if (!numericGrades.length) {
    return null;
  }

  const average = numericGrades.reduce((sum, grade) => sum + grade, 0) / numericGrades.length;
  return Number(average.toFixed(2));
};

const loadCourseSections = async (courseId) => {
  return Section.find({ course: courseId, isActive: true })
    .sort('order')
    .select('name order isFree isPaid priceCents currency group');
};

const getStudentEnrollment = async (studentId, courseId) => {
  return Enrollment.findOne({ student: studentId, course: courseId });
};

const getSectionGradesForStudent = async (studentId, sectionIds) => {
  if (!sectionIds.length) {
    return new Map();
  }

  const grades = await StudentSectionGrade.find({
    student: studentId,
    section: { $in: sectionIds }
  });

  const map = new Map();
  grades.forEach((grade) => {
    const sectionId = grade.section.toString();
    map.set(sectionId, toNumeric(grade.gradePercent));
  });

  return map;
};

const getSectionGradesForStudents = async (studentIds, sectionIds) => {
  if (!studentIds.length || !sectionIds.length) {
    return new Map();
  }

  const grades = await StudentSectionGrade.find({
    student: { $in: studentIds },
    section: { $in: sectionIds }
  });

  const map = new Map();
  grades.forEach((grade) => {
    const key = `${grade.student.toString()}:${grade.section.toString()}`;
    map.set(key, toNumeric(grade.gradePercent));
  });

  return map;
};

const getLatestPaymentsForStudent = async (studentId, sectionIds) => {
  if (!sectionIds.length) {
    return new Map();
  }

  const payments = await SectionPayment.find({
    student: studentId,
    section: { $in: sectionIds }
  }).sort({ submittedAt: -1 });

  const map = new Map();
  payments.forEach((payment) => {
    const sectionId = payment.section.toString();
    if (!map.has(sectionId)) {
      map.set(sectionId, payment);
    }
  });

  return map;
};

const getLatestPaymentsForStudents = async (studentIds, sectionIds) => {
  if (!studentIds.length || !sectionIds.length) {
    return new Map();
  }

  const payments = await SectionPayment.find({
    student: { $in: studentIds },
    section: { $in: sectionIds }
  }).sort({ submittedAt: -1 });

  const map = new Map();
  payments.forEach((payment) => {
    const key = `${payment.student.toString()}:${payment.section.toString()}`;
    if (!map.has(key)) {
      map.set(key, payment);
    }
  });

  return map;
};

const determineSectionAccess = (section, enrollment, paymentDoc) => {
  const latestPayment = toPlainPayment(paymentDoc);

  if (section.isUnlockedByDefault) {
    return {
      isUnlocked: true,
      status: 'unlocked',
      reason: 'free',
      latestPayment
    };
  }

  const isEnrolled = Boolean(
    enrollment && typeof enrollment.isSectionEnrolled === 'function'
      ? enrollment.isSectionEnrolled(section._id)
      : false
  );

  if (isEnrolled) {
    return {
      isUnlocked: true,
      status: 'unlocked',
      reason: 'enrolled',
      latestPayment
    };
  }

  if (paymentDoc) {
    if (paymentDoc.status === 'approved') {
      return {
        isUnlocked: true,
        status: 'unlocked',
        reason: 'payment_approved',
        latestPayment
      };
    }

    if (paymentDoc.status === 'pending') {
      return {
        isUnlocked: false,
        status: 'locked',
        reason: 'payment_pending',
        latestPayment
      };
    }

    if (paymentDoc.status === 'rejected') {
      return {
        isUnlocked: false,
        status: 'locked',
        reason: 'payment_rejected',
        latestPayment
      };
    }
  }

  return {
    isUnlocked: false,
    status: 'locked',
    reason: 'payment_required',
    latestPayment
  };
};

module.exports = {
  calculateOverallGrade,
  determineSectionAccess,
  getLatestPaymentsForStudent,
  getLatestPaymentsForStudents,
  getSectionGradesForStudent,
  getSectionGradesForStudents,
  getStudentEnrollment,
  loadCourseSections,
  toPlainPayment
};
