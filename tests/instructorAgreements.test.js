const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../index');
const User = require('../models/User');
const InstructorAgreement = require('../models/InstructorAgreement');
const InstructorEarningsAgreement = require('../models/InstructorEarningsAgreement');
const AdminSettings = require('../models/AdminSettings');

describe('Instructor Agreements - GET /api/instructor-agreements/my-agreement', () => {
  let instructorUser;
  let instructorToken;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/eduflow-test');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      InstructorAgreement.deleteMany({}),
      InstructorEarningsAgreement.deleteMany({}),
      AdminSettings.deleteMany({})
    ]);
  });

  const loginInstructor = async (email, password = 'password123') => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    return res.body.token;
  };

  it('returns signupAgreement merged with earnings agreements when both exist', async () => {
    instructorUser = await User.create({
      name: 'Instructor With Agreements',
      email: 'instructor-agreements@test.com',
      password: 'password123',
      role: 'instructor',
      isEmailVerified: true,
      agreementPdfUrl: '/uploads/agreements/signup.pdf'
    });

    const agreedAt = new Date('2024-01-15T00:00:00Z');
    await InstructorAgreement.create({
      instructor: instructorUser._id,
      agreedToTerms: true,
      instructorPercentage: 80,
      agreementText: 'Initial signup agreement text',
      agreementVersion: 'v1.0',
      agreedAt,
      status: 'approved',
      reuploadAttempts: 1,
      introductionVideo: {
        originalName: 'intro.mp4',
        storedName: 'intro.mp4',
        url: '/uploads/videos/intro.mp4',
        mimeType: 'video/mp4',
        size: 1000000,
        duration: 300,
        uploadedAt: new Date('2024-01-15T01:00:00Z')
      }
    });

    const earningsAgreement = await InstructorEarningsAgreement.create({
      instructor: instructorUser._id,
      agreementType: 'custom',
      platformPercentage: 30,
      instructorPercentage: 70,
      status: 'approved',
      isActive: true,
      pdfUrl: '/uploads/earnings/earn1.pdf',
      version: 2
    });

    instructorToken = await loginInstructor(instructorUser.email);

    const res = await request(app)
      .get('/api/instructor-agreements/my-agreement')
      .set('Authorization', `Bearer ${instructorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { signupAgreement, activeAgreement, recentAgreements, currentEarningsSplit } = res.body.data;

    expect(signupAgreement).toBeDefined();
    expect(signupAgreement.status).toBe('approved');
    expect(signupAgreement.agreementPdfUrl).toContain('signup.pdf');
    expect(signupAgreement.reuploadAttempts).toBe(1);
    expect(signupAgreement.introductionVideo.url).toContain('/uploads/videos/intro.mp4');
    expect(new Date(signupAgreement.agreedAt).toISOString()).toBe(agreedAt.toISOString());

    expect(activeAgreement._id.toString()).toBe(earningsAgreement._id.toString());
    expect(currentEarningsSplit).toMatchObject({
      platformPercentage: 30,
      instructorPercentage: 70,
      agreementType: 'custom',
      agreementId: earningsAgreement._id.toString()
    });
    expect(Array.isArray(recentAgreements)).toBe(true);
    expect(recentAgreements.length).toBeGreaterThanOrEqual(1);
  });

  it('returns signupAgreement from User.agreementPdfUrl with global earnings split fallback when no signup doc exists', async () => {
    instructorUser = await User.create({
      name: 'Instructor Without Signup Doc',
      email: 'instructor-nodoc@test.com',
      password: 'password123',
      role: 'instructor',
      isEmailVerified: true,
      agreementPdfUrl: '/uploads/agreements/fallback.pdf'
    });

    instructorToken = await loginInstructor(instructorUser.email);

    const res = await request(app)
      .get('/api/instructor-agreements/my-agreement')
      .set('Authorization', `Bearer ${instructorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { signupAgreement, activeAgreement, recentAgreements, currentEarningsSplit } = res.body.data;

    expect(signupAgreement).toBeDefined();
    expect(signupAgreement.status).toBe('approved'); // default fallback
    expect(signupAgreement.agreementPdfUrl).toContain('fallback.pdf');
    expect(signupAgreement.introductionVideo).toBeNull();
    expect(signupAgreement.reuploadAttempts).toBe(0);
    expect(signupAgreement.agreedAt).toBeTruthy(); // falls back to user.createdAt

    expect(activeAgreement).toBeNull();
    expect(Array.isArray(recentAgreements)).toBe(true);
    expect(recentAgreements.length).toBe(0);
    expect(currentEarningsSplit).toMatchObject({
      platformPercentage: 30,
      instructorPercentage: 70,
      agreementType: 'global',
      agreementId: null
    });
  });
});
