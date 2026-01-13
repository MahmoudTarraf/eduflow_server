const Content = require('../models/Content');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Group = require('../models/Group');
const { generateYouTubeEmbedUrl } = require('../utils/youtubeHelper');
const { createPlaybackToken, verifyPlaybackToken } = require('../utils/playbackToken');
const { getServerUrl } = require('../utils/urlHelper');

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// POST /api/secure/video/:contentId/session
// Creates a short-lived playback token and returns a relative secure URL
exports.createPlaybackSession = async (req, res) => {
  try {
    const { contentId } = req.params;
    if (!contentId) {
      return res.status(400).json({ success: false, message: 'Content ID is required' });
    }

    const content = await Content.findById(contentId).select('+video youtubeUrl isPublished deletionStatus course').lean();
    if (!content) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }

    if (req.user.role !== 'admin' && content.deletionStatus === 'deleted') {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }

    if (req.user.role === 'student' && !content.isPublished) {
      return res.status(404).json({ success: false, message: 'Content not found' });
    }

    if (req.user.role !== 'admin' && content.type !== 'lecture' && content.type !== 'project') {
      return res.status(400).json({ success: false, message: 'Secure video playback is only available for video content' });
    }

    const video = content.video || {};
    if (video.storageType !== 'youtube' || !video.youtubeVideoId) {
      return res.status(400).json({ success: false, message: 'Secure player is only available for hosted videos' });
    }

    if (req.user.role === 'student') {
      const enrollment = await Enrollment.findOne({
        student: req.user.id,
        course: content.course
      });

      const groupEnrollment = await Group.findOne({
        course: content.course,
        'students.student': req.user.id,
        'students.status': 'enrolled'
      });

      if (!enrollment && !groupEnrollment) {
        return res.status(403).json({
          success: false,
          message: 'You must be enrolled in this course to access this video'
        });
      }
    } else if (req.user.role === 'instructor') {
      const course = await require('../models/Course').findById(content.course).select('instructor').lean();
      if (!course || String(course.instructor) !== String(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this video'
        });
      }
    }

    const playbackToken = createPlaybackToken({
      userId: req.user.id,
      contentId,
      courseId: content.course,
      userName: req.user.name,
      userEmail: req.user.email
    });

    const securePath = `/secure/video/${contentId}?t=${encodeURIComponent(playbackToken)}`;
    const secureUrl = `${getServerUrl()}${securePath}`;

    return res.json({
      success: true,
      secureUrl
    });
  } catch (error) {
    console.error('createPlaybackSession error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create playback session'
    });
  }
};

// GET /secure/video/:contentId
// Returns minimal hardened HTML that embeds the YouTube player and communicates with parent via postMessage
exports.renderSecureVideoPage = async (req, res) => {
  try {
    const { contentId } = req.params;
    const token = req.query.t || req.query.token;

    if (!token) {
      return res.status(401).send('Missing playback token');
    }

    const { valid, payload, error } = verifyPlaybackToken(token);
    if (!valid || !payload || String(payload.cid) !== String(contentId)) {
      console.error('Invalid playback token:', error || 'CID mismatch');
      return res.status(401).send('Invalid or expired playback token');
    }

    const content = await Content.findById(contentId).select('title type video course isPublished deletionStatus').lean();
    if (!content) {
      return res.status(404).send('Content not found');
    }

    const user = await User.findById(payload.uid).lean();
    if (!user) {
      return res.status(401).send('Invalid or expired playback token');
    }

    if (user.role !== 'admin' && content.deletionStatus === 'deleted') {
      return res.status(404).send('Content not found');
    }

    if (user.role === 'student' && !content.isPublished) {
      return res.status(404).send('Content not found');
    }

    if (user.role === 'student') {
      const enrollment = await Enrollment.findOne({ student: user._id, course: content.course }).lean();
      const groupEnrollment = await Group.findOne({
        course: content.course,
        'students.student': user._id,
        'students.status': 'enrolled'
      }).lean();

      if (!enrollment && !groupEnrollment) {
        return res.status(403).send('You must be enrolled in this course to access this video');
      }
    } else if (user.role === 'instructor') {
      const course = await require('../models/Course').findById(content.course).select('instructor').lean();
      if (!course || String(course.instructor) !== String(user._id)) {
        return res.status(403).send('Not authorized to access this video');
      }
    }

    if ((content.type !== 'lecture' && content.type !== 'project') || !content.video || content.video.storageType !== 'youtube' || !content.video.youtubeVideoId) {
      return res.status(400).send('Secure player is only available for hosted video content');
    }

    const displayName = user?.name || 'Student';
    const displayEmail = user?.email || '';
    const watermarkText = `${displayName}${displayEmail ? ' • ' + displayEmail : ''}`;

    const origin = req.protocol + '://' + req.get('host');
    const embedUrl = generateYouTubeEmbedUrl(content.video.youtubeVideoId, {
      autoplay: 0,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      cc_load_policy: 0,
      disablekb: 1,
      playsinline: 1,
      enablejsapi: 1,
      origin
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(content.title || 'Secure Video')}</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #000;
      color: #fff;
      height: 100%;
      overflow: hidden;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #player-container {
      position: relative;
      width: 100vw;
      height: 100vh;
      background: #000;
      overflow: hidden;
    }
    #ytplayer {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: 0;
      pointer-events: none; /* Block direct interaction */
    }
    #watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-25deg);
      font-size: 1.1rem;
      color: rgba(255, 255, 255, 0.18);
      white-space: nowrap;
      pointer-events: none;
      user-select: none;
    }
    #watermark::before,
    #watermark::after {
      content: '${escapeHtml(watermarkText)}';
      position: absolute;
      left: -200%;
      right: -200%;
      opacity: 0.6;
    }
    #watermark::before { top: -4rem; }
    #watermark::after { bottom: -4rem; }

    #overlay-message {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.75);
      color: #fff;
      font-size: 0.9rem;
      text-align: center;
      padding: 1rem;
      z-index: 20;
    }
  </style>
  <script>
    // Disable context menu and common devtools/shortcut keys
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', function (e) {
      const key = e.key || '';
      if (
        key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (key === 'I' || key === 'J' || key === 'C')) ||
        (e.ctrlKey && key === 'S')
      ) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }, true);

    // Basic devtools heuristic (not bulletproof)
    (function () {
      let devtoolsOpen = false;
      const threshold = 160;
      setInterval(function () {
        const widthThreshold = window.outerWidth - window.innerWidth > threshold;
        const heightThreshold = window.outerHeight - window.innerHeight > threshold;
        const isOpen = widthThreshold || heightThreshold;
        if (isOpen !== devtoolsOpen) {
          devtoolsOpen = isOpen;
          if (devtoolsOpen) {
            const overlay = document.getElementById('overlay-message');
            if (overlay) {
              overlay.style.display = 'flex';
              overlay.textContent = 'For security reasons, video playback is paused while developer tools are open.';
            }
          } else {
            const overlay = document.getElementById('overlay-message');
            if (overlay) overlay.style.display = 'none';
          }
        }
      }, 1000);
    })();
  </script>
</head>
<body>
  <div id="player-container">
    <iframe
      id="ytplayer"
      src="${embedUrl}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen="false"
      referrerpolicy="no-referrer-when-downgrade"
    ></iframe>
    <div id="watermark">${escapeHtml(watermarkText)}</div>
    <div id="overlay-message"></div>
  </div>

  <script>
    // YouTube IFrame API + bridge to parent for custom controls
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    var player;
    var lastState;

    function postToParent(message) {
      try {
        window.parent.postMessage(message, '*');
      } catch (e) {
        // ignore
      }
    }

    function onYouTubeIframeAPIReady() {
      player = new YT.Player('ytplayer', {
        events: {
          onReady: function (event) {
            postToParent({ type: 'videoReady', duration: event.target.getDuration() });
            setInterval(function () {
              if (!player || !player.getCurrentTime) return;
              var current = player.getCurrentTime();
              var total = player.getDuration();
              postToParent({ type: 'timeUpdate', currentTime: current, duration: total });
            }, 500);
          },
          onStateChange: function (event) {
            var state = event.data;
            lastState = state;
            if (state === YT.PlayerState.PLAYING) {
              postToParent({ type: 'stateChange', state: 'playing' });
            } else if (state === YT.PlayerState.PAUSED) {
              postToParent({ type: 'stateChange', state: 'paused' });
            } else if (state === YT.PlayerState.BUFFERING) {
              postToParent({ type: 'stateChange', state: 'buffering' });
            } else if (state === YT.PlayerState.ENDED) {
              postToParent({ type: 'stateChange', state: 'ended' });
              postToParent({ type: 'videoEnded' });
            }
          }
        }
      });
    }

    window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

    // Listen for control messages from parent
    window.addEventListener('message', function (event) {
      var data = event.data || {};
      if (!player) return;
      switch (data.type) {
        case 'play':
          player.playVideo();
          break;
        case 'pause':
          player.pauseVideo();
          break;
        case 'seek':
          if (typeof data.time === 'number') player.seekTo(data.time, true);
          break;
        case 'setVolume':
          if (typeof data.volume === 'number') player.setVolume(Math.max(0, Math.min(100, data.volume)));
          break;
        case 'mute':
          player.mute();
          break;
        case 'unmute':
          player.unMute();
          break;
        case 'setPlaybackRate':
          if (typeof data.rate === 'number') player.setPlaybackRate(data.rate);
          break;
        default:
          break;
      }
    });

    // Pause on blur, resume on focus (optional)
    window.addEventListener('blur', function () {
      try { if (player && player.pauseVideo) player.pauseVideo(); } catch (e) {}
    });
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    console.error('renderSecureVideoPage error:', error);
    return res.status(500).send('Server error while rendering secure video');
  }
};
