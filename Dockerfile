# EduFlow Server with ClamAV scanning
FROM node:18-slim

# Install ClamAV
RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-daemon ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Update AV databases
RUN freshclam || true

# App dir
WORKDIR /app

# Install server dependencies first for better layer caching
COPY server/package*.json ./server/
RUN cd server && npm install --only=production

# Copy server source
COPY server ./server

# Environment
ENV NODE_ENV=production

WORKDIR /app/server

# Expose default port
EXPOSE 10000

# Start server
CMD ["npm", "start"]
