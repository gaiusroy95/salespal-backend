const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const { GoogleAuth } = require('google-auth-library');
const { Readable } = require('stream');
const { concatenateMp4WithFfmpeg, uploadLocalMp4ToGcs } = require('./videoStitch.service');

const NEAR_INFINITE_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;

function resolveVideoPollTimeoutMs() {
  const configured = Number(env.ai?.videoPollTimeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) {
    return NEAR_INFINITE_TIMEOUT_MS;
  }
  return Math.max(1000, configured);
}

function parseServiceAccountFromEnv() {
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
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is invalid or not valid JSON');
    }
  }
  return null;
}

function normalizeVideoOutput(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output.find((x) => typeof x === 'string' && /^https?:\/\//i.test(x));
    return first || null;
  }
  if (typeof output === 'object') {
    if (typeof output.video === 'string') return output.video;
    if (typeof output.url === 'string') return output.url;
  }
  return null;
}

async function pollReplicatePrediction(url, token, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`Replicate poll failed (${res.status})`);
    }
    const data = await res.json();
    const status = String(data?.status || '').toLowerCase();
    if (status === 'succeeded') {
      const videoUrl = normalizeVideoOutput(data?.output);
      if (!videoUrl) throw new Error('Replicate succeeded but no video URL in output');
      return { videoUrl, raw: data };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(data?.error || `Replicate video generation ${status}`);
    }
    await new Promise((r) => setTimeout(r, 3500));
  }
  throw new Error('Replicate video generation timed out');
}

async function generateWithReplicate({ prompt, durationSec, aspectRatio, imageUrl }) {
  const token = env.ai.videoApiKey;
  const version = env.ai.videoReplicateModelVersion || env.ai.videoModelVersion;
  if (!token || !version) {
    throw new Error(
      'Replicate video provider not configured (AI_VIDEO_API_KEY + AI_VIDEO_REPLICATE_MODEL_VERSION or AI_VIDEO_MODEL_VERSION)'
    );
  }

  const input = {
    prompt,
    duration: Math.max(4, Math.min(30, Number(durationSec) || 12)),
    aspect_ratio: aspectRatio || '9:16',
  };
  if (imageUrl) input.image = imageUrl;

  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      version,
      input,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Replicate create failed (${createRes.status}): ${text.slice(0, 300)}`);
  }
  const created = await createRes.json();
  const pollUrl = created?.urls?.get;
  if (!pollUrl) {
    throw new Error('Replicate response missing poll URL');
  }

  const out = await pollReplicatePrediction(pollUrl, token);
  return {
    provider: 'replicate',
    videoUrl: out.videoUrl,
    raw: out.raw,
  };
}

function pickFirstString(values) {
  if (!Array.isArray(values)) return null;
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function pickFirstVideoUri(values) {
  if (!Array.isArray(values)) return null;
  for (const v of values) {
    if (!v) continue;
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v !== 'object') continue;
    const uri =
      v.gcsUri ||
      v.gcs_uri ||
      v.videoUri ||
      v.video_uri ||
      v.uri ||
      v.url ||
      (v.video && typeof v.video === 'object'
        ? v.video.uri || v.video.gcsUri || v.video.gcs_uri || v.video.videoUri || v.video.video_uri
        : null) ||
      null;
    if (typeof uri === 'string' && uri) return uri;
    const inlineBytes =
      v.bytesBase64Encoded ||
      v.bytes_base64_encoded ||
      (v.video && typeof v.video === 'object' ? v.video.bytesBase64Encoded || v.video.bytes_base64_encoded : null) ||
      null;
    if (typeof inlineBytes === 'string' && inlineBytes.trim()) {
      const mimeType =
        v.mimeType ||
        v.mime_type ||
        (v.video && typeof v.video === 'object' ? v.video.mimeType || v.video.mime_type : null) ||
        'video/mp4';
      return `data:${mimeType};base64,${inlineBytes.trim()}`;
    }
  }
  return null;
}

function deepFindVideoUri(node, depth = 0) {
  if (!node || depth > 8) return null;

  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (/^(gs|https?):\/\//i.test(trimmed) && (/\.(mp4|mov|webm)(\?|$)/i.test(trimmed) || trimmed.startsWith('gs://'))) {
      return trimmed;
    }
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindVideoUri(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;

  const directCandidates = [
    node.gcsUri,
    node.gcs_uri,
    node.videoUri,
    node.video_uri,
    node.uri,
    node.url,
    node.signedUri,
    node.signed_uri,
    node.downloadUri,
    node.download_uri,
    node.bytesBase64Encoded,
    node.bytes_base64_encoded,
  ];
  for (const c of directCandidates) {
    if (typeof c === 'string' && c.trim()) {
      if (/^(gs|https?):\/\//i.test(c.trim())) return c.trim();
      if (c.length > 64) {
        const mimeType = node.mimeType || node.mime_type || 'video/mp4';
        return `data:${mimeType};base64,${c.trim()}`;
      }
    }
  }

  // Frequently used Veo/Gemini response containers.
  const containerCandidates = [
    node.video,
    node.videos,
    node.generatedVideos,
    node.generatedVideo,
    node.generatedSamples,
    node.predictions,
    node.outputs,
    node.output,
    node.result,
    node.response,
    node.generateVideoResponse,
    node.metadata,
  ];
  for (const c of containerCandidates) {
    const found = deepFindVideoUri(c, depth + 1);
    if (found) return found;
  }

  for (const value of Object.values(node)) {
    const found = deepFindVideoUri(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractVeoVideoUri(operationPayload) {
  if (!operationPayload || typeof operationPayload !== 'object') return null;
  const response =
    operationPayload.response ||
    operationPayload.result ||
    operationPayload.output ||
    operationPayload;
  if (!response || typeof response !== 'object') return null;

  const direct =
    response.gcsUri ||
    response.gcs_uri ||
    response.videoUri ||
    response.video_uri ||
    response.uri ||
    response.url ||
    (Array.isArray(response.videos) ? pickFirstVideoUri(response.videos) : null) ||
    (Array.isArray(response.generatedVideos) ? pickFirstVideoUri(response.generatedVideos) : null) ||
    (response.generateVideoResponse && typeof response.generateVideoResponse === 'object'
      ? (Array.isArray(response.generateVideoResponse.generatedSamples)
          ? pickFirstVideoUri(response.generateVideoResponse.generatedSamples)
          : null) ||
        (Array.isArray(response.generateVideoResponse.generatedVideos)
          ? pickFirstVideoUri(response.generateVideoResponse.generatedVideos)
          : null)
      : null) ||
    null;
  if (typeof direct === 'string' && direct) return direct;

  const predictions = response.predictions || response.outputs || [];
  if (Array.isArray(predictions)) {
    for (const p of predictions) {
      if (!p || typeof p !== 'object') continue;
      const uri =
        p.gcsUri ||
        p.gcs_uri ||
        p.videoUri ||
        p.video_uri ||
        p.uri ||
        p.url ||
        (Array.isArray(p.videos) ? pickFirstVideoUri(p.videos) : null) ||
        (Array.isArray(p.generatedVideos) ? pickFirstVideoUri(p.generatedVideos) : null) ||
        (p.video && typeof p.video === 'object'
          ? p.video.uri || p.video.gcsUri || p.video.gcs_uri || p.video.videoUri || p.video.video_uri
          : null) ||
        null;
      if (typeof uri === 'string' && uri) return uri;
    }
  }

  return deepFindVideoUri(operationPayload);
}

function normalizeVideoUriForWeb(uri) {
  const u = String(uri || '').trim();
  if (!u) return null;
  if (u.startsWith('gs://')) {
    const noScheme = u.slice('gs://'.length);
    const slashIdx = noScheme.indexOf('/');
    if (slashIdx <= 0) return null;
    const bucket = noScheme.slice(0, slashIdx);
    const objectPath = noScheme.slice(slashIdx + 1);
    return `https://storage.googleapis.com/${bucket}/${encodeURI(objectPath)}`;
  }
  return u;
}

function parseGsUri(uri) {
  const u = String(uri || '').trim();
  if (!u.startsWith('gs://')) return null;
  const noScheme = u.slice('gs://'.length);
  const slashIdx = noScheme.indexOf('/');
  if (slashIdx <= 0) return null;
  return {
    bucket: noScheme.slice(0, slashIdx),
    objectPath: noScheme.slice(slashIdx + 1),
  };
}

function parseGoogleStorageHttpUrl(uri) {
  try {
    const u = new URL(String(uri || '').trim());
    const host = u.hostname.toLowerCase();
    if (host !== 'storage.googleapis.com') return null;
    const path = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
    if (!path) return null;
    const parts = path.split('/');
    const bucket = parts.shift();
    const objectPath = parts.join('/');
    if (!bucket || !objectPath) return null;
    return { bucket, objectPath };
  } catch {
    return null;
  }
}

async function getGoogleCloudAccessToken() {
  const sa = parseServiceAccountFromEnv();
  const auth = new GoogleAuth({
    credentials: sa || undefined,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token');
  return token;
}

async function streamVideoUriToResponse(videoUri, res, options = {}) {
  const uri = String(videoUri || '').trim();
  if (!uri) throw new Error('Video URI is empty');
  const requestedRange = String(options.range || '').trim();

  if (uri.startsWith('data:')) {
    const m = uri.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Unsupported data URI format for video');
    const mimeType = m[1] || 'video/mp4';
    const body = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(body);
    return;
  }

  const fromGs = parseGsUri(uri);
  const fromStorageHttp = parseGoogleStorageHttpUrl(uri);
  let fetchUrl = uri;
  const headers = { Accept: '*/*' };
  if (requestedRange) headers.Range = requestedRange;

  if (fromGs || fromStorageHttp) {
    const target = fromGs || fromStorageHttp;
    const token = await getGoogleCloudAccessToken();
    const encodedObject = encodeURIComponent(target.objectPath);
    fetchUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.bucket)}/o/${encodedObject}?alt=media`;
    headers.Authorization = `Bearer ${token}`;
  }

  const upstream = await fetch(fetchUrl, {
    headers,
    signal: AbortSignal.timeout(120000),
  });
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    throw new Error(`Failed to fetch video media (${upstream.status}): ${txt.slice(0, 200)}`);
  }

  const statusCode = upstream.status || 200;
  res.status(statusCode);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  const contentLen = upstream.headers.get('content-length');
  if (contentLen) res.setHeader('Content-Length', contentLen);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');
  Readable.fromWeb(upstream.body).pipe(res);
}

/**
 * Download full media bytes from a playable URI (supports private GCS when SA is configured).
 */
async function fetchVideoUriToBuffer(videoUri) {
  const uri = String(videoUri || '').trim();
  if (!uri) throw new Error('Video URI is empty');

  if (uri.startsWith('data:')) {
    const m = uri.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Unsupported data URI format for video');
    return Buffer.from(m[2], 'base64');
  }

  const fromGs = parseGsUri(uri);
  const fromStorageHttp = parseGoogleStorageHttpUrl(uri);
  let fetchUrl = uri;
  const headers = { Accept: '*/*' };

  if (fromGs || fromStorageHttp) {
    const target = fromGs || fromStorageHttp;
    const token = await getGoogleCloudAccessToken();
    const encodedObject = encodeURIComponent(target.objectPath);
    fetchUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.bucket)}/o/${encodedObject}?alt=media`;
    headers.Authorization = `Bearer ${token}`;
  }

  const upstream = await fetch(fetchUrl, {
    headers,
    signal: AbortSignal.timeout(600000),
  });
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    throw new Error(`Failed to fetch video media (${upstream.status}): ${txt.slice(0, 200)}`);
  }
  return Buffer.from(await upstream.arrayBuffer());
}

/**
 * Partition total seconds into 4 / 6 / 8-second Veo segments. Final length may slightly exceed the request
 * when the remainder is 1–3s (one extra 4s clip is added).
 */
function buildVeoStitchSegments(totalRequested, maxTotal) {
  const max = Math.max(8, Number(maxTotal) || 180);
  let t = Math.round(Number(totalRequested));
  if (!Number.isFinite(t) || t < 4) t = 4;
  if (t > max) {
    throw new Error(`Requested stitched duration ${totalRequested}s exceeds AI_VIDEO_MAX_STITCH_SECONDS (${max}s)`);
  }

  const segs = [];
  let remaining = t;
  while (remaining > 0) {
    if (remaining >= 8) {
      segs.push(8);
      remaining -= 8;
    } else if (remaining >= 6) {
      segs.push(6);
      remaining -= 6;
    } else if (remaining >= 4) {
      segs.push(4);
      remaining -= 4;
    } else {
      segs.push(4);
      remaining = 0;
    }
  }

  return {
    segments: segs,
    plannedTotalSeconds: segs.reduce((a, b) => a + b, 0),
    requestedSecondsRounded: t,
  };
}

async function generateStitchedGoogleVeo({ prompt, durationSec, aspectRatio }) {
  const gsPrefix = String(env.ai.videoVeoStorageUri || '').trim();
  if (!gsPrefix) {
    throw new Error(
      'Stitched videos require AI_VIDEO_VEO_STORAGE_URI (gs://bucket/prefix/) to upload merged output. Single 4/6/8s clips still work without it.'
    );
  }

  const maxStitch = Math.max(8, Number(env.ai.videoMaxStitchSeconds) || 180);
  const plan = buildVeoStitchSegments(durationSec, maxStitch);
  const { segments } = plan;
  if (segments.length === 1) {
    return generateWithGoogleVeo({ prompt, durationSec: segments[0], aspectRatio });
  }

  const ffmpegPath = env.ai.videoFfmpegPath || 'ffmpeg';

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-veo-stitch-'));
  const fragmentPaths = [];
  try {
    console.log('[aiVideo] Veo stitched plan:', durationSec, '=>', segments.join('+'), `(${plan.plannedTotalSeconds}s)`);

    for (let i = 0; i < segments.length; i += 1) {
      const part = segments[i];
      const segmentPrompt = [
        prompt,
        '',
        `Continuation context: segment ${i + 1} of ${segments.length} for one continuous advertisement.`,
        'Keep continuity of subject, vibe, pacing, humans, locale, palette, framing style across segments.',
      ].join('\n');

      /* eslint-disable no-await-in-loop */
      const { videoUrl } = await generateWithGoogleVeo({
        prompt: segmentPrompt,
        durationSec: part,
        aspectRatio,
      });

      const buf = await fetchVideoUriToBuffer(videoUrl);
      const fp = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      await fs.writeFile(fp, buf);
      fragmentPaths.push(fp);
      /* eslint-enable no-await-in-loop */
    }

    const mergedPath = path.join(workDir, 'merged.mp4');
    await concatenateMp4WithFfmpeg(fragmentPaths, mergedPath, ffmpegPath);

    const objectBase = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const objectName = `stitched/sp_stitched_${objectBase}.mp4`;
    const { gsUri } = await uploadLocalMp4ToGcs({
      env,
      localPath: mergedPath,
      gsPrefixUri: gsPrefix,
      objectName,
    });

    return {
      provider: 'google-veo',
      videoUrl: normalizeVideoUriForWeb(gsUri),
      raw: {
        stitched: true,
        segmentCount: segments.length,
        segmentDurationsSeconds: segments,
        plannedTotalSeconds: plan.plannedTotalSeconds,
        requestedSeconds: plan.requestedSecondsRounded,
        destination: gsUri,
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeVeoDurationSeconds(value) {
  const supported = [4, 6, 8];
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  const whole = Math.round(parsed);
  if (supported.includes(whole)) return whole;
  throw new Error(
    `Unsupported output video duration ${value} seconds. Veo supports only exact durations: ${supported.join(', ')} seconds.`
  );
}

function buildVeoOperationPollUrl({ operationName, projectId, location = 'us-central1' }) {
  const op = String(operationName || '').trim();
  if (!op) {
    throw new Error('Veo operation name is empty');
  }

  // Some APIs return a full URL.
  if (/^https?:\/\//i.test(op)) {
    return op;
  }

  // Typical long-running operation resource name.
  if (op.startsWith('projects/')) {
    return `https://${location}-aiplatform.googleapis.com/v1/${op}`;
  }

  // Occasionally short form: operations/xxx
  if (op.startsWith('operations/')) {
    if (!projectId) {
      throw new Error('projectId is required to poll short-form Veo operation names');
    }
    return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/${op}`;
  }

  // Handle accidental leading "/v1/..." or "/projects/..."
  if (op.startsWith('/')) {
    return `https://${location}-aiplatform.googleapis.com${op}`;
  }

  throw new Error(`Unexpected Veo operation name format: ${op}`);
}

function buildVeoOperationPollUrlCandidates({ operationName, projectId, location = 'us-central1' }) {
  const op = String(operationName || '').trim();
  if (!op) throw new Error('Veo operation name is empty');

  const urls = new Set();
  const add = (u) => {
    if (typeof u === 'string' && u.trim()) urls.add(u.trim());
  };

  // Primary computed URL
  add(buildVeoOperationPollUrl({ operationName: op, projectId, location }));

  // Full URL form: also try normalized global/regional variants.
  if (/^https?:\/\//i.test(op)) {
    try {
      const u = new URL(op);
      const path = `${u.pathname}${u.search || ''}`;
      add(`https://${location}-aiplatform.googleapis.com${path}`);
      add(`https://aiplatform.googleapis.com${path}`);
    } catch {
      // ignore malformed URL here (primary builder already accepted it)
    }
  }

  // Resource-name form: try both regional and global hosts.
  if (op.startsWith('projects/')) {
    add(`https://aiplatform.googleapis.com/v1/${op}`);
    add(`https://${location}-aiplatform.googleapis.com/v1/${op}`);
    add(`https://aiplatform.googleapis.com/v1beta1/${op}`);
    add(`https://${location}-aiplatform.googleapis.com/v1beta1/${op}`);

    // Canonicalize model-scoped operation paths:
    // projects/<p>/locations/<l>/publishers/google/models/<m>/operations/<id>
    // => projects/<p>/locations/<l>/operations/<id>
    const canonicalMatch = op.match(
      /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/[^/]+\/operations\/([^/?#]+)(.*)?$/i
    );
    if (canonicalMatch) {
      const canonicalProject = canonicalMatch[1];
      const canonicalLocation = canonicalMatch[2];
      const operationId = canonicalMatch[3];
      const suffix = canonicalMatch[4] || '';
      const canonicalPath = `projects/${canonicalProject}/locations/${canonicalLocation}/operations/${operationId}${suffix}`;
      add(`https://${canonicalLocation}-aiplatform.googleapis.com/v1/${canonicalPath}`);
      add(`https://aiplatform.googleapis.com/v1/${canonicalPath}`);
      add(`https://${canonicalLocation}-aiplatform.googleapis.com/v1beta1/${canonicalPath}`);
      add(`https://aiplatform.googleapis.com/v1beta1/${canonicalPath}`);
    }
  }

  // Short operations form: try with and without explicit location prefix patterns.
  if (op.startsWith('operations/') && projectId) {
    add(`https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/${op}`);
    add(`https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/${op}`);
    add(`https://aiplatform.googleapis.com/v1/projects/${projectId}/${op}`);
    // Some LRO providers expose top-level operations collection.
    add(`https://${location}-aiplatform.googleapis.com/v1/${op}`);
    add(`https://aiplatform.googleapis.com/v1/${op}`);
    add(`https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/${op}`);
    add(`https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/${op}`);
    add(`https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/${op}`);
    add(`https://${location}-aiplatform.googleapis.com/v1beta1/${op}`);
    add(`https://aiplatform.googleapis.com/v1beta1/${op}`);
  }

  // Leading slash path form for canonicalized model-scoped operations.
  if (op.startsWith('/')) {
    const normalized = op.replace(/^\/v1\//, '').replace(/^\//, '');
    const canonicalMatch = normalized.match(
      /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/[^/]+\/operations\/([^/?#]+)(.*)?$/i
    );
    if (canonicalMatch) {
      const canonicalProject = canonicalMatch[1];
      const canonicalLocation = canonicalMatch[2];
      const operationId = canonicalMatch[3];
      const suffix = canonicalMatch[4] || '';
      const canonicalPath = `/v1/projects/${canonicalProject}/locations/${canonicalLocation}/operations/${operationId}${suffix}`;
      add(`https://${canonicalLocation}-aiplatform.googleapis.com${canonicalPath}`);
      add(`https://aiplatform.googleapis.com${canonicalPath}`);
      add(`https://${canonicalLocation}-aiplatform.googleapis.com${canonicalPath.replace('/v1/', '/v1beta1/')}`);
      add(`https://aiplatform.googleapis.com${canonicalPath.replace('/v1/', '/v1beta1/')}`);
    }
  }

  // Full URL form: add v1<->v1beta1 counterpart and regional/global host counterparts.
  if (/^https?:\/\//i.test(op)) {
    try {
      const u = new URL(op);
      const path = `${u.pathname}${u.search || ''}`;
      const betaPath = path.replace('/v1/', '/v1beta1/');
      const v1Path = path.replace('/v1beta1/', '/v1/');
      add(`https://aiplatform.googleapis.com${path}`);
      add(`https://${location}-aiplatform.googleapis.com${path}`);
      add(`https://aiplatform.googleapis.com${betaPath}`);
      add(`https://${location}-aiplatform.googleapis.com${betaPath}`);
      add(`https://aiplatform.googleapis.com${v1Path}`);
      add(`https://${location}-aiplatform.googleapis.com${v1Path}`);
    } catch {
      // no-op
    }
  }

  return Array.from(urls);
}

function extractVeoModelEndpointFromOperationName(operationName) {
  const raw = String(operationName || '').trim();
  if (!raw) return null;

  let resource = raw;
  if (/^https?:\/\//i.test(resource)) {
    try {
      const u = new URL(resource);
      resource = u.pathname.replace(/^\/v1(beta1)?\//, '').replace(/^\//, '');
    } catch {
      return null;
    }
  } else {
    resource = resource.replace(/^\/v1(beta1)?\//, '').replace(/^\//, '');
  }

  const match = resource.match(
    /^(projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/[^/]+)\/operations\/[^/]+$/i
  );
  return match ? match[1] : null;
}

function buildVeoFetchPredictOperationEndpoints({ modelEndpoint, location = 'us-central1' }) {
  return [
    `https://${location}-aiplatform.googleapis.com/v1/${modelEndpoint}:fetchPredictOperation`,
    `https://aiplatform.googleapis.com/v1/${modelEndpoint}:fetchPredictOperation`,
    `https://${location}-aiplatform.googleapis.com/v1beta1/${modelEndpoint}:fetchPredictOperation`,
    `https://aiplatform.googleapis.com/v1beta1/${modelEndpoint}:fetchPredictOperation`,
  ];
}

async function fetchVeoPredictOperation({ fetchEndpoints, operationName, token }) {
  let lastError = null;
  for (const endpoint of fetchEndpoints) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ operationName }),
      signal: AbortSignal.timeout(45000),
    });

    if (res.ok) {
      const payload = await res.json();
      return { payload, endpoint };
    }

    const txt = await res.text();
    const shouldTryNext =
      res.status === 404 ||
      (res.status === 400 && /Operation ID must be a Long|INVALID_ARGUMENT/i.test(txt));
    if (shouldTryNext) {
      lastError = new Error(`fetchPredictOperation failed (${res.status}) at ${endpoint}: ${txt.slice(0, 300)}`);
      continue;
    }
    throw new Error(`fetchPredictOperation failed (${res.status}) at ${endpoint}: ${txt.slice(0, 300)}`);
  }
  throw lastError || new Error('All fetchPredictOperation endpoints failed');
}

async function pollVeoOperation({
  operationName,
  token,
  projectId,
  location = 'us-central1',
  timeoutMs = resolveVideoPollTimeoutMs(),
}) {
  const start = Date.now();

  const modelEndpoint = extractVeoModelEndpointFromOperationName(operationName);
  if (modelEndpoint) {
    const fetchEndpoints = buildVeoFetchPredictOperationEndpoints({ modelEndpoint, location });
    console.log('[aiVideo] Veo fetchPredictOperation endpoints:', fetchEndpoints);
    while (Date.now() - start < timeoutMs) {
      const { payload, endpoint: usedEndpoint } = await fetchVeoPredictOperation({
        fetchEndpoints,
        operationName,
        token,
      });
      if (payload.done === true) {
        if (payload.error) {
          throw new Error(payload.error.message || 'Veo operation failed');
        }
        const uri = extractVeoVideoUri(payload);
        if (!uri) {
          const responseKeys = payload.response && typeof payload.response === 'object' ? Object.keys(payload.response) : [];
          const metadataKeys = payload.metadata && typeof payload.metadata === 'object' ? Object.keys(payload.metadata) : [];
          throw new Error(
            `Veo completed but no video URI found in operation response (responseKeys=${JSON.stringify(responseKeys)}, metadataKeys=${JSON.stringify(metadataKeys)})`
          );
        }
        return { videoUrl: normalizeVideoUriForWeb(uri), raw: payload };
      }
      console.log('[aiVideo] Veo still running via fetchPredictOperation:', usedEndpoint);
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('Veo operation timed out');
  }

  const endpoints = buildVeoOperationPollUrlCandidates({ operationName, projectId, location });
  console.log('[aiVideo] Veo poll endpoints:', endpoints);
  let endpointIdx = 0;
  let endpoint = endpoints[endpointIdx];
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const txt = await res.text();
      const shouldTryNextFor404 = res.status === 404;
      const shouldTryNextForWrongOpId =
        res.status === 400 && /Operation ID must be a Long/i.test(txt);
      // Wrong endpoint shape can appear as 404, or 400 for incompatible operation-id format.
      if ((shouldTryNextFor404 || shouldTryNextForWrongOpId) && endpointIdx < endpoints.length - 1) {
        endpointIdx += 1;
        endpoint = endpoints[endpointIdx];
        console.warn('[aiVideo] Veo poll retrying next endpoint after', res.status, ':', endpoint);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new Error(`Veo operation poll failed (${res.status}) at ${endpoint}: ${txt.slice(0, 300)}`);
    }
    const payload = await res.json();
    if (payload.done === true) {
      if (payload.error) {
        throw new Error(payload.error.message || 'Veo operation failed');
      }
      const uri = extractVeoVideoUri(payload);
      if (!uri) {
        const responseKeys = payload.response && typeof payload.response === 'object' ? Object.keys(payload.response) : [];
        const metadataKeys = payload.metadata && typeof payload.metadata === 'object' ? Object.keys(payload.metadata) : [];
        throw new Error(
          `Veo completed but no video URI found in operation response (responseKeys=${JSON.stringify(responseKeys)}, metadataKeys=${JSON.stringify(metadataKeys)})`
        );
      }
      return { videoUrl: normalizeVideoUriForWeb(uri), raw: payload };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Veo operation timed out');
}

async function generateWithGoogleVeo({ prompt, durationSec, aspectRatio }) {
  const projectId = env.GCP_PROJECT_ID || process.env.GCP_PROJECT_ID;
  const location = env.GCP_LOCATION || process.env.GCP_LOCATION || 'us-central1';
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID is required for google-veo provider');
  }
  const modelId = env.ai.videoVeoModelId || env.ai.videoModelVersion || 'veo-3.1-generate-001';

  const sa = parseServiceAccountFromEnv();
  const auth = new GoogleAuth({
    credentials: sa || undefined,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token for Veo');

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:predictLongRunning`;
  const normalizedDurationSec = normalizeVeoDurationSeconds(durationSec);
  if (Number(durationSec) !== normalizedDurationSec) {
    console.log('[aiVideo] Veo duration normalized:', durationSec, '=>', normalizedDurationSec);
  }
  const reqBody = {
    instances: [
      {
        prompt,
      },
    ],
    parameters: {
      aspectRatio: aspectRatio || '9:16',
      durationSeconds: normalizedDurationSec,
      sampleCount: 1,
    },
  };
  const outputStorageUri = String(env.ai.videoVeoStorageUri || '').trim();
  if (outputStorageUri) {
    reqBody.parameters.storageUri = outputStorageUri;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Veo request failed (${res.status}): ${txt.slice(0, 400)}`);
  }

  const op = await res.json();
  const operationName = op?.name;
  if (!operationName) {
    throw new Error('Veo request did not return operation name');
  }
  console.log('[aiVideo] Veo operation name:', operationName);

  const done = await pollVeoOperation({ operationName, token, projectId, location });
  return {
    provider: 'google-veo',
    videoUrl: done.videoUrl,
    raw: done.raw,
  };
}

async function generatePromotionalVideo({ prompt, durationSec = 12, aspectRatio = '9:16', imageUrl = '' }) {
  const provider = String(env.ai.videoProvider || '').toLowerCase();
  const fallback = String(env.ai.videoFallbackProvider || '').toLowerCase();
  const order = Array.isArray(env.ai.videoProviderOrder) ? env.ai.videoProviderOrder : [];

  let providersToTry = [];
  if (!provider || provider === 'none') {
    throw new Error('AI video provider is not configured');
  } else if (provider === 'auto') {
    providersToTry = order.length ? order : ['replicate', 'google-veo'];
  } else {
    providersToTry = [provider];
    if (fallback && fallback !== provider) providersToTry.push(fallback);
  }

  let lastErr = null;
  for (const p of providersToTry) {
    try {
      if (p === 'replicate') {
        return await generateWithReplicate({ prompt, durationSec, aspectRatio, imageUrl });
      }
      if (p === 'google-veo') {
        const d = Math.round(Number(durationSec));
        const supportedSingle = Number.isFinite(d) && [4, 6, 8].includes(d);
        if (!supportedSingle) {
          return await generateStitchedGoogleVeo({ prompt, durationSec: d || 8, aspectRatio });
        }
        return await generateWithGoogleVeo({ prompt, durationSec: d, aspectRatio });
      }
      lastErr = new Error(`Unsupported AI video provider in sequence: ${p}`);
    } catch (err) {
      lastErr = err;
      // Try next provider in sequence.
    }
  }
  throw lastErr || new Error('All configured video providers failed');
}

module.exports = {
  generatePromotionalVideo,
  streamVideoUriToResponse,
};

