const {
  isYouTubeEnabled,
  isTelegramEnabled,
  isLocalStorageEnabled,
  getDefaultVideoStorageType,
  getDefaultFileStorageType
} = require('../config/storageConfig');

exports.getStorageConfig = (req, res) => {
  try {
    const videoProvider = getDefaultVideoStorageType();
    const fileProvider = getDefaultFileStorageType();

    return res.json({
      success: true,
      data: {
        videoProvider,
        fileProvider,
        isYouTubeEnabled: isYouTubeEnabled(),
        isTelegramEnabled: isTelegramEnabled(),
        isLocalStorageEnabled: isLocalStorageEnabled()
      }
    });
  } catch (error) {
    console.error('[StorageConfig] Error reading storage config:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load storage configuration',
      error: error.message
    });
  }
};
