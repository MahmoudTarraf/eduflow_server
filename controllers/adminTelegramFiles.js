const https = require('https');

const TelegramFile = require('../models/TelegramFile');
const Content = require('../models/Content');
const { streamTelegramFile } = require('../services/telegramFileService');

const getTelegramBotToken = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const getTelegramChannelId = () => String(process.env.TELEGRAM_CHANNEL_ID || '').trim();

function parseJsonSafely(data) {
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

function telegramGet(pathname, params = {}) {
  const token = getTelegramBotToken();
  if (!token) {
    const e = new Error('Telegram bot token is not configured');
    e.code = 'TELEGRAM_MISCONFIGURED';
    throw e;
  }

  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && `${v}`.length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

  const path = `/bot${token}/${pathname}${qs ? `?${qs}` : ''}`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.telegram.org',
        path,
        method: 'GET'
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const json = parseJsonSafely(data);
          if (!json) {
            return reject(new Error('Telegram response was not valid JSON'));
          }
          if (!json.ok) {
            const err = new Error(json.description || 'Telegram request failed');
            err.status = json.error_code || res.statusCode;
            err.telegram = { error_code: json.error_code, description: json.description };
            return reject(err);
          }
          return resolve(json.result);
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.end();
  });
}

function telegramPost(pathname, body = {}) {
  const token = getTelegramBotToken();
  if (!token) {
    const e = new Error('Telegram bot token is not configured');
    e.code = 'TELEGRAM_MISCONFIGURED';
    throw e;
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/${pathname}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const json = parseJsonSafely(data);
        if (!json) {
          return reject(new Error('Telegram response was not valid JSON'));
        }
        if (!json.ok) {
          const err = new Error(json.description || 'Telegram request failed');
          err.status = json.error_code || res.statusCode;
          err.telegram = { error_code: json.error_code, description: json.description };
          return reject(err);
        }
        return resolve(json.result);
      });
    });

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

async function getBotStatus() {
  const token = getTelegramBotToken();
  const channelId = getTelegramChannelId();

  const base = {
    tokenConfigured: Boolean(token),
    channelConfigured: Boolean(channelId),
    checkedAt: new Date()
  };

  if (!token) {
    return {
      ...base,
      tokenStatus: 'missing',
      bot: null,
      permissions: null,
      lastSuccessfulConnection: null
    };
  }

  try {
    const me = await telegramGet('getMe');
    const bot = {
      id: me?.id,
      username: me?.username,
      firstName: me?.first_name
    };

    let permissions = null;
    if (channelId && bot?.id) {
      try {
        const member = await telegramGet('getChatMember', {
          chat_id: channelId,
          user_id: bot.id
        });
        permissions = {
          status: member?.status,
          canDeleteMessages: member?.can_delete_messages,
          canManageChat: member?.can_manage_chat
        };
      } catch (_) {
        permissions = null;
      }
    }

    return {
      ...base,
      tokenStatus: 'ok',
      bot,
      permissions,
      lastSuccessfulConnection: new Date()
    };
  } catch (err) {
    return {
      ...base,
      tokenStatus: 'invalid',
      bot: null,
      permissions: null,
      lastSuccessfulConnection: null
    };
  }
}

function normalizeSort(sortBy, sortDir) {
  const allowed = new Set(['uploadedAt', 'fileSize', 'fileName', 'status', 'createdAt']);
  const sortField = allowed.has(sortBy) ? sortBy : 'uploadedAt';
  const dir = String(sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  return { [sortField]: dir };
}

exports.getTelegramFiles = async (req, res) => {
  try {
    const {
      status,
      courseId,
      uploadedBy,
      q,
      sortBy,
      sortDir,
      page,
      limit
    } = req.query;

    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (courseId) {
      query.course = courseId;
    }

    if (uploadedBy) {
      query.uploadedBy = uploadedBy;
    }

    if (q && String(q).trim()) {
      const term = String(q).trim();
      query.$or = [
        { fileName: { $regex: term, $options: 'i' } },
        { telegramFileId: { $regex: term, $options: 'i' } }
      ];
    }

    const safeLimitRaw = Number.parseInt(limit || '100', 10);
    const safeLimit = Number.isFinite(safeLimitRaw) && safeLimitRaw > 0 && safeLimitRaw <= 500 ? safeLimitRaw : 100;
    const safePageRaw = Number.parseInt(page || '1', 10);
    const safePage = Number.isFinite(safePageRaw) && safePageRaw > 0 ? safePageRaw : 1;
    const skip = (safePage - 1) * safeLimit;

    const [total, rows] = await Promise.all([
      TelegramFile.countDocuments(query),
      TelegramFile.find(query)
        .sort(normalizeSort(sortBy, sortDir))
        .skip(skip)
        .limit(safeLimit)
        .populate('uploadedBy', 'name email')
        .populate('course', 'name')
        .populate('group', 'name')
        .populate('section', 'name')
        .populate('content', 'title type deletionStatus isPublished')
        .lean()
    ]);

    return res.json({
      success: true,
      data: rows,
      meta: {
        total,
        page: safePage,
        limit: safeLimit
      }
    });
  } catch (error) {
    console.error('[AdminTelegramFiles] getTelegramFiles error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load files' });
  }
};

exports.getTelegramFilesSummary = async (req, res) => {
  try {
    const [total, active, softDeleted, changed, deleted, bot] = await Promise.all([
      TelegramFile.countDocuments({}),
      TelegramFile.countDocuments({ status: 'active' }),
      TelegramFile.countDocuments({ status: 'soft_deleted' }),
      TelegramFile.countDocuments({ status: 'changed' }),
      TelegramFile.countDocuments({ status: 'deleted' }),
      getBotStatus()
    ]);

    return res.json({
      success: true,
      data: {
        counts: {
          total,
          active,
          softDeleted,
          changed,
          deleted
        },
        bot
      }
    });
  } catch (error) {
    console.error('[AdminTelegramFiles] getTelegramFilesSummary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
};

exports.downloadTelegramFile = async (req, res) => {
  try {
    const record = await TelegramFile.findById(req.params.id).lean();
    if (!record) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    if (record.downloadOverrideUrl && String(record.downloadOverrideUrl).trim()) {
      return res.redirect(String(record.downloadOverrideUrl).trim());
    }

    if (!record.telegramFileId) {
      return res.status(400).json({ success: false, message: 'File is missing Telegram file id' });
    }

    return streamTelegramFile(record.telegramFileId, res, {
      asAttachment: true,
      filename: record.fileName
    });
  } catch (error) {
    console.error('[AdminTelegramFiles] downloadTelegramFile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to download file' });
  }
};

exports.updateTelegramFile = async (req, res) => {
  try {
    const { downloadOverrideUrl, telegramFileId, telegramMessageId, telegramChatId, fileName, fileSize } = req.body || {};

    const update = {};
    if (downloadOverrideUrl !== undefined) update.downloadOverrideUrl = String(downloadOverrideUrl || '').trim();
    if (telegramFileId !== undefined) update.telegramFileId = String(telegramFileId || '').trim();
    if (telegramChatId !== undefined) update.telegramChatId = String(telegramChatId || '').trim();
    if (telegramMessageId !== undefined && telegramMessageId !== null && telegramMessageId !== '') {
      const n = Number(telegramMessageId);
      if (Number.isFinite(n)) update.telegramMessageId = n;
    }
    if (fileName !== undefined) update.fileName = String(fileName || '').trim() || 'file';
    if (fileSize !== undefined && fileSize !== null && fileSize !== '') {
      const n = Number(fileSize);
      if (Number.isFinite(n)) update.fileSize = n;
    }

    const record = await TelegramFile.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    )
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('group', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished');

    if (!record) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    return res.json({ success: true, data: record });
  } catch (error) {
    console.error('[AdminTelegramFiles] updateTelegramFile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update file' });
  }
};

exports.softDeleteTelegramFile = async (req, res) => {
  try {
    const record = await TelegramFile.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    if (record.status === 'soft_deleted') {
      return res.json({ success: true, data: record });
    }

    record.status = 'soft_deleted';
    record.statusChangedAt = new Date();
    record.softDeletedAt = new Date();
    record.softDeletedBy = req.user?._id || req.user?.id;
    await record.save();

    if (record.content) {
      const content = await Content.findById(record.content).select('file.telegramFileId deletionStatus isPublished');
      if (
        content &&
        content.file &&
        content.file.telegramFileId &&
        record.telegramFileId &&
        String(content.file.telegramFileId) === String(record.telegramFileId) &&
        content.deletionStatus !== 'deleted'
      ) {
        content.isPublished = false;
        content.deletionStatus = 'deleted';
        content.deletedAt = new Date();
        content.deletedBy = req.user?._id || req.user?.id;
        await content.save();
      }
    }

    const populated = await TelegramFile.findById(record._id)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('group', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished');

    return res.json({ success: true, data: populated });
  } catch (error) {
    console.error('[AdminTelegramFiles] softDeleteTelegramFile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to soft delete file' });
  }
};

exports.physicalDeleteTelegramFile = async (req, res) => {
  try {
    const record = await TelegramFile.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const chatId = record.telegramChatId || getTelegramChannelId();
    const messageId = record.telegramMessageId;

    if (!chatId || !messageId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete this file from Telegram because message id/chat id is missing'
      });
    }

    try {
      await telegramPost('deleteMessage', {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (e) {
      console.error('[AdminTelegramFiles] deleteMessage failed:', e);
      return res.status(502).json({ success: false, message: 'Failed to delete from Telegram' });
    }

    record.status = 'deleted';
    record.statusChangedAt = new Date();
    record.deletedAt = new Date();
    record.deletedBy = req.user?._id || req.user?.id;
    await record.save();

    const populated = await TelegramFile.findById(record._id)
      .populate('uploadedBy', 'name email')
      .populate('course', 'name')
      .populate('group', 'name')
      .populate('section', 'name')
      .populate('content', 'title type deletionStatus isPublished');

    return res.json({ success: true, data: populated, message: 'File deleted' });
  } catch (error) {
    console.error('[AdminTelegramFiles] physicalDeleteTelegramFile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete file' });
  }
};
