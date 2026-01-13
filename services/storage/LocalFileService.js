const fs = require('fs');
const path = require('path');

function buildLocalVideoMeta(file, context = {}) {
  if (!file) {
    throw new Error('LocalFileService.buildLocalVideoMeta requires a file');
  }

  return {
    storageType: 'local',
    originalName: file.originalname,
    storedName: file.filename,
    path: file.path,
    localPath: file.path,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date(),
    uploadedBy: context.userId || context.uploadedBy || undefined
  };
}

function buildLocalFileMeta(file, context = {}) {
  if (!file) {
    throw new Error('LocalFileService.buildLocalFileMeta requires a file');
  }

  return {
    storageType: 'local',
    originalName: file.originalname,
    storedName: file.filename,
    path: file.path,
    localPath: file.path,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date(),
    uploadedBy: context.userId || context.uploadedBy || undefined
  };
}

async function uploadLessonVideo(file, context = {}) {
  return buildLocalVideoMeta(file, context);
}

async function uploadLessonFile(file, context = {}) {
  return buildLocalFileMeta(file, context);
}

async function getLessonFile(fileMeta) {
  if (!fileMeta || !fileMeta.localPath) {
    throw new Error('LocalFileService.getLessonFile requires fileMeta.localPath');
  }

  return {
    filePath: path.isAbsolute(fileMeta.localPath)
      ? fileMeta.localPath
      : path.resolve(__dirname, '..', '..', fileMeta.localPath),
    fileName: fileMeta.originalName || fileMeta.storedName || 'download'
  };
}

async function deleteLessonFile(fileMeta) {
  if (!fileMeta || !fileMeta.localPath) {
    return;
  }

  const targetPath = fileMeta.localPath;
  try {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  } catch (err) {
    console.error('[LocalFileService] Failed to delete local file:', {
      path: targetPath,
      error: err.message
    });
  }
}

module.exports = {
  uploadLessonVideo,
  uploadLessonFile,
  getLessonFile,
  deleteLessonFile
};
