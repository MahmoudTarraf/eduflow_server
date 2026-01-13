const { google } = require('googleapis');
require('dotenv').config();

/**
 * YouTube OAuth2 Client Configuration
 * Platform-owned OAuth for uploads (single token)
 */

const resolveEnv = (primary, fallback) => primary || fallback || undefined;

const redirectUri =
  process.env.YT_REDIRECT_URI ||
  process.env.YOUTUBE_REDIRECT_URI ||
  'http://localhost:5000/api/youtube/callback';

const oauth2Client = new google.auth.OAuth2(
  resolveEnv(process.env.YT_CLIENT_ID, process.env.YOUTUBE_CLIENT_ID),
  resolveEnv(process.env.YT_CLIENT_SECRET, process.env.YOUTUBE_CLIENT_SECRET),
  redirectUri
);

// Scopes required for YouTube uploads
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

/**
 * Generate OAuth2 URL for instructor authentication
 * @param {string} userId - User ID to include in state parameter
 * @returns {string} Authorization URL
 */
function getAuthUrl(state = 'platform') {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    prompt: 'consent'
  });
}

/**
 * Get OAuth2 tokens from authorization code
 * @param {string} code - Authorization code from OAuth callback
 * @returns {Promise<Object>} Token object with access_token and refresh_token
 */
async function getTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * Set credentials for an authenticated request
 * @param {Object} tokens - Token object with access_token and refresh_token
 */
function setCredentials(tokens) {
  oauth2Client.setCredentials(tokens);
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object>} New access token
 */
async function refreshAccessToken(refreshToken) {
  oauth2Client.setCredentials({
    refresh_token: refreshToken
  });
  
  const { credentials } = await oauth2Client.refreshAccessToken();
  return credentials;
}

/**
 * Get YouTube service instance
 * @returns {Object} YouTube API service
 */
function getYouTubeService() {
  return google.youtube({
    version: 'v3',
    auth: oauth2Client
  });
}

module.exports = {
  oauth2Client,
  getAuthUrl,
  getTokensFromCode,
  setCredentials,
  refreshAccessToken,
  getYouTubeService,
  SCOPES
};
