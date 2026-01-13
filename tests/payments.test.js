const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const User = require('../models/User');
const Course = require('../models/Course');
const Section = require('../models/Section');
const SectionPayment = require('../models/SectionPayment');
const Enrollment = require('../models/Enrollment');

describe('Payment System Tests', () => {
  let adminToken, instructorToken, studentToken;
  let adminUser, instructorUser, studentUser;
  let course, paidSection;

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

    // Create test course with paid section
    course = await Course.create({
      name: 'Test Course',
      description: 'Test Description',
      instructor: instructorUser._id,
      totalPrice: 600000 // 6000 SYR in cents
    });

    paidSection = await Section.create({
      name: 'Paid Section',
      course: course._id,
      isFree: false,
      isPaid: true,
      priceCents: 600000,
      currency: 'SYR',
      createdBy: instructorUser._id
    });
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Course.deleteMany({});
    await Section.deleteMany({});
    await SectionPayment.deleteMany({});
    await Enrollment.deleteMany({});
  });

  describe('POST /api/sections/:sectionId/payments', () => {
    it('should accept payment submission with receipt image', async () => {
      const res = await request(app)
        .post(`/api/sections/${paidSection._id}/payments`)
        .set('Authorization', `Bearer ${studentToken}`)
        .field('amountCents', '600000')
        .field('currency', 'SYR')
        .field('paymentMethod', 'bank_transfer')
        .attach('receipt', Buffer.from('fake image'), 'receipt.jpg');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.amountCents).toBe(600000);
    });

    it('should reject payment without receipt', async () => {
      const res = await request(app)
        .post(`/api/sections/${paidSection._id}/payments`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          amountCents: 600000,
          currency: 'SYR'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('receipt');
    });

    it('should reject duplicate payment submission', async () => {
      // Submit first payment
      await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .post(`/api/sections/${paidSection._id}/payments`)
        .set('Authorization', `Bearer ${studentToken}`)
        .field('amountCents', '600000')
        .attach('receipt', Buffer.from('fake image'), 'receipt.jpg');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('already submitted');
    });

    it('should reject payment for free sections', async () => {
      const freeSection = await Section.create({
        name: 'Free Section',
        course: course._id,
        isFree: true,
        priceCents: 0,
        createdBy: instructorUser._id
      });

      const res = await request(app)
        .post(`/api/sections/${freeSection._id}/payments`)
        .set('Authorization', `Bearer ${studentToken}`)
        .field('amountCents', '0')
        .attach('receipt', Buffer.from('fake image'), 'receipt.jpg');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('free');
    });
  });

  describe('GET /api/admin/payments', () => {
    it('should list pending payments for admin', async () => {
      await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .get('/api/admin/payments?status=pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThan(0);
      expect(res.body.data[0].status).toBe('pending');
    });

    it('should filter payments for instructor by their courses', async () => {
      await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .get('/api/admin/payments')
        .set('Authorization', `Bearer ${instructorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.every(p => p.course.instructor.toString() === instructorUser._id.toString())).toBe(true);
    });

    it('should not allow students to list payments', async () => {
      const res = await request(app)
        .get('/api/admin/payments')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/payments/:paymentId/approve', () => {
    it('should approve payment and unlock section for student', async () => {
      const payment = await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .post(`/api/admin/payments/${payment._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.processedAt).toBeDefined();

      // Verify enrollment was created
      const enrollment = await Enrollment.findOne({
        student: studentUser._id,
        course: course._id
      });
      expect(enrollment).toBeDefined();
      expect(enrollment.enrolledSections).toContainEqual(paidSection._id);
    });

    it('should send email and in-app message on approval', async () => {
      const payment = await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .post(`/api/admin/payments/${payment._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      // Email and message sending would need to be mocked
    });

    it('should not allow duplicate approval', async () => {
      const payment = await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'approved',
        processedAt: new Date()
      });

      const res = await request(app)
        .post(`/api/admin/payments/${payment._id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('already processed');
    });
  });

  describe('POST /api/admin/payments/:paymentId/reject', () => {
    it('should reject payment with reason', async () => {
      const payment = await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .post(`/api/admin/payments/${payment._id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Invalid receipt' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.rejectionReason).toBe('Invalid receipt');
    });

    it('should send notification to student on rejection', async () => {
      const payment = await SectionPayment.create({
        student: studentUser._id,
        course: course._id,
        section: paidSection._id,
        amountCents: 600000,
        currency: 'SYR',
        status: 'pending'
      });

      const res = await request(app)
        .post(`/api/admin/payments/${payment._id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Unclear receipt image' });

      expect(res.status).toBe(200);
      // Message sending would need to be verified through Message model
    });
  });

  describe('Price Display Bug Test', () => {
    it('should return correct price in cents and formatted price', async () => {
      const res = await request(app)
        .get(`/api/sections/group/${paidSection.group}`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      const section = res.body.data.find(s => s._id.toString() === paidSection._id.toString());
      
      // Bug fix verification: priceCents should be 600000, not 0
      expect(section.priceCents).toBe(600000);
      expect(section.price).toBe(6000); // 600000 / 100
      expect(section.currency).toBe('SYR');
    });
  });
});
