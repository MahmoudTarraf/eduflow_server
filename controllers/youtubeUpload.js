const fs = require('fs');
const { PassThrough } = require('stream');
const {
  getAuthUrl,
  getTokensFromCode,
  setCredentials,
  getYouTubeService,
  oauth2Client
} = require('../config/youtube');
const { ensureValidYouTubeToken } = require('../services/youtubeTokenService');
const YouTubeToken = require('../models/YouTubeToken');
const YouTubeVideo = require('../models/YouTubeVideo');
const Content = require('../models/Content');
const { encryptText, decryptText } = require('../utils/cryptoUtil');

function readTokenValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  try {
    return decryptText(value);
  } catch (_) {
    return null;
  }
}

function writeTokenValue(value) {
  if (!value) return null;
  try {
    return encryptText(value);
  } catch (_) {
    return value;
  }
}

function getClientBaseUrl(req) {
  const fallback = 'http://localhost:3000';
  const env = process.env.CLIENT_URL;
  if (env) return env.replace(/\/+$/, '');

  try {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
    if (host) return `${proto}://${host}`;
  } catch (_) {}

  return fallback;
}

function isAllowedPrivacyStatus(privacyStatus) {
  return privacyStatus === 'public' || privacyStatus === 'unlisted';
}

async function validateEmbeddableAndVisibility(youtube, videoId) {
  const resp = await youtube.videos.list({
    part: ['status'],
    id: videoId
  });

  const item = Array.isArray(resp?.data?.items) ? resp.data.items[0] : null;
  const status = item?.status || null;
  const embeddable = status?.embeddable;
  const privacyStatus = status?.privacyStatus;

  if (!status) {
    const e = new Error('YouTube video is not embeddable and will fail for students.');
    e.code = 'YT_VIDEO_NOT_EMBEDDABLE';
    throw e;
  }

  if (embeddable !== true || !isAllowedPrivacyStatus(privacyStatus)) {
    const e = new Error('YouTube video is not embeddable and will fail for students.');
    e.code = 'YT_VIDEO_NOT_EMBEDDABLE';
    e.details = { embeddable, privacyStatus };
    throw e;
  }
}

async function backfillHostedVideosFromContent() {
  try {
    const contentFilter = {
      deletionStatus: { $ne: 'deleted' },
      isLatestVersion: true,
      'video.storageType': 'youtube',
      'video.youtubeVideoId': { $exists: true, $ne: '' }
    };

    const idsRaw = await Content.distinct('video.youtubeVideoId', contentFilter);
    const ids = Array.from(new Set((idsRaw || []).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)));

    if (ids.length === 0) return;

    const existing = await YouTubeVideo.find({ youtubeVideoId: { $in: ids } }).select('youtubeVideoId').lean();
    const existingSet = new Set((existing || []).map((v) => v.youtubeVideoId));

    const missingIds = ids.filter((id) => !existingSet.has(id));
    if (missingIds.length === 0) return;

    const contentDocs = await Content.find({
      ...contentFilter,
      'video.youtubeVideoId': { $in: missingIds }
    })
      .select(
        'title description type course section group createdBy deletionStatus createdAt video.youtubeVideoId video.youtubeUrl video.originalName video.size video.uploadedAt video.uploadedBy'
      )
      .sort({ createdAt: -1 })
      .lean();

    if (!Array.isArray(contentDocs) || contentDocs.length === 0) return;

    const toInsert = [];
    for (const doc of contentDocs) {
      const youtubeVideoId = doc?.video?.youtubeVideoId ? String(doc.video.youtubeVideoId).trim() : '';
      if (!youtubeVideoId || existingSet.has(youtubeVideoId)) continue;
      existingSet.add(youtubeVideoId);

      const youtubeUrl = doc?.video?.youtubeUrl || `https://www.youtube.com/watch?v=${youtubeVideoId}`;
      const uploadedAt = doc?.video?.uploadedAt || doc?.createdAt || new Date();
      const uploadedByResolved = doc?.video?.uploadedBy || doc?.createdBy || null;
      const originalFilename = doc?.video?.originalName || `${doc?.title || youtubeVideoId}.mp4`;
      const fileSize = typeof doc?.video?.size === 'number' ? doc.video.size : undefined;

      toInsert.push({
        title: doc?.title || youtubeVideoId,
        description: doc?.description || '',
        youtubeVideoId,
        youtubeUrl,
        privacyStatus: 'unlisted',
        status: doc?.deletionStatus === 'deleted' ? 'orphaned' : 'active',
        statusChangedAt: new Date(),
        physicallyDeletedAt: null,
        uploadedBy: uploadedByResolved,
        course: doc?.course || null,
        section: doc?.section || null,
        group: doc?.group || null,
        content: doc?._id || null,
        originalFilename,
        fileSize,
        uploadedAt
      });
    }

    if (toInsert.length === 0) return;

    try {
      await YouTubeVideo.insertMany(toInsert, { ordered: false });
    } catch (_) {
      // Ignore duplicate insert races; this is best-effort backfill.
    }
  } catch (e) {
    console.error('YouTubeVideo backfill error:', e);
  }
}

/**
 * Initiate YouTube OAuth flow (admin-only platform token)
 * @route GET /api/youtube/auth
 * @access Private (Admin)
 */
exports.initiateYouTubeAuth = async (req, res) => {
  try {
    const authUrl = getAuthUrl('platform');

    const wantsJson =
      (req.query && req.query.mode === 'json') ||
      (typeof req.headers.accept === 'string' && req.headers.accept.includes('application/json'));

    if (wantsJson) {
      return res.json({
        success: true,
        message: 'Authorize the platform video hosting account',
        authUrl
      });
    }

    return res.redirect(authUrl);
  } catch (error) {
    console.error('YouTube auth initiation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate video hosting authentication'
    });
  }
};

exports.updateYouTubeVideoStatus = async (req, res) => {
  try {
    const { videoRecordId } = req.params;
    const { status } = req.body;

    const allowed = new Set(['active', 'superseded', 'pending_deletion', 'orphaned', 'physically_deleted']);
    if (!allowed.has(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const update = {
      status,
      statusChangedAt: new Date()
    };
    if (status === 'physically_deleted') {
      update.physicallyDeletedAt = new Date();
    }

    const video = await YouTubeVideo.findByIdAndUpdate(videoRecordId, update, { new: true })
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished');

    if (!video) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    return res.json({
      success: true,
      data: video
    });
  } catch (error) {
    console.error('Update YouTube video status error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update video status'
    });
  }
};

/**
 * Admin-only YouTube configuration summary
 * @route GET /api/youtube/admin/summary
 * @access Private (Admin)
 */
exports.getYouTubeAdminSummary = async (req, res) => {
  try {
    const tokenDoc = await YouTubeToken.findOne({ owner: 'platform' });

    const connected = !!tokenDoc;
    const status = tokenDoc?.connectionStatus || (connected ? 'CONNECTED' : 'DISCONNECTED');

    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const uploadsToday = await YouTubeVideo.countDocuments({ createdAt: { $gte: start, $lt: end } });
    const DAILY_LIMIT = 10000;
    const COST_UPLOAD = 1600;
    const quotaUsed = uploadsToday * COST_UPLOAD;
    const quotaRemaining = Math.max(0, DAILY_LIMIT - quotaUsed);

    const totalVideos = await YouTubeVideo.countDocuments({});
    const lastVideo = await YouTubeVideo.findOne({}).sort({ createdAt: -1 }).select('createdAt uploadedAt');

    res.json({
      success: true,
      connection: {
        connected,
        status,
        channelName: tokenDoc?.channelName || null,
        channelId: tokenDoc?.channelId || null,
        connectedEmail: tokenDoc?.connectedEmail || null,
        connectedAt: tokenDoc?.connectedAt || null,
        expiryDate: tokenDoc?.expiryDate || null
      },
      quota: {
        dailyLimit: DAILY_LIMIT,
        usedToday: quotaUsed,
        remainingToday: quotaRemaining,
        uploadsToday,
        warning: quotaRemaining < 2000
      },
      overview: {
        totalVideos,
        lastUploadAt: tokenDoc?.lastUploadAt || lastVideo?.uploadedAt || lastVideo?.createdAt || null,
        lastUploadStatus: tokenDoc?.lastUploadStatus || (lastVideo ? 'success' : null),
        lastUploadError: tokenDoc?.lastUploadError || null,
        youtubeStudioUrl: tokenDoc?.channelId ? `https://studio.youtube.com/channel/${tokenDoc.channelId}` : null
      }
    });
  } catch (error) {
    console.error('YouTube admin summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to load YouTube configuration' });
  }
};

/**
 * Handle YouTube OAuth callback
 * @route GET /api/youtube/callback
 * @access Public (OAuth callback)
 */
exports.handleYouTubeCallback = async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send('Authorization code missing');
    }

    const clientBase = getClientBaseUrl(req);

    // Exchange code for tokens
    const tokens = await getTokensFromCode(code);

    if (!tokens.refresh_token) {
      return res.status(400).send('Refresh token not received. Please revoke access and try again.');
    }

    // Best-effort: fetch channel info for UI.
    let channelId;
    let channelName;
    try {
      setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      const youtube = getYouTubeService();
      const resp = await youtube.channels.list({ part: ['snippet'], mine: true });
      const item = Array.isArray(resp?.data?.items) ? resp.data.items[0] : null;
      channelId = item?.id;
      channelName = item?.snippet?.title;
    } catch (_) {}

    await YouTubeToken.findOneAndUpdate(
      { owner: 'platform' },
      {
        accessToken: writeTokenValue(tokens.access_token),
        refreshToken: writeTokenValue(tokens.refresh_token),
        expiryDate: tokens.expiry_date,
        tokenType: tokens.token_type,
        scope: tokens.scope,
        channelId: channelId || undefined,
        channelName: channelName || undefined,
        connectedAt: new Date(),
        connectionStatus: 'CONNECTED'
      },
      { upsert: true, new: true }
    );

    return res.redirect(`${clientBase}/admin/youtube-configuration?status=success`);
  } catch (error) {
    console.error('❌ YouTube callback error:', error);
    const clientBase = getClientBaseUrl(req);
    return res.redirect(`${clientBase}/admin/youtube-configuration?status=error`);
  }
};

/**
 * Check YouTube connection status (platform token)
 * @route GET /api/youtube/status
 * @access Private (Instructor/Admin)
 */
exports.getYouTubeStatus = async (req, res) => {
  try {
    const tokenDoc = await ensureValidYouTubeToken();

    res.json({
      success: true,
      connected: true,
      status: tokenDoc.connectionStatus || 'CONNECTED',
      expiryDate: tokenDoc.expiryDate,
      message: 'Video hosting connected'
    });
  } catch (error) {
    if (error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') {
      console.error('YouTube status check error:', {
        code: error.code,
        message: error.message,
        cause: error.cause
      });
      return res.json({
        success: false,
        connected: false,
        status: error?.code === 'YT_REFRESH_FAILED' ? 'REAUTH_REQUIRED' : 'DISCONNECTED',
        message: 'Video hosting is not configured. Contact support.'
      });
    }

    console.error('YouTube status check error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check video hosting status'
    });
  }
};

/**
 * Upload video to YouTube
 * @route POST /api/youtube/upload
 * @access Private (Instructor/Admin) — uses platform token
 */
exports.uploadToYouTube = async (req, res) => {
  try {
    const {
      title,
      description,
      courseId,
      sectionId,
      groupId,
      contentId,
      privacyStatus = 'unlisted' // private, unlisted, public
    } = req.body;

    if (!isAllowedPrivacyStatus(privacyStatus)) {
      if (req.file?.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'YouTube video is not embeddable and will fail for students.'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Video file is required'
      });
    }

    if (!title) {
      if (req.file.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Video title is required'
      });
    }

    console.log('📤 Uploading video to YouTube:', req.file.originalname);

    // Ensure valid YouTube token
    const tokenDoc = await ensureValidYouTubeToken();
    
    // Set credentials
    setCredentials({
      access_token: tokenDoc.accessToken,
      refresh_token: tokenDoc.refreshToken
    });

    const youtube = getYouTubeService();

    const mediaBody = req.file.buffer
      ? (() => {
          const stream = new PassThrough();
          stream.end(req.file.buffer);
          return stream;
        })()
      : req.file.path
        ? fs.createReadStream(req.file.path)
        : null;

    if (!mediaBody) {
      throw new Error('Video file is required');
    }

    // Upload video to YouTube
    const uploadResponse = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description: description || '',
          categoryId: '27' // Education category
        },
        status: {
          privacyStatus,
          embeddable: true,
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: mediaBody
      }
    });

    const videoId = uploadResponse.data.id;
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    await validateEmbeddableAndVisibility(youtube, videoId);

    console.log('✅ YouTube upload successful:', youtubeUrl);

    // Delete local temporary file
    if (req.file.path) {
      await fs.promises.unlink(req.file.path).catch(err =>
        console.error('Failed to delete temp file:', err)
      );
    }

    // Store video metadata in database
    const videoRecord = await YouTubeVideo.create({
      title,
      description: description || '',
      youtubeVideoId: videoId,
      youtubeUrl,
      privacyStatus,
      uploadedBy: null,
      course: courseId || null,
      section: sectionId || null,
      group: groupId || null,
      content: contentId || null,
      originalFilename: req.file.originalname,
      fileSize: req.file.size
    });

    res.status(201).json({
      success: true,
      message: 'Video uploaded successfully',
      data: {
        video: videoRecord,
        youtubeUrl,
        videoId
      }
    });
  } catch (error) {
    console.error('❌ YouTube upload error:', error);

    // Clean up temp file if it exists
    if (req.file && req.file.path) {
      await fs.promises.unlink(req.file.path).catch(console.error);
    }

    if (error?.code === 'YT_VIDEO_NOT_EMBEDDABLE') {
      return res.status(400).json({
        success: false,
        message: 'YouTube video is not embeddable and will fail for students.'
      });
    }

    if ((error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED') && req.user?.role !== 'admin') {
      console.error('YouTube upload blocked (platform token issue):', {
        code: error.code,
        message: error.message,
        cause: error.cause
      });
      return res.status(500).json({
        success: false,
        message: 'Video uploads are temporarily disabled. Contact support.'
      });
    }

    res.status(500).json({
      success: false,
      message:
        error?.code === 'YT_NOT_CONFIGURED' || error?.code === 'YT_REFRESH_FAILED'
          ? 'Video uploads are temporarily disabled. Contact support.'
          : 'Failed to upload video',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Upload failed'
    });
  }
};

/**
 * Update YouTube video metadata
 * @route PUT /api/youtube/:videoRecordId
 * @access Private (Instructor/Admin - owner or admin only)
 */
exports.updateYouTubeVideo = async (req, res) => {
  try {
    const { videoRecordId } = req.params;
    const { title, description, privacyStatus } = req.body;

    const videoRecord = await YouTubeVideo.findById(videoRecordId);

    if (!videoRecord) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    // Check authorization (admin only for platform-owned uploads)
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this video'
      });
    }

    // Ensure valid YouTube token
    const tokenDoc = await ensureValidYouTubeToken();
    setCredentials({
      access_token: tokenDoc.accessToken,
      refresh_token: tokenDoc.refreshToken
    });

    const youtube = getYouTubeService();

    const nextPrivacyStatus = privacyStatus || videoRecord.privacyStatus;
    if (!isAllowedPrivacyStatus(nextPrivacyStatus)) {
      return res.status(400).json({
        success: false,
        message: 'YouTube video is not embeddable and will fail for students.'
      });
    }

    // Update on YouTube
    await youtube.videos.update({
      part: ['snippet', 'status'],
      requestBody: {
        id: videoRecord.youtubeVideoId,
        snippet: {
          title: title || videoRecord.title,
          description: description || videoRecord.description,
          categoryId: '27'
        },
        status: {
          privacyStatus: nextPrivacyStatus,
          embeddable: true,
          selfDeclaredMadeForKids: false
        }
      }
    });

    await validateEmbeddableAndVisibility(youtube, videoRecord.youtubeVideoId);

    // Update in database
    videoRecord.title = title || videoRecord.title;
    videoRecord.description = description || videoRecord.description;
    videoRecord.privacyStatus = nextPrivacyStatus;
    await videoRecord.save();

    res.json({
      success: true,
      message: 'Video updated successfully',
      data: videoRecord
    });
  } catch (error) {
    console.error('❌ Update YouTube video error:', error);

    if (error?.code === 'YT_VIDEO_NOT_EMBEDDABLE') {
      return res.status(400).json({
        success: false,
        message: 'YouTube video is not embeddable and will fail for students.'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update video',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Update failed'
    });
  }
};

/**
 * Delete video from YouTube
 * @route DELETE /api/youtube/:videoRecordId
 * @access Private (Instructor/Admin - owner or admin only)
 */
exports.deleteFromYouTube = async (req, res) => {
  try {
    const { videoRecordId } = req.params;

    const videoRecord = await YouTubeVideo.findById(videoRecordId);

    if (!videoRecord) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    // Admin-only: physical deletion from YouTube must be explicit and never automatic.
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this video'
      });
    }

    const activeRefs = await Content.countDocuments({
      deletionStatus: { $ne: 'deleted' },
      isLatestVersion: true,
      'video.storageType': 'youtube',
      'video.youtubeVideoId': videoRecord.youtubeId || videoRecord.youtubeVideoId
    });

    if (activeRefs > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete this YouTube video while it is still referenced by active content.'
      });
    }

    console.log('🗑️ Deleting from YouTube:', videoRecord.youtubeVideoId);

    // Ensure valid YouTube token
    const tokenDoc = await ensureValidYouTubeToken();
    setCredentials({
      access_token: tokenDoc.accessToken,
      refresh_token: tokenDoc.refreshToken
    });

    const youtube = getYouTubeService();

    // Delete from YouTube (best-effort). Even if this fails (already deleted / not found), we retain audit record.
    try {
      await youtube.videos.delete({
        id: videoRecord.youtubeVideoId
      });
    } catch (error) {
      const status = error?.code || error?.response?.status;
      if (![403, 404].includes(status)) {
        throw error;
      }
    }

    try {
      await YouTubeVideo.deleteOne({ _id: videoRecordId });
    } catch (dbError) {
      console.error('⚠️ Failed to delete local YouTube video record after YouTube deletion:', dbError);
    }

    res.json({
      success: true,
      message: 'Video deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete from YouTube error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete video',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Delete failed'
    });
  }
};

/**
 * Delete a YouTube video record from the platform database only.
 * This does NOT call the YouTube API.
 * Intended for cleaning up audit rows for already-physically-deleted videos.
 * @route DELETE /api/youtube/:videoRecordId/record
 * @access Private (Admin)
 */
exports.deleteYouTubeVideoRecord = async (req, res) => {
  try {
    const { videoRecordId } = req.params;

    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to remove this record'
      });
    }

    const videoRecord = await YouTubeVideo.findById(videoRecordId);
    if (!videoRecord) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    if (videoRecord.status !== 'physically_deleted') {
      return res.status(400).json({
        success: false,
        message: 'Only physically_deleted videos can be removed from the database'
      });
    }

    const activeRefs = await Content.countDocuments({
      deletionStatus: { $ne: 'deleted' },
      isLatestVersion: true,
      'video.storageType': 'youtube',
      'video.youtubeVideoId': videoRecord.youtubeVideoId
    });

    if (activeRefs > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove this record while it is still referenced by active content.'
      });
    }

    await YouTubeVideo.deleteOne({ _id: videoRecordId });

    return res.json({
      success: true,
      message: 'Video record removed'
    });
  } catch (error) {
    console.error('Delete YouTube video record error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to remove video record'
    });
  }
};

/**
 * Get all YouTube videos (with filters)
 * @route GET /api/youtube/videos
 * @access Private (Instructor/Admin)
 */
exports.getYouTubeVideos = async (req, res) => {
  try {
    const { courseId, sectionId, uploadedBy } = req.query;
    const query = {};

    await backfillHostedVideosFromContent();

    // Apply filters
    if (courseId) query.course = courseId;
    if (sectionId) query.section = sectionId;
    if (uploadedBy && req.user.role === 'admin') query.uploadedBy = uploadedBy;

    const videos = await YouTubeVideo.find(query)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished')
      .sort({ uploadedAt: -1 });

    res.json({
      success: true,
      count: videos.length,
      data: videos
    });
  } catch (error) {
    console.error('Get YouTube videos error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch videos'
    });
  }
};

/**
 * Get single YouTube video by ID
 * @route GET /api/youtube/:videoRecordId
 * @access Private
 */
exports.getYouTubeVideo = async (req, res) => {
  try {
    const { videoRecordId } = req.params;

    const video = await YouTubeVideo.findById(videoRecordId)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished');

    if (!video) {
      return res.status(404).json({
        success: false,
        message: 'Video not found'
      });
    }

    res.json({
      success: true,
      data: video
    });
  } catch (error) {
    console.error('Get YouTube video error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch video'
    });
  }
};

/**
 * Disconnect YouTube account
 * @route DELETE /api/youtube/disconnect
 * @access Private (Instructor)
 */
exports.disconnectYouTube = async (req, res) => {
  try {
    const tokenDoc = await YouTubeToken.findOne({ owner: 'platform' });

    if (tokenDoc) {
      const refreshToken = readTokenValue(tokenDoc.refreshToken);
      const accessToken = readTokenValue(tokenDoc.accessToken);

      // Best-effort revoke (ignore failures so admins can still disconnect locally).
      try {
        if (refreshToken) {
          await oauth2Client.revokeToken(refreshToken);
        } else if (accessToken) {
          await oauth2Client.revokeToken(accessToken);
        }
      } catch (_) {}
    }

    await YouTubeToken.findOneAndDelete({ owner: 'platform' });

    res.json({
      success: true,
      message: 'Video hosting account disconnected successfully'
    });
  } catch (error) {
    console.error('Disconnect YouTube error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect video hosting account'
    });
  }
};
