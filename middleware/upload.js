const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directories exist
const uploadDir = path.join(__dirname, '../uploads');
const videosDir = path.join(uploadDir, 'videos');
const filesDir = path.join(uploadDir, 'files');
const receiptsDir = path.join(uploadDir, 'receipts');
const certificatesDir = path.join(uploadDir, 'certificates');
const assignmentsDir = path.join(uploadDir, 'assignments');
const avatarsDir = path.join(uploadDir, 'avatars');

[uploadDir, videosDir, filesDir, receiptsDir, certificatesDir, assignmentsDir, avatarsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('✅ Created directory:', dir);
  }
});

// Configure storage for videos
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, videosDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const sanitized = file.originalname.replace(ext, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${sanitized}-${uniqueSuffix}${ext}`);
  }
});

// Configure storage for files (assignments, projects)
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, filesDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const sanitized = file.originalname.replace(ext, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${sanitized}-${uniqueSuffix}${ext}`);
  }
});

// Configure storage for receipts
const receiptStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, receiptsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `receipt-${uniqueSuffix}${ext}`);
  }
});

// Configure storage for certificates
const certificateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, certificatesDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `certificate-${uniqueSuffix}${ext}`);
  }
});

// Configure storage for assignments
const assignmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, assignmentsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname); // Preserve original extension (.rar or .zip)
    const sanitized = file.originalname.replace(ext, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    cb(null, `${sanitized}-${uniqueSuffix}${ext}`);
  }
});

// Configure storage for avatars
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${uniqueSuffix}${ext}`);
  }
});

// File filters
const videoFilter = (req, file, cb) => {
  // Check MIME type for videos
  const allowedMimes = ['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv'];
  const allowedExtensions = /\.(mp4|webm|mkv|mov|avi|wmv)$/i;
  
  const mimeValid = allowedMimes.includes(file.mimetype);
  const extValid = allowedExtensions.test(file.originalname);
  
  if (mimeValid && extValid) {
    cb(null, true);
  } else {
    cb(new Error('Invalid video format. Only video files are allowed (mp4, webm, mkv)'), false);
  }
};

const fileFilter = (req, file, cb) => {
  const allowedDocs = /\.(rar|zip|pdf|docx|pptx|doc|ppt|txt)$/i;
  if (allowedDocs.test(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file format. Allowed: rar, zip, pdf, docx, pptx, doc, ppt, txt'), false);
  }
};

// Filter for assignments - .rar and .zip files
const assignmentFilter = (req, file, cb) => {
  const archiveExtension = /\.(rar|zip)$/i;
  const allowedMimes = [
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/x-rar',
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream' // Some systems report this for rar/zip
  ];
  
  const extValid = archiveExtension.test(file.originalname);
  const mimeValid = allowedMimes.includes(file.mimetype);
  
  if (extValid || mimeValid) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file format. Only .rar and .zip files are allowed for assignments'), false);
  }
};

const receiptFilter = (req, file, cb) => {
  // Check both MIME and extension for receipts
  const allowedMimes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
  const allowedExtensions = /\.(jpg|jpeg|png|pdf)$/i;
  
  const mimeValid = allowedMimes.includes(file.mimetype);
  const extValid = allowedExtensions.test(file.originalname);
  
  if (mimeValid && extValid) {
    cb(null, true);
  } else {
    cb(new Error('Invalid receipt format. Allowed: JPEG, PNG, PDF'), false);
  }
};

// Certificate filter - PDF and image files
const certificateFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png'
  ];
  const allowedExtensions = /\.(pdf|jpg|jpeg|png)$/i;
  
  const mimeValid = allowedMimes.includes(file.mimetype);
  const extValid = allowedExtensions.test(file.originalname);
  
  if (mimeValid && extValid) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file format. Only PDF, JPG, or PNG files are allowed for certificates'), false);
  }
};

// Avatar filter - Only image files
const avatarFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  const allowedExtensions = /\.(jpg|jpeg|png|gif|webp)$/i;
  
  const mimeValid = allowedMimes.includes(file.mimetype);
  const extValid = allowedExtensions.test(file.originalname);
  
  if (mimeValid && extValid) {
    cb(null, true);
  } else {
    cb(new Error('Invalid image format. Allowed: JPG, PNG, GIF, WEBP'), false);
  }
};

// SECURITY: Read size limits from environment. Enforcing explicit limits reduces abuse risk
// (e.g., oversized uploads exhausting disk/memory). Defaults are generous for dev only.
const toBytes = (mb, fallback) => {
  const n = parseInt(mb, 10);
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return v * 1024 * 1024;
};

const MAX_VIDEO_BYTES = toBytes(process.env.MAX_VIDEO_SIZE_MB, 500); // Default 500MB (configure in prod)
const MAX_FILE_BYTES = toBytes(process.env.MAX_FILE_SIZE_MB, 100);   // Default 100MB (configure in prod)

// Multer upload configurations
const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFilter,
  limits: {
    fileSize: MAX_VIDEO_BYTES
  }
});

const uploadFile = multer({
  storage: fileStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_FILE_BYTES
  }
});

const uploadReceipt = multer({
  storage: receiptStorage,
  fileFilter: receiptFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  }
});

const uploadAssignment = multer({
  storage: assignmentStorage,
  fileFilter: assignmentFilter,
  limits: {
    fileSize: MAX_FILE_BYTES
  }
});

const uploadCertificate = multer({
  storage: certificateStorage,
  fileFilter: certificateFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max for certificates (PDF/images)
  }
});

const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: avatarFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max for avatars
  }
});

// Error handling middleware
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const isVideo = req?.file?.mimetype?.startsWith('video/');
      const maxMb = isVideo ? (process.env.MAX_VIDEO_SIZE_MB || 500) : (process.env.MAX_FILE_SIZE_MB || 100);
      return res.status(400).json({
        success: false,
        message: `File too large. Maximum allowed size is ${maxMb}MB.`
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`
    });
  } else if (err) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next();
};

// Generic upload for backward compatibility
const upload = uploadFile;

// Flexible upload for content updates (accepts both videos and files)
// Validation is handled by the controller based on content type
const uploadContentUpdate = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Determine destination based on mimetype
      if (file.mimetype.startsWith('video/')) {
        cb(null, videosDir);
      } else {
        cb(null, filesDir);
      }
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      const sanitized = file.originalname.replace(ext, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      cb(null, `${sanitized}-${uniqueSuffix}${ext}`);
    }
  }),
  limits: {
    fileSize: Math.max(MAX_VIDEO_BYTES, MAX_FILE_BYTES) // env-driven
  }
  // No fileFilter - controller handles validation
});

module.exports = { 
  upload, // Generic (defaults to file upload)
  uploadVideo, 
  uploadFile,
  uploadAssignment,
  uploadReceipt,
  uploadCertificate,
  uploadAvatar,
  uploadContentUpdate,
  handleMulterError,
  videosDir,
  filesDir,
  receiptsDir,
  certificatesDir,
  assignmentsDir,
  avatarsDir
};
