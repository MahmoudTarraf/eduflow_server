const express = require('express');
const router = express.Router();
const { protect, authorize, requireStudentNotRestricted } = require('../middleware/auth');
const { uploadReceipt, handleMulterError } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');
const {
  submitSectionPayment,
  listSectionPayments,
  approveSectionPayment,
  rejectSectionPayment,
  getMyPayments,
  getSectionPaymentStatus
} = require('../controllers/sectionPayments');

router.post(
  '/sections/:sectionId/payments',
  protect,
  authorize('student', 'instructor', 'admin'),
  requireStudentNotRestricted('continueCourses'),
  uploadReceipt.single('receipt'),
  handleMulterError,
  scanFile,
  submitSectionPayment
);

router.get(
  '/section-payments/my-payments',
  protect,
  authorize('student'),
  requireStudentNotRestricted('continueCourses'),
  getMyPayments
);

router.get(
  '/section-payments/course/:courseId/status',
  protect,
  authorize('student'),
  requireStudentNotRestricted('continueCourses'),
  getSectionPaymentStatus
);

router.get(
  '/section-payments',
  protect,
  authorize('instructor', 'admin'),
  listSectionPayments
);

router.post(
  '/section-payments/:paymentId/approve',
  protect,
  authorize('instructor', 'admin'),
  approveSectionPayment
);

router.post(
  '/section-payments/:paymentId/reject',
  protect,
  authorize('instructor', 'admin'),
  rejectSectionPayment
);

module.exports = router;
