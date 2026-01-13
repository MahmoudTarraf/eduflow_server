const express = require('express');
const { body } = require('express-validator');
const {
  requestCertificate,
  getCertificateRequests,
  getMyCertificates,
  getMyRequests,
  approveCertificate,
  rejectCertificate,
  deleteCertificateRequest,
  getMyCertificateEligibility
} = require('../controllers/certificates');
const { protect, authorize, requireStudentNotRestricted, requireInstructorNotRestricted } = require('../middleware/auth');
const { uploadCertificate } = require('../middleware/upload');
const scanFile = require('../middleware/scanFile');

const router = express.Router();

// @desc    Request certificate
// @route   POST /api/certificates/request
// @access  Private (Student)
router.post('/request', protect, authorize('student'), requireStudentNotRestricted('requestCertificate'), [
  body('courseId').notEmpty().withMessage('Course ID is required')
], requestCertificate);

// @desc    Get certificate requests
// @route   GET /api/certificates/requests
// @access  Private (Instructor/Admin)
router.get('/requests', protect, authorize('instructor', 'admin'), getCertificateRequests);

// @desc    Get my certificates
// @route   GET /api/certificates/my
// @access  Private (Student)
router.get('/my', protect, authorize('student'), getMyCertificates);

// @desc    Get all my certificate requests
// @route   GET /api/certificates/my-requests
// @access  Private (Student)
router.get('/my-requests', protect, authorize('student'), requireStudentNotRestricted('requestCertificate'), getMyRequests);

router.get('/my-eligibility', protect, authorize('student'), requireStudentNotRestricted('requestCertificate'), getMyCertificateEligibility);

// @desc    Approve certificate
// @route   POST /api/certificates/:id/approve
// @access  Private (Instructor/Admin)
router.post('/:id/approve', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('issueCertificates'), uploadCertificate.single('certificate'), scanFile, approveCertificate);

// @desc    Reject certificate
// @route   POST /api/certificates/:id/reject
// @access  Private (Instructor/Admin)
router.post('/:id/reject', protect, authorize('instructor', 'admin'), requireInstructorNotRestricted('issueCertificates'), [
  body('reason').optional().isString()
], rejectCertificate);

// @desc    Delete certificate request
// @route   DELETE /api/certificates/:id
// @access  Private (Admin)
router.delete('/:id', protect, authorize('admin'), deleteCertificateRequest);

module.exports = router;
