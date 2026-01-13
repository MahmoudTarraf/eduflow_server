const test = require('node:test');
const assert = require('node:assert/strict');

const tokenModelPath = require.resolve('../models/YouTubeToken');
const youtubeConfigPath = require.resolve('../config/youtube');
const servicePath = require.resolve('../services/youtubeTokenService');

function setMock(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

let originalTokenModule;
let originalYoutubeModule;

test.beforeEach(() => {
  originalTokenModule = require.cache[tokenModelPath];
  originalYoutubeModule = require.cache[youtubeConfigPath];
  clearModule(servicePath);
});

test.afterEach(() => {
  if (originalTokenModule) require.cache[tokenModelPath] = originalTokenModule;
  else delete require.cache[tokenModelPath];

  if (originalYoutubeModule) require.cache[youtubeConfigPath] = originalYoutubeModule;
  else delete require.cache[youtubeConfigPath];

  clearModule(servicePath);
});

test('ensureValidYouTubeToken throws YT_NOT_CONFIGURED when token is missing', async () => {
  setMock(tokenModelPath, {
    findOne: async () => null
  });
  setMock(youtubeConfigPath, {
    refreshAccessToken: async () => {
      throw new Error('should not be called');
    }
  });

  const { ensureValidYouTubeToken } = require('../services/youtubeTokenService');

  await assert.rejects(
    () => ensureValidYouTubeToken(),
    (err) => {
      assert.equal(err.code, 'YT_NOT_CONFIGURED');
      return true;
    }
  );
});

test('ensureValidYouTubeToken returns token without refresh when not near expiry', async () => {
  const tokenDoc = {
    owner: 'platform',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiryDate: Date.now() + 60 * 60 * 1000,
    save: async () => {
      throw new Error('save should not be called');
    }
  };

  let refreshCalled = false;

  setMock(tokenModelPath, {
    findOne: async () => tokenDoc
  });
  setMock(youtubeConfigPath, {
    refreshAccessToken: async () => {
      refreshCalled = true;
      return { access_token: 'new', expiry_date: Date.now() + 3600_000 };
    }
  });

  const { ensureValidYouTubeToken } = require('../services/youtubeTokenService');
  const result = await ensureValidYouTubeToken();

  assert.equal(result, tokenDoc);
  assert.equal(refreshCalled, false);
});

test('ensureValidYouTubeToken refreshes token when expired', async () => {
  const now = Date.now();

  const tokenDoc = {
    owner: 'platform',
    accessToken: 'old_access',
    refreshToken: 'refresh',
    expiryDate: now - 1000,
    save: async () => {}
  };

  setMock(tokenModelPath, {
    findOne: async () => tokenDoc
  });

  const newExpiry = now + 3600_000;

  setMock(youtubeConfigPath, {
    refreshAccessToken: async () => ({ access_token: 'new_access', expiry_date: newExpiry })
  });

  const { ensureValidYouTubeToken } = require('../services/youtubeTokenService');
  const result = await ensureValidYouTubeToken();

  assert.equal(result.accessToken, 'new_access');
  assert.equal(result.expiryDate, newExpiry);
});

test('ensureValidYouTubeToken throws YT_REFRESH_FAILED when refresh fails', async () => {
  const tokenDoc = {
    owner: 'platform',
    accessToken: 'old_access',
    refreshToken: 'refresh',
    expiryDate: Date.now() - 1000,
    save: async () => {}
  };

  setMock(tokenModelPath, {
    findOne: async () => tokenDoc
  });
  setMock(youtubeConfigPath, {
    refreshAccessToken: async () => {
      throw new Error('refresh failed');
    }
  });

  const { ensureValidYouTubeToken } = require('../services/youtubeTokenService');

  await assert.rejects(
    () => ensureValidYouTubeToken(),
    (err) => {
      assert.equal(err.code, 'YT_REFRESH_FAILED');
      return true;
    }
  );
});
