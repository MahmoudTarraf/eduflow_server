/**
 * URL Helper Utility
 * Centralizes URL construction using environment variables
 * This allows easy switching between localhost and production (e.g., Cloudinary)
 */

/**
 * Get the base server URL from environment variables
 * @returns {string} Base server URL
 */
const getServerUrl = () => {
  return process.env.SERVER_URL || 'http://localhost:5000';
};

/**
 * Get the base client URL from environment variables
 * @returns {string} Base client URL
 */
const getClientUrl = () => {
  return process.env.CLIENT_URL || 'http://localhost:3000';
};

/**
 * Construct a full URL for an upload file
 * @param {string} path - Relative path (e.g., '/uploads/videos/file.mp4' or 'uploads/videos/file.mp4')
 * @returns {string} Full URL
 */
const constructFileUrl = (path) => {
  if (!path) return null;
  
  // If already a full URL (http:// or https://), return as is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  
  // Remove leading slash if present
  const cleanPath = path.startsWith('/') ? path.substring(1) : path;
  
  // Construct full URL using SERVER_URL
  return `${getServerUrl()}/${cleanPath}`;
};

/**
 * Construct a relative upload path (for database storage)
 * @param {string} folder - Upload folder (e.g., 'videos', 'certificates', 'receipts')
 * @param {string} filename - File name
 * @returns {string} Relative path (e.g., '/uploads/videos/file.mp4')
 */
const constructUploadPath = (folder, filename) => {
  return `/uploads/${folder}/${filename}`;
};

/**
 * Construct email verification URL
 * @param {string} token - Verification token
 * @returns {string} Full verification URL
 */
const constructVerificationUrl = (token) => {
  return `${getServerUrl()}/api/auth/verify-email/${token}`;
};

/**
 * Construct client-side redirect URL
 * @param {string} path - Client path (e.g., '/login', '/verify-success')
 * @returns {string} Full client URL
 */
const constructClientUrl = (path) => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${getClientUrl()}${cleanPath}`;
};

module.exports = {
  getServerUrl,
  getClientUrl,
  constructFileUrl,
  constructUploadPath,
  constructVerificationUrl,
  constructClientUrl
};
