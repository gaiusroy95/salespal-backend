const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const execFileAsync = promisify(execFile);

function parseServiceAccountFromEnv(env) {
  const raw = String(env.google?.serviceAccountJson || '').trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }
  const b64 = String(env.google?.serviceAccountJsonBase64 || '').trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is invalid');
    }
  }
  return null;
}

async function getAccessToken(env) {
  const sa = parseServiceAccountFromEnv(env);
  const auth = new GoogleAuth({
    credentials: sa || undefined,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token');
  return token;
}

/** gs://bucket/prefix/part/ → { bucket, prefix } */
function parseGsPrefix(gsUri) {
  const raw = String(gsUri || '').trim();
  if (!raw.startsWith('gs://')) {
    throw new Error('Merged video upload expects AI_VIDEO_VEO_STORAGE_URI like gs://bucket/path/');
  }
  const noScheme = raw.slice('gs://'.length);
  const slashIdx = noScheme.indexOf('/');
  if (slashIdx <= 0) {
    throw new Error('AI_VIDEO_VEO_STORAGE_URI must include an object prefix (e.g. gs://bucket/videos/)');
  }
  const bucket = noScheme.slice(0, slashIdx);
  let prefix = noScheme.slice(slashIdx + 1);
  prefix = prefix.replace(/\/?$/, '/');
  return { bucket, prefix };
}

/**
 * Concatenate MP4 fragments with ffmpeg (stream copy — fast, needs compatible codecs).
 */
async function concatenateMp4WithFfmpeg(inputPaths, outputPath, ffmpegPath = 'ffmpeg') {
  const listPath = `${outputPath}.ffmpeg-concat.txt`;
  const escaped = inputPaths.map((p) => {
    const absolute = path.resolve(p);
    return absolute.replace(/'/g, `'\\''`);
  });
  const body = escaped.map((p) => `file '${p}'`).join('\n');
  await fs.writeFile(listPath, body, 'utf8');
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}

async function uploadLocalMp4ToGcs({ env, localPath, gsPrefixUri, objectName }) {
  const { bucket, prefix } = parseGsPrefix(gsPrefixUri);
  const objectKey = `${prefix}${objectName}`.replace(/^\//, '').replace(/^\/\//, '/');
  const fileBuf = await fs.readFile(localPath);
  const uploadUrl =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectKey)}`;

  const token = await getAccessToken(env);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/mp4',
    },
    body: fileBuf,
    signal: AbortSignal.timeout(900000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GCS upload failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const meta = await res.json().catch(() => ({}));
  const mediaLink = meta?.mediaLink || null;

  const gsUri = `gs://${bucket}/${objectKey}`;
  const httpsPub = `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${encodeURI(objectKey)}`;

  return { gsUri, httpsPub, bucket, objectKey, mediaLink };
}

module.exports = {
  concatenateMp4WithFfmpeg,
  uploadLocalMp4ToGcs,
};
