const cloudinary = require('cloudinary').v2;

// Only configure Cloudinary if cloud storage is enabled
// This prevents "Invalid api_key" errors when using local storage
if (process.env.USE_CLOUD_STORAGE === 'true') {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  console.log('✅ Cloudinary configured for cloud storage');
} else {
  console.log('💾 Cloudinary disabled - Using local storage');
}

module.exports = cloudinary;
