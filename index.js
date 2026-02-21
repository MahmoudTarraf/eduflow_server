const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const helmet = require('helmet');
const { initTransporter } = require('./utils/sendEmail.js');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { sendEmail } = require('./utils/sendEmail.js');
require('dotenv').config();
const cookieParser = require('cookie-parser');
// SECURITY: Run configuration sanity checks in development to catch unsafe defaults early.
const { checkConfig, enforceCriticalConfig } = require('./utils/configCheck');
checkConfig();
enforceCriticalConfig();
const AdminSettings = require('./models/AdminSettings');
const { _runScheduledFullBackup } = require('./controllers/adminMaintenance');

const connectDB = require('./config/database');
const secureVideoController = require('./controllers/secureVideoController');

// Connect to database
connectDB();

(async () => {
  await initTransporter(); // ✅ runs once on startup
})();


const app = express();
const server = http.createServer(app);

const socketAllowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:3000'
].filter(Boolean);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (socketAllowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  
  try {
    const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);

    if (!secret) {
      return next(new Error('Authentication error: Server misconfigured'));
    }

    const decoded = jwt.verify(token, secret);
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    socket.userEmail = decoded.email;
    next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.userId} (${socket.userRole})`);
  
  // Join user's personal room
  socket.join(`user:${socket.userId}`);
  
  // Join admin room if admin or instructor
  if (socket.userRole === 'admin' || socket.userRole === 'instructor') {
    socket.join('admin');
  }
  
  // Handle joining group rooms
  socket.on('join_group', (groupId) => {
    socket.join(`group:${groupId}`);
    console.log(`User ${socket.userId} joined group ${groupId}`);
  });
  
  // Handle leaving group rooms
  socket.on('leave_group', (groupId) => {
    socket.leave(`group:${groupId}`);
    console.log(`User ${socket.userId} left group ${groupId}`);
  });
  
  // Handle sending messages
  socket.on('send_message', async (data) => {
    try {
      const Message = require('./models/Message');
      
      // Create message in database
      const message = await Message.create({
        sender: socket.userId,
        recipient: data.recipient,
        group: data.group,
        conversationType: data.conversationType,
        subject: data.subject,
        content: data.content,
        attachments: data.attachments || []
      });
      
      await message.populate('sender', 'name email avatar');
      
      // Emit to recipient
      if (data.conversationType === 'direct') {
        io.to(`user:${data.recipient}`).emit('receive_message', message);
      } else if (data.conversationType === 'group') {
        io.to(`group:${data.group}`).emit('receive_message', message);
      } else if (data.conversationType === 'admin') {
        io.to('admin').emit('receive_message', message);
      }
      
      // Confirm to sender
      socket.emit('message_sent', { success: true, message });
      
      console.log(`Message sent from ${socket.userId} to ${data.recipient || data.group}`);
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('message_error', { error: error.message });
    }
  });
  
  // Handle typing indicator
  socket.on('typing', (data) => {
    if (data.conversationType === 'direct') {
      io.to(`user:${data.recipient}`).emit('user_typing', { userId: socket.userId });
    } else if (data.conversationType === 'group') {
      socket.to(`group:${data.group}`).emit('user_typing', { userId: socket.userId });
    }
  });
  
  // Handle stop typing
  socket.on('stop_typing', (data) => {
    if (data.conversationType === 'direct') {
      io.to(`user:${data.recipient}`).emit('user_stop_typing', { userId: socket.userId });
    } else if (data.conversationType === 'group') {
      socket.to(`group:${data.group}`).emit('user_stop_typing', { userId: socket.userId });
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.userId}`);
  });
});

// Make io available to routes
app.set('io', io);

// Security middleware
app.use(helmet());

// Content Security Policy: restrict who can frame this app (for YouTube embed hardening)
app.use((req, res, next) => {
  const frameAncestors = [
    "'self'",
    'https://eduflow.com',
    'https://www.eduflow.com'
  ].join(' ');

  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors};`);
  next();
});

// Trust proxy headers (needed if X-Forwarded-For is set by a proxy/dev tool)
app.set('trust proxy', 1);

const readInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const getAuthUserIdForRateLimit = (req) => {
  const header = req?.headers?.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.split(' ')[1];
  if (!token) return null;

  const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'development-insecure-secret' : null);
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret);
    return decoded?.id ? String(decoded.id) : null;
  } catch (_) {
    return null;
  }
};

const RATE_LIMIT_WINDOW_MS = readInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000);
const RATE_LIMIT_AUTH_RPM = readInt(process.env.RATE_LIMIT_AUTH_RPM, 120);
const RATE_LIMIT_ANON_RPM = readInt(process.env.RATE_LIMIT_ANON_RPM, 60);
const RATE_LIMIT_UPLOAD_JOBS_AUTH_RPM = readInt(process.env.RATE_LIMIT_UPLOAD_JOBS_AUTH_RPM, 60);
const RATE_LIMIT_UPLOAD_JOBS_ANON_RPM = readInt(process.env.RATE_LIMIT_UPLOAD_JOBS_ANON_RPM, 20);

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: (req) => (getAuthUserIdForRateLimit(req) ? RATE_LIMIT_AUTH_RPM : RATE_LIMIT_ANON_RPM),
  keyGenerator: (req) => {
    const userId = getAuthUserIdForRateLimit(req);
    if (userId) return `user:${userId}`;
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: true,
  skip: (req) => {
    const path = String(req.originalUrl || req.url || '');
    if (path.startsWith('/api/video-upload-jobs')) return true;
    if (path.includes('/api/content/') && path.includes('/stream')) return true;
    return false;
  },
  message: { success: false, message: 'Too many requests, please try again shortly.' }
});

const uploadJobsLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: (req) => (getAuthUserIdForRateLimit(req) ? RATE_LIMIT_UPLOAD_JOBS_AUTH_RPM : RATE_LIMIT_UPLOAD_JOBS_ANON_RPM),
  keyGenerator: (req) => {
    const userId = getAuthUserIdForRateLimit(req);
    if (userId) return `user:${userId}`;
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: true,
  message: { success: false, message: 'Too many upload status requests, please try again shortly.' }
});

// Auth-specific rate limiting (login / password flows)
const authLoginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: 'Too many login attempts from this IP, please try again in a minute.'
});

const authSensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many authentication requests from this IP, please try again later.'
});

// Payout / earnings related rate limiting (abuse protection)
const payoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many payout-related requests from this IP, please slow down.'
});
const streamingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // allow 120 requests per minute for video chunks
  message: 'Video stream rate limit exceeded, please retry shortly.'
});
app.use('/api', apiLimiter);
app.use('/api/content/:contentId/stream', streamingLimiter);

// Attach auth-specific limiters
app.use('/api/auth/login', authLoginLimiter);
app.use('/api/auth/forgot-password', authSensitiveLimiter);
app.use('/api/auth/reset-password', authSensitiveLimiter);
app.use('/api/auth/verify-otp', authSensitiveLimiter);
app.use('/api/auth/resend-reset-otp', authSensitiveLimiter);
app.use('/api/auth/register', authSensitiveLimiter);
app.use('/api/auth/resend-verification', authSensitiveLimiter);

// Attach payout / earnings limiters
app.use('/api/payout-requests', payoutLimiter);

// CORS - Support both development and production
const allowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static files with CORS headers
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CLIENT_URL || 'http://localhost:3000');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  // Static cache headers (safe for media files)
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/instructorApplication')); // Instructor registration
app.use('/api', require('./routes/instructorApplication')); // Admin & instructor endpoints
app.use('/api/courses', require('./routes/courses'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/levels', require('./routes/levels'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/gamification', require('./routes/gamification'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/sections', require('./routes/sections'));
app.use('/api/content', require('./routes/content'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/users', require('./routes/users'));
app.use('/api/user-deletion', require('./routes/userDeletion')); // User deletion with cascade
app.use('/api/admin', require('./routes/adminPayments')); // Admin payment management
app.use('/api/instructors', require('./routes/instructors'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/videos', require('./routes/videoRoutes'));
app.use('/api/storage', require('./routes/storage'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api', require('./routes/sectionPayments'));
app.use('/api', require('./routes/grading'));
app.use('/api/active-tests', require('./routes/activeTest'));
app.use('/api', require('./routes/deleteRequests'));

// Balance management routes
app.use('/api/payments', require('./routes/balance'));

// New management routes
app.use('/api', require('./routes/groupManagement'));
app.use('/api', require('./routes/sectionManagement'));
app.use('/api', require('./routes/contentManagement'));
app.use('/api', require('./routes/paymentManagement'));
app.use('/api', require('./routes/progressManagement'));
app.use('/api/enroll', require('./routes/enroll'));
app.use('/api/admin/settings', require('./routes/adminSettings'));
app.use('/api/admin', require('./routes/adminMaintenance'));
app.use('/api/admin', require('./routes/adminDashboard'));
app.use('/api/admin/telegram-files', require('./routes/adminTelegramFiles'));

// Instructor payment and earnings routes
app.use('/api/instructor-earnings', require('./routes/instructorEarnings'));
app.use('/api/payout-requests', require('./routes/instructorPayouts'));
app.use('/api/instructor', require('./routes/instructorAgreement'));
app.use('/api/instructor', require('./routes/instructorSettings'));
app.use('/api/instructor', require('./routes/instructorDashboard')); // New route added
app.use('/api/admin/earnings', require('./routes/adminEarnings'));
app.use('/api/instructor-agreements', require('./routes/instructorEarningsAgreements'));

// Currency conversion routes
app.use('/api/currency', require('./routes/currency'));

// Policies routes (Privacy Policy & Terms of Service)
app.use('/api/policies', require('./routes/policies'));

// Cloud upload routes (Cloudinary + YouTube)
app.use('/api/youtube', require('./routes/youtubeUpload'));

app.use('/api/video-upload-jobs', uploadJobsLimiter, require('./routes/videoUploadJobs'));

// Secure video API routes (token-based playback sessions)
app.use('/api/secure', require('./routes/secureVideo'));

// Secure HTML route for YouTube iframe (used by custom secure player)
app.get('/secure/video/:contentId', secureVideoController.renderSecureVideoPage);

// Bootstrap: ensure an admin account exists using environment-based credentials
(async () => {
  try {
    const User = require('./models/User');
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || 'Primary Admin';

    if (!email || !password) {
      const msg = 'Admin bootstrap skipped: ADMIN_EMAIL and/or ADMIN_PASSWORD are not set.';
      // SECURITY: In production we avoid verbose warnings that may leak env misconfigurations.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(msg);
      } else {
        console.error(msg);
      }
      return;
    }

    let admin = await User.findActiveByEmail(email);
    if (!admin) {
      await User.create({
        name,
        email,
        password, // hashed by pre-save hook
        role: 'admin',
        isEmailVerified: true
      });
      console.log(`Admin account created for ${email}`);
    } else {
      // Ensure role and email verification; only reset password if explicitly requested
      admin.role = 'admin';
      admin.isEmailVerified = true;

      if (process.env.ADMIN_FORCE_RESET === 'true') {
        admin.password = password; // hashed by pre-save hook
      }

      await admin.save();
      console.log(`Admin account ensured for ${email}${process.env.ADMIN_FORCE_RESET === 'true' ? ' (password reset from env)' : ''}`);
    }
  } catch (e) {
    console.error('Admin bootstrap failed:', e.message);
  }
})();

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    success: true,
    message: 'EduFlow Academy API is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

const PORT = process.env.PORT || 5000;

// Set up discount expiry scheduler
const { expireDiscounts } = require('./utils/discountExpiry');

// Run discount expiry check immediately on startup
expireDiscounts().catch(err => console.error('Initial discount expiry check failed:', err));

// Run discount expiry check every hour
setInterval(() => {
  expireDiscounts().catch(err => console.error('Scheduled discount expiry check failed:', err));
}, 60 * 60 * 1000); // Every hour

server.listen(PORT, () => {
  console.log(`✅ Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  console.log(`✅ Socket.IO ready for real-time connections`);
  console.log(`✅ Discount expiry scheduler active (checks every hour)`);

  const enableAutoBackup = process.env.ENABLE_AUTOBACKUP === 'true';
  if (!enableAutoBackup) {
    console.log('ℹ️ Auto-backup scheduler disabled (ENABLE_AUTOBACKUP not true)');
    return;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const parsedDays = parseInt(process.env.AUTOBACKUP_TIME || '7', 10);
  const AUTO_BACKUP_DAYS = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;

  const runAutoBackupIfDue = async (reason) => {
    try {
      const settings = await AdminSettings.getSettings();
      const now = Date.now();
      const last = settings.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).getTime() : 0;
      const diffMs = last ? now - last : Infinity;
      const diffDays = diffMs === Infinity ? Infinity : diffMs / DAY_MS;

      if (last && diffDays < AUTO_BACKUP_DAYS) {
        console.log(`ℹ️ Auto-backup skipped (${reason}): last run ${diffDays.toFixed(2)} days ago (threshold ${AUTO_BACKUP_DAYS}d)`);
        return;
      }

      const result = await _runScheduledFullBackup();

      if (result.backupFilePath && fs.existsSync(result.backupFilePath)) {
        const backupFilename = `backup_${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;
        try {
          await sendEmail({
            email: process.env.ADMIN_EMAIL,
            subject: `EduFlow Backup (${new Date().toISOString()})`,
            message: 'Attached is the latest backup file.',
            attachments: [
              {
                filename: backupFilename,
                path: result.backupFilePath // sendEmail will read it as buffer
              }
            ]
          });
          console.log('📧 Backup email sent successfully.');
        } catch (emailErr) {
          console.error('⚠️ Failed to send backup email:', emailErr.message);
        }
      } else {
        console.warn('⚠️ Backup file missing or invalid, skipping email.');
      }

      // Save backup metadata
      settings.lastAutoBackupAt = new Date();
      settings.lastAutoBackupStatus = 'success';
      settings.lastAutoBackupSize = result.sizeBytes;
      settings.lastAutoBackupCollections = (result.collectionNames?.length) || 0;
      settings.lastAutoBackupError = undefined;
      await settings.save();

      console.log(`📦 Scheduled backup completed (${reason}) size=${result.sizeBytes} bytes, collections=${result.collectionNames?.length || 0}`);
    } catch (err) {
      console.error(`Scheduled backup failed (${reason}):`, err.message);
      try {
        const settings = await AdminSettings.getSettings();
        settings.lastAutoBackupStatus = 'failed';
        settings.lastAutoBackupError = err.message;
        await settings.save();
      } catch (persistErr) {
        console.error('Failed to persist scheduled-backup failure state:', persistErr.message);
      }
    }
  };

  runAutoBackupIfDue('startup');
  setInterval(() => runAutoBackupIfDue('interval'), DAY_MS);

  console.log(`✅ Auto-backup scheduler enabled (interval=${AUTO_BACKUP_DAYS} days, checked daily)`);
});