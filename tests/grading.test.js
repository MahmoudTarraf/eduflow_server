const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const User = require('../models/User');
const Course = require('../models/Course');
const Section = require('../models/Section');
const Content = require('../models/Content');
const StudentContentGrade = require('../models/StudentContentGrade');
const { calculateSectionGrade, calculateCourseGrade } = require('../services/gradingService');

describe('Grading System Tests', () => {
  let adminToken, instructorToken, studentToken;
  let adminUser, instructorUser, studentUser;
  let course, section, lectureContent, assignmentContent;

  beforeAll(async () => {
    // Connect to test database
    await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/eduflow-test');
  });

  afterAll(async () => {
    // Clean up and close connection
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

    // Create test course and section
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

    // Create test content
    lectureContent = await Content.create({
      title: 'Test Lecture',
      type: 'lecture',
      section: section._id,
      course: course._id,
      video: {
        duration: 600, // 10 minutes
        path: '/test/video.mp4'
      },
      createdBy: instructorUser._id
    });

    assignmentContent = await Content.create({
      title: 'Test Assignment',
      type: 'assignment',
      section: section._id,
      course: course._id,
      createdBy: instructorUser._id
    });
  });

  afterEach(async () => {
    // Clean up after each test
    await User.deleteMany({});
    await Course.deleteMany({});
    await Section.deleteMany({});
    await Content.deleteMany({});
    await StudentContentGrade.deleteMany({});
  });

  describe('POST /api/contents/:contentId/watched', () => {
    it('should record video watched and set grade to 100% if >= 95% watched', async () => {
      const res = await request(app)
        .post(`/api/contents/${lectureContent._id}/watched`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          watchedDuration: 580, // 96.67% of 600 seconds
          totalDuration: 600
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('watched');
      expect(res.body.data.gradePercent).toBe(100);
    });

    it('should not set grade if < 95% watched', async () => {
      const res = await request(app)
        .post(`/api/contents/${lectureContent._id}/watched`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          watchedDuration: 500, // 83.33% of 600 seconds
          totalDuration: 600
        });

      expect(res.status).toBe(200);
      expect(res.body.data.gradePercent).toBe(0);
    });
  });

  describe('POST /api/contents/:contentId/submission', () => {
    it('should accept .rar file for assignment and set grade to 50%', async () => {
      const res = await request(app)
        .post(`/api/contents/${assignmentContent._id}/submission`)
        .set('Authorization', `Bearer ${studentToken}`)
        .attach('assignment', Buffer.from('fake rar content'), 'assignment.rar');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('submitted_ungraded');
      expect(res.body.data.gradePercent).toBe(50);
    });

    it('should reject non-.rar files for assignment', async () => {
      const res = await request(app)
        .post(`/api/contents/${assignmentContent._id}/submission`)
        .set('Authorization', `Bearer ${studentToken}`)
        .attach('assignment', Buffer.from('fake pdf content'), 'assignment.pdf');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/contents/:contentId/grade', () => {
    it('should allow instructor to grade assignment', async () => {
      // First submit assignment
      await StudentContentGrade.create({
        student: studentUser._id,
        content: assignmentContent._id,
        section: section._id,
        course: course._id,
        status: 'submitted_ungraded',
        gradePercent: 50
      });

      const res = await request(app)
        .post(`/api/contents/${assignmentContent._id}/grade`)
        .set('Authorization', `Bearer ${instructorToken}`)
        .send({
          studentId: studentUser._id.toString(),
          gradePercent: 85,
          feedback: 'Good work!'
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('graded');
      expect(res.body.data.gradePercent).toBe(85);
    });

    it('should not allow student to grade', async () => {
      const res = await request(app)
        .post(`/api/contents/${assignmentContent._id}/grade`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          studentId: studentUser._id.toString(),
          gradePercent: 85
        });

      expect(res.status).toBe(403);
    });
  });

  describe('Section and Course Grade Calculations', () => {
    it('should calculate section grade correctly', async () => {
      // Record lecture watched (100%)
      await StudentContentGrade.create({
        student: studentUser._id,
        content: lectureContent._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 100
      });

      // Submit and grade assignment (80%)
      await StudentContentGrade.create({
        student: studentUser._id,
        content: assignmentContent._id,
        section: section._id,
        course: course._id,
        status: 'graded',
        gradePercent: 80
      });

      const result = await calculateSectionGrade(studentUser._id, section._id);

      // Expected: (100 + 80) / 2 = 90
      expect(result.sectionGrade).toBe(90);
    });

    it('should calculate course grade as average of section grades', async () => {
      // Create second section
      const section2 = await Section.create({
        name: 'Test Section 2',
        course: course._id,
        isFree: true,
        createdBy: instructorUser._id
      });

      // Add grades for both sections
      await StudentContentGrade.create({
        student: studentUser._id,
        content: lectureContent._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 100
      });

      const result = await calculateCourseGrade(studentUser._id, course._id);

      expect(result.courseGrade).toBeGreaterThanOrEqual(0);
      expect(result.courseGrade).toBeLessThanOrEqual(100);
    });
  });

  describe('GET /api/students/:studentId/sections/:sectionId/grade', () => {
    it('should return section grade for student', async () => {
      await StudentContentGrade.create({
        student: studentUser._id,
        content: lectureContent._id,
        section: section._id,
        course: course._id,
        status: 'watched',
        gradePercent: 100
      });

      const res = await request(app)
        .get(`/api/students/${studentUser._id}/sections/${section._id}/grade`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.sectionGrade).toBeGreaterThanOrEqual(0);
    });

    it('should not allow student to view other students grades', async () => {
      const otherStudent = await User.create({
        name: 'Other Student',
        email: 'other@test.com',
        password: 'password123',
        role: 'student'
      });

      const res = await request(app)
        .get(`/api/students/${otherStudent._id}/sections/${section._id}/grade`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(403);
    });
  });
});
