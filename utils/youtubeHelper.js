/**
 * YouTube Helper Utilities
 * Extract video ID from various YouTube URL formats
 */

/**
 * Extract YouTube video ID from URL
 * Supports formats:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://www.youtube.com/v/VIDEO_ID
 * 
 * @param {string} url - YouTube URL
 * @returns {string|null} Video ID or null if invalid
 */
function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    // Remove whitespace
    url = url.trim();

    // Pattern 1: youtube.com/watch?v=VIDEO_ID
    let match = url.match(/[?&]v=([^&]+)/);
    if (match) return match[1];

    // Pattern 2: youtu.be/VIDEO_ID
    match = url.match(/youtu\.be\/([^?&]+)/);
    if (match) return match[1];

    // Pattern 3: youtube.com/embed/VIDEO_ID
    match = url.match(/youtube\.com\/embed\/([^?&]+)/);
    if (match) return match[1];

    // Pattern 4: youtube.com/v/VIDEO_ID
    match = url.match(/youtube\.com\/v\/([^?&]+)/);
    if (match) return match[1];

    // If no pattern matches, return null
    return null;
  } catch (error) {
    console.error('Error extracting YouTube video ID:', error);
    return null;
  }
}

/**
 * Validate YouTube URL
 * @param {string} url - YouTube URL to validate
 * @returns {boolean} True if valid YouTube URL
 */
function isValidYouTubeUrl(url) {
  const videoId = extractYouTubeVideoId(url);
  return videoId !== null && videoId.length >= 10; // YouTube IDs are typically 11 characters
}

/**
 * Generate YouTube embed URL
 * @param {string} videoId - YouTube video ID
 * @param {object} options - Embed options
 * @returns {string} Embed URL
 */
function generateYouTubeEmbedUrl(videoId, options = {}) {
  const {
    autoplay = 0,
    controls = 0, // Hide controls for custom player
    modestbranding = 1, // Hide YouTube logo
    rel = 0, // Don't show related videos
    cc_load_policy = 0, // Don't show captions by default
    iv_load_policy = 3, // Hide video annotations
    enablejsapi = 1, // Enable JavaScript API for custom controls
    disablekb = 1,
    playsinline = 1,
    origin = '' // Origin for security
  } = options;

  const params = new URLSearchParams({
    autoplay: autoplay.toString(),
    controls: controls.toString(),
    modestbranding: modestbranding.toString(),
    rel: rel.toString(),
    cc_load_policy: cc_load_policy.toString(),
    iv_load_policy: iv_load_policy.toString(),
    enablejsapi: enablejsapi.toString(),
    disablekb: disablekb.toString(),
    playsinline: playsinline.toString()
  });

  if (origin) {
    params.append('origin', origin);
  }

  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/**
 * Get YouTube thumbnail URL
 * @param {string} videoId - YouTube video ID
 * @param {string} quality - Thumbnail quality (default, mqdefault, hqdefault, sddefault, maxresdefault)
 * @returns {string} Thumbnail URL
 */
function getYouTubeThumbnail(videoId, quality = 'hqdefault') {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}

/**
 * Normalize YouTube URL to standard watch URL
 * @param {string} url - Any YouTube URL
 * @returns {string|null} Normalized watch URL or null if invalid
 */
function normalizeYouTubeUrl(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

module.exports = {
  extractYouTubeVideoId,
  isValidYouTubeUrl,
  generateYouTubeEmbedUrl,
  getYouTubeThumbnail,
  normalizeYouTubeUrl
};
