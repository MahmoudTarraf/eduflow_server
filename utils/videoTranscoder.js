const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const SUPPORTED_VIDEO_CODECS = ['h264', 'vp8', 'vp9'];
const SUPPORTED_AUDIO_CODECS = ['aac', 'mp3', 'vorbis', 'opus'];

const needsTranscoding = (metadata = {}) => {
  const streams = metadata?.streams || [];
  const formatName = metadata?.format?.format_name || '';
  let videoStream = null;
  let audioStream = null;

  for (const stream of streams) {
    if (stream.codec_type === 'video' && !videoStream) {
      videoStream = stream;
    }
    if (stream.codec_type === 'audio' && !audioStream) {
      audioStream = stream;
    }
  }

  const videoOk = SUPPORTED_VIDEO_CODECS.includes(videoStream?.codec_name);
  const audioOk = !audioStream || SUPPORTED_AUDIO_CODECS.includes(audioStream.codec_name);
  const containerOk = typeof formatName === 'string' && formatName.includes('mp4');

  return !(videoOk && audioOk && containerOk);
};

const probeVideo = (filePath) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(filePath, (err, metadata) => {
    if (err) {
      return reject(err);
    }

    resolve(metadata);
  });
});

const transcodeVideo = async ({
  sourcePath,
  outputDir,
  targetVideoCodec = 'libx264',
  targetAudioCodec = 'aac',
  videoBitrate = '3500k',
  audioBitrate = '160k',
  keepOriginal = false
}) => {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  const metadata = await probeVideo(sourcePath);
  const streams = metadata?.streams || [];
  const shouldTranscode = needsTranscoding(metadata);
  const videoStream = streams.find(stream => stream.codec_type === 'video');
  const audioStream = streams.find(stream => stream.codec_type === 'audio');

  const videoCodec = videoStream?.codec_name;
  const audioCodec = audioStream?.codec_name;
  const duration = metadata?.format?.duration ? parseFloat(metadata.format.duration) : null;
  const width = videoStream?.width;
  const height = videoStream?.height;
  const container = metadata?.format?.format_name;

  if (!shouldTranscode) {
    const stat = fs.statSync(sourcePath);
    return {
      changed: false,
      outputPath: sourcePath,
      outputFilename: path.basename(sourcePath),
      size: stat.size,
      metadata: { videoCodec, audioCodec, duration, width, height, container }
    };
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const sourceName = path.basename(sourcePath, path.extname(sourcePath));
  const outputFilename = `${sourceName}__normalized.mp4`;
  const outputPath = path.join(outputDir, outputFilename);

  await new Promise((resolve, reject) => {
    const command = ffmpeg(sourcePath)
      .outputOptions([
        '-c:v', targetVideoCodec,
        '-b:v', videoBitrate,
        '-preset', 'fast',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-movflags', 'faststart',
        '-c:a', targetAudioCodec,
        '-b:a', audioBitrate,
        '-ac', '2'
      ])
      .on('start', cmd => {
        console.log('[VideoTranscoder] Start command:', cmd);
      })
      .on('progress', progress => {
        console.log('[VideoTranscoder] Progress', {
          frames: progress.frames,
          bitrate: progress.currentKbps,
          targetSize: progress.targetSize
        });
      })
      .on('error', err => {
        console.error('[VideoTranscoder] Error during transcode', err);
        reject(err);
      })
      .on('end', () => {
        console.log('[VideoTranscoder] Transcoding complete', { outputPath });
        resolve();
      })
      .save(outputPath);

    if (!keepOriginal) {
      command.on('end', () => {
        try {
          fs.unlinkSync(sourcePath);
          console.log('[VideoTranscoder] Removed original file', { sourcePath });
        } catch (removeErr) {
          console.warn('[VideoTranscoder] Failed to remove original file', { sourcePath, error: removeErr.message });
        }
      });
    }
  });

  const normalizedMetadata = await probeVideo(outputPath);
  const normalizedStreams = normalizedMetadata?.streams || [];
  const normalizedVideoStream = normalizedStreams.find(stream => stream.codec_type === 'video');
  const normalizedAudioStream = normalizedStreams.find(stream => stream.codec_type === 'audio');
  const normalizedStat = fs.statSync(outputPath);

  return {
    changed: true,
    outputPath,
    outputFilename,
    size: normalizedStat.size,
    metadata: {
      videoCodec: normalizedVideoStream?.codec_name || videoCodec,
      audioCodec: normalizedAudioStream?.codec_name || audioCodec,
      duration: normalizedMetadata?.format?.duration ? parseFloat(normalizedMetadata.format.duration) : duration,
      width: normalizedVideoStream?.width || width,
      height: normalizedVideoStream?.height || height,
      container: normalizedMetadata?.format?.format_name
    }
  };
};

module.exports = {
  transcodeVideo,
  probeVideo,
  needsTranscoding
};
