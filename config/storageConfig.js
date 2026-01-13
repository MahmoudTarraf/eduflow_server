const USE_YOUTUBE_ENV = process.env.USE_YOUTUBE === 'true';
const USE_YOUTUBE_FOR_VIDEOS_ENV = process.env.USE_YOUTUBE_FOR_VIDEOS === 'true';
const USE_TELEGRAM_ENV = process.env.USE_TELEGRAM === 'true';

// When USE_LOCAL_STORAGE is true, we ignore YouTube/Telegram and always use local.
// When unset, default to false so production deployments must opt-in explicitly.
const USE_LOCAL_STORAGE_ENV = process.env.USE_LOCAL_STORAGE === 'true';

const isLocalStorageEnabled = () => USE_LOCAL_STORAGE_ENV;
const isYouTubeEnabled = () => !isLocalStorageEnabled() && (USE_YOUTUBE_ENV || USE_YOUTUBE_FOR_VIDEOS_ENV);
const isTelegramEnabled = () => !isLocalStorageEnabled() && USE_TELEGRAM_ENV;

const getDefaultVideoStorageType = () => {
  if (isLocalStorageEnabled()) {
    return 'local';
  }
  if (isYouTubeEnabled()) {
    return 'youtube';
  }
  // Fallback to local for safety
  return 'local';
};

const getDefaultFileStorageType = () => {
  if (isLocalStorageEnabled()) {
    return 'local';
  }
  // Default to Telegram for file storage when not using local
  return 'telegram';
};

module.exports = {
  isYouTubeEnabled,
  isTelegramEnabled,
  isLocalStorageEnabled,
  getDefaultVideoStorageType,
  getDefaultFileStorageType
};
