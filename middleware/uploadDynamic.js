const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Base uploads directory
const baseUploadDir = path.join(__dirname, '..', 'uploads');

// Ensure base directory exists
if (!fs.existsSync(baseUploadDir)) {
  fs.mkdirSync(baseUploadDir, { recursive: true });
}

const useMemoryVideos =
  (process.env.USE_YOUTUBE === 'true' || process.env.USE_YOUTUBE_FOR_VIDEOS === 'true') &&
  process.env.USE_LOCAL_STORAGE !== 'true';

// Video storage - memory when YouTube-only, disk otherwise
const diskVideoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(baseUploadDir, 'videos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${timestamp}__${sanitized}`);
  }
});

const memoryVideoStorage = multer.memoryStorage();

const videoStorage = useMemoryVideos ? memoryVideoStorage : diskVideoStorage;

// File storage - goes to uploads/files/
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(baseUploadDir, 'files');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${timestamp}__${sanitized}`);
  }
});

// File filters
const videoFilter = (req, file, cb) => {
  console.log('[UploadFilter] Video filter check:', {
    filename: file.originalname,
    mimetype: file.mimetype,
    fieldname: file.fieldname
  });

  const allowedMimeTypes = [
    'video/mp4', 
    'video/webm', 
    'video/mkv', 
    'video/avi', 
    'video/mov',
    'video/x-matroska',
    'video/quicktime',
    'video/x-msvideo',
    'video/mpeg',
    'application/octet-stream' // Sometimes large videos are detected as this
  ];
  
  const allowedExtensions = /\.(mp4|webm|mkv|avi|mov|mpeg|mpg)$/i;
  
  if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
    console.log('[UploadFilter] Video file accepted');
    cb(null, true);
  } else {
    console.warn('[UploadFilter] Video file rejected:', file.originalname, file.mimetype);
    cb(new Error(`Invalid video format. File: ${file.originalname}, Type: ${file.mimetype}. Allowed: mp4, webm, mkv, avi, mov`), false);
  }
};

const rarFilter = (req, file, cb) => {
  console.log('[UploadFilter] Archive filter check:', {
    filename: file.originalname,
    mimetype: file.mimetype,
    fieldname: file.fieldname
  });

  const allowedExtensions = /\.(rar|zip)$/i;
  const allowedMimeTypes = [
    'application/x-rar-compressed',
    'application/octet-stream',
    'application/x-rar',
    'application/vnd.rar',
    'application/zip',
    'application/x-zip-compressed'
  ];
  
  // Primary check: file extension (most reliable for .rar/.zip files)
  if (allowedExtensions.test(file.originalname)) {
    console.log('[UploadFilter] Archive file accepted (by extension)');
    cb(null, true);
  } else if (allowedMimeTypes.includes(file.mimetype)) {
    console.log('[UploadFilter] Archive file accepted (by MIME type)');
    cb(null, true);
  } else {
    console.warn('[UploadFilter] Archive file rejected:', file.originalname, file.mimetype);
    cb(new Error(`Only .rar and .zip files are allowed. File: ${file.originalname}, Type: ${file.mimetype}`), false);
  }
};

// SECURITY: Helpers for env-based upload size limits. Configure explicit limits in production
// to reduce abuse/DoS risk from oversized uploads; defaults are for development convenience.
const toBytes = (mb, fallback) => {
  const n = parseInt(mb, 10);
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return v * 1024 * 1024;
};

const MAX_VIDEO_BYTES = toBytes(process.env.MAX_VIDEO_SIZE_MB, 1536); // default 1.5GB
const MAX_FILE_BYTES = toBytes(process.env.MAX_FILE_SIZE_MB, 500);   // default 500MB

// Multer configurations for different content types
const uploadLectureVideo = multer({
  storage: videoStorage,
  fileFilter: videoFilter,
  limits: {
    fileSize: MAX_VIDEO_BYTES
  }
});

const uploadAssignmentFile = multer({
  storage: fileStorage,
  fileFilter: rarFilter,
  limits: {
    fileSize: MAX_FILE_BYTES
  }
});

// Project files need mixed storage - memory for video when YouTube-only, disk for starter
const projectDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isVideo = file.fieldname === 'video';
    const uploadDir = path.join(baseUploadDir, isVideo ? 'videos' : 'files');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${timestamp}__${sanitized}`);
  }
});

const uploadProjectFiles = multer({
  storage: {
    _handleFile(req, file, cb) {
      if (useMemoryVideos && file.fieldname === 'video') {
        const chunks = [];
        file.stream.on('data', (chunk) => chunks.push(chunk));
        file.stream.on('end', () => {
          cb(null, {
            buffer: Buffer.concat(chunks),
            size: Buffer.concat(chunks).length,
            originalname: file.originalname,
            mimetype: file.mimetype
          });
        });
        file.stream.on('error', cb);
      } else {
        projectDiskStorage._handleFile(req, file, cb);
      }
    },
    _removeFile(req, file, cb) {
      if (useMemoryVideos && file.fieldname === 'video') {
        cb(null);
      } else {
        projectDiskStorage._removeFile(req, file, cb);
      }
    }
  },
  fileFilter: (req, file, cb) => {
    console.log('[UploadFilter] Project file filter:', {
      fieldname: file.fieldname,
      filename: file.originalname,
      mimetype: file.mimetype
    });

    // For projects: video OR rar file
    if (file.fieldname === 'video') {
      videoFilter(req, file, cb);
    } else if (file.fieldname === 'file' || file.fieldname === 'starter') {
      rarFilter(req, file, cb);
    } else {
      console.warn('[UploadFilter] Invalid field name for project:', file.fieldname);
      cb(new Error(`Invalid field name: ${file.fieldname}. Expected 'video' or 'file'`), false);
    }
  },
  limits: {
    fileSize: MAX_VIDEO_BYTES
  }
});

// Solution file upload (for assignment/project solutions)
const uploadSolutionFile = multer({
  storage: fileStorage,
  fileFilter: rarFilter,
  limits: {
    fileSize: MAX_FILE_BYTES
  }
});

// Error handling middleware
const handleDynamicUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `File too large. Maximum size: ${(process.env.MAX_VIDEO_SIZE_MB||1536)}MB for videos, ${(process.env.MAX_FILE_SIZE_MB||500)}MB for files`
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

module.exports = {
  uploadLectureVideo,
  uploadAssignmentFile,
  uploadProjectFiles,
  uploadSolutionFile,
  handleDynamicUploadError,
  baseUploadDir
};
