const { getDefaultVideoStorageType, getDefaultFileStorageType } = require('../../config/storageConfig');
const LocalFileService = require('./LocalFileService');
const YoutubeVideoService = require('./YoutubeVideoService');
const TelegramFileService = require('./TelegramFileService');

function getVideoProvider() {
  const type = getDefaultVideoStorageType();

  if (type === 'youtube') {
    return { type: 'youtube', service: YoutubeVideoService };
  }

  // Fallback and default
  return { type: 'local', service: LocalFileService };
}

function getFileProvider() {
  const type = getDefaultFileStorageType();

  if (type === 'telegram') {
    return { type: 'telegram', service: TelegramFileService };
  }

  // Fallback and default
  return { type: 'local', service: LocalFileService };
}

module.exports = {
  getVideoProvider,
  getFileProvider
};
