const fs = require('fs');
const path = require('path');
const Content = require('../models/Content');
const Enrollment = require('../models/Enrollment');
const Group = require('../models/Group');
const { generateYouTubeEmbedUrl } = require('../utils/youtubeHelper');
const { createPlaybackToken } = require('../utils/playbackToken');
const { getServerUrl } = require('../utils/urlHelper');

// Stream video - supports local, YouTube, and Cloudinary
exports.streamVideo = async (req, res) => {
  try {
    const { videoId } = req.params;
    
    // Try to find content by ID (videoId is actually contentId in new system)
    let content = await Content.findById(videoId).populate('course', 'instructor').lean();
    
    // If not found as content ID, treat as legacy filename
    if (!content) {
      // Legacy support: videoId is a filename
      const baseDir = path.join(__dirname, '../uploads/videos');
      const resolvedPath = path.resolve(baseDir, videoId);
      const baseResolved = path.resolve(baseDir) + path.sep;
      if (!resolvedPath.startsWith(baseResolved)) {
        return res.status(400).json({ success: false, message: 'Invalid video path' });
      }
      
      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ success: false, message: 'Video not found' });
      }

      // Stream local file (legacy behavior)
      return streamLocalVideo(resolvedPath, req, res);
    }

    if (req.user?.role !== 'admin' && content.deletionStatus === 'deleted') {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    if (req.user?.role === 'student' && !content.isPublished) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    const courseId = content?.course?._id || content?.course;
    if (req.user?.role === 'student') {
      const enrollment = await Enrollment.findOne({ student: req.user.id, course: courseId }).lean();
      const groupEnrollment = await Group.findOne({
        course: courseId,
        'students.student': req.user.id,
        'students.status': 'enrolled'
      }).lean();

      if (!enrollment && !groupEnrollment) {
        return res.status(403).json({
          success: false,
          message: 'You must be enrolled in this course to access this video'
        });
      }
    } else if (req.user?.role === 'instructor') {
      if (!content.course || String(content.course.instructor) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this content' });
      }
    }

    // Check storage type and handle accordingly
    const storageType = content.video?.storageType || 'local';

    // YouTube - Return metadata for iframe embedding
    if (storageType === 'youtube') {
      if (req.user?.role !== 'admin') {
        if (content.type !== 'lecture' || !content.video?.youtubeVideoId) {
          return res.status(400).json({
            success: false,
            message: 'Hosted video playback is only available for lecture content'
          });
        }

        const playbackToken = createPlaybackToken({
          userId: req.user.id,
          contentId: content._id,
          courseId,
          userName: req.user.name,
          userEmail: req.user.email
        });
        const securePath = `/secure/video/${content._id}?t=${encodeURIComponent(playbackToken)}`;
        const secureUrl = `${getServerUrl()}${securePath}`;

        return res.json({
          success: true,
          storageType: 'hosted',
          secureUrl,
          title: content.title
        });
      }

      const embedUrl = generateYouTubeEmbedUrl(content.video.youtubeVideoId, {
        autoplay: 0,
        controls: 0, // Hide controls for custom player
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
        cc_load_policy: 0,
        disablekb: 1,
        playsinline: 1,
        enablejsapi: 1,
        origin: req.headers.origin || process.env.CLIENT_URL || 'http://localhost:3000'
      });

      return res.json({
        success: true,
        storageType: 'youtube',
        videoId: content.video.youtubeVideoId,
        youtubeUrl: content.video.youtubeUrl,
        embedUrl,
        title: content.title
      });
    }

    // Cloudinary - Redirect to Cloudinary URL
    if (storageType === 'cloudinary') {
      if (!content.video.cloudinaryUrl) {
        return res.status(404).json({ 
          success: false, 
          message: 'Cloudinary URL not found' 
        });
      }

      return res.json({
        success: true,
        storageType: 'cloudinary',
        videoUrl: content.video.cloudinaryUrl,
        title: content.title
      });
    }

    // Local - Stream from local file system
    if (storageType === 'local') {
      const videoPath = content.video.path || 
                       content.video.localPath || 
                       path.join(__dirname, '../uploads/videos', content.video.storedName);
      
      if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ 
          success: false, 
          message: 'Local video file not found' 
        });
      }

      return streamLocalVideo(videoPath, req, res);
    }

    // Unknown storage type
    return res.status(400).json({
      success: false,
      message: 'Unknown video storage type'
    });

  } catch (error) {
    console.error('Error streaming video:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * Stream local video file with range support
 */
function streamLocalVideo(videoPath, req, res) {
  const videoSize = fs.statSync(videoPath).size;
  const range = req.headers.range;

  if (range) {
    // Parse Range header: bytes=start-end
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;
    const chunkSize = (end - start) + 1;
    
    // Create read stream for the specified range
    const file = fs.createReadStream(videoPath, { start, end });
    
    // Set headers for partial content
    const headers = {
      'Content-Range': `bytes ${start}-${end}/${videoSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    };

    res.writeHead(206, headers);
    file.pipe(res);
  } else {
    // If no range header, send the whole video (not recommended for large files)
    const headers = {
      'Content-Length': videoSize,
      'Content-Type': 'video/mp4',
    };
    
    res.writeHead(200, headers);
    fs.createReadStream(videoPath).pipe(res);
  }
}
