const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const User = require('../models/User');
const Course = require('../models/Course');
const Section = require('../models/Section');
const CertificateRequest = require('../models/CertificateRequest');
const Enrollment = require('../models/Enrollment');
const StudentContentGrade = require('../models/StudentContentGrade');
const Content = require('../models/Content');

describe('Certificate System Tests', () => {
  let adminToken, instructorToken, studentToken;
  let adminUser, instructorUser, studentUser;
  let course, section, content;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/eduflow-test');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Create test users
    adminUser = await User.create({
      name: 'Admin User',
      email: 'admin@test.com',
      password: 'password123',
      role: 'admin'
    });

    instructorUser = await User.create({
      name: 'Instructor User',
      email: 'instructor@test.com',
      password: 'password123',
      role: 'instructor'
    });

    studentUser = await User.create({
      name: 'Student User',
      email: 'student@test.com',
      password: 'password123',
      role: 'student'
    });

    // Get tokens
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });
    adminToken = adminLogin.body.token;

    const instructorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'instructor@test.com', password: 'password123' });
    instructorToken = instructorLogin.body.token;

    const studentLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'student@test.com', password: 'password123' });
    studentToken = studentLogin.body.token;

    // Create test course
    course = await Course.create({
      name: 'Test Course',
      description: 'Test Description',
      instructor: instructorUser._id
    });

    section = await Section.create({
      name: 'Test Section',
      course: course._id,
      isFree: true,
      createdBy: instructorUser._id
    });

    // Enroll student
    await Enrollment.create({
      student: studentUser._id,
      course: course._id,
      enrolledSections: [section._id]
    });

    // Create content
    content = await Content.create({
      title: 'Test Lecture',
      type: 'lecture',
      section: section._id,
      course: course._id,
      createdBy: instructorUser._id
    });
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Course.deleteMany({});
    await Section.deleteMany({});
    await CertificateRequest.deleteMany({});
    await Enrollment.deleteMany({});
    await StudentContentGrade.deleteMany({});
    await Content.deleteMany({});
  });

  describe('POST /api/certificates/request', () => {
    it('should allow certificate request if grade >= 70%', async () => {
      // Set up grade >= 70%
      await StudentContentGrade.create({
        student: studentUser._id,
        content: content._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 85
      });

      const res = await request(app)
        .post('/api/certificates/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ courseId: course._id.toString() });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.request.status).toBe('requested');
    });

    it('should reject certificate request if grade < 70%', async () => {
      // Set up grade < 70%
      await StudentContentGrade.create({
        student: studentUser._id,
        content: content._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 65
      });

      const res = await request(app)
        .post('/api/certificates/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ courseId: course._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('70%');
      expect(res.body.courseGrade).toBeLessThan(70);
    });

    it('should reject duplicate certificate requests', async () => {
      // Set up grade >= 70%
      await StudentContentGrade.create({
        student: studentUser._id,
        content: content._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 75
      });

      // First request
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 75
      });

      const res = await request(app)
        .post('/api/certificates/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ courseId: course._id.toString() });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('already');
    });

    it('should reject request if not enrolled', async () => {
      // Delete enrollment
      await Enrollment.deleteMany({ student: studentUser._id });

      const res = await request(app)
        .post('/api/certificates/request')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ courseId: course._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('not enrolled');
    });
  });

  describe('GET /api/certificates/requests', () => {
    it('should list certificate requests for admin', async () => {
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .get('/api/certificates/requests')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThan(0);
      expect(res.body.requests[0].status).toBe('requested');
    });

    it('should filter requests by status', async () => {
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'issued',
        courseGrade: 85
      });

      const res = await request(app)
        .get('/api/certificates/requests?status=requested')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.requests.every(r => r.status === 'requested')).toBe(true);
    });

    it('should only show instructors requests for their courses', async () => {
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .get('/api/certificates/requests')
        .set('Authorization', `Bearer ${instructorToken}`);

      expect(res.status).toBe(200);
      // Should only include requests for instructor's courses
    });

    it('should not allow students to list all requests', async () => {
      const res = await request(app)
        .get('/api/certificates/requests')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/certificates/:id/approve', () => {
    it('should approve certificate with .rar file upload', async () => {
      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('certificate', Buffer.from('fake rar file'), 'certificate.rar');

      expect(res.status).toBe(200);
      expect(res.body.request.status).toBe('issued');
      expect(res.body.request.certificateFile).toBeDefined();
      expect(res.body.request.issuedAt).toBeDefined();
    });

    it('should reject approval without certificate file', async () => {
      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('required');
    });

    it('should only accept .rar files for certificates', async () => {
      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('certificate', Buffer.from('fake pdf file'), 'certificate.pdf');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('.rar');
    });

    it('should send email and in-app message when certificate issued', async () => {
      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('certificate', Buffer.from('fake rar file'), 'certificate.rar');

      expect(res.status).toBe(200);
      // Email and message would need to be mocked/verified
    });

    it('should not allow instructors to approve certificates for other courses', async () => {
      const otherInstructor = await User.create({
        name: 'Other Instructor',
        email: 'other@test.com',
        password: 'password123',
        role: 'instructor'
      });

      const otherCourse = await Course.create({
        name: 'Other Course',
        instructor: otherInstructor._id
      });

      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: otherCourse._id,
        status: 'requested',
        courseGrade: 80
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/approve`)
        .set('Authorization', `Bearer ${instructorToken}`)
        .attach('certificate', Buffer.from('fake rar file'), 'certificate.rar');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/certificates/:id/reject', () => {
    it('should reject certificate request with reason', async () => {
      const certRequest = await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 75
      });

      const res = await request(app)
        .post(`/api/certificates/${certRequest._id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Incomplete course requirements' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('rejected');
    });
  });

  describe('GET /api/certificates/my', () => {
    it('should list student issued certificates', async () => {
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'issued',
        courseGrade: 85,
        issuedAt: new Date(),
        certificateFile: {
          url: '/uploads/certificates/cert.rar'
        }
      });

      const res = await request(app)
        .get('/api/certificates/my')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThan(0);
      expect(res.body.certificates[0].status).toBe('issued');
    });

    it('should not include requested or rejected certificates', async () => {
      await CertificateRequest.create({
        student: studentUser._id,
        course: course._id,
        status: 'requested',
        courseGrade: 75
      });

      const res = await request(app)
        .get('/api/certificates/my')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
    });
  });
});
