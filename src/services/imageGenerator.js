const { GoogleAuth } = require('google-auth-library');
const env = require('../config/env');

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

function extractImagenBase64(pred) {
  if (!pred || typeof pred !== 'object') return null;
  return (
    pred.bytesBase64Encoded ||
    pred.bytes_base64_encoded ||
    pred.imageBytes ||
    pred.image_bytes ||
    pred.b64_json ||
    (pred.image && typeof pred.image === 'object'
      ? pred.image.bytesBase64Encoded || pred.image.imageBytes || pred.image.b64_json
      : null) ||
    null
  );
}

async function generateAdImage(prompt, aspectRatio = '1:1') {
  try {
    const projectId = env.GCP_PROJECT_ID || process.env.GCP_PROJECT_ID;
    const location = env.GCP_LOCATION || process.env.GCP_LOCATION || 'us-central1';
    if (!projectId) {
      throw new Error('GCP_PROJECT_ID is not configured for Vertex Imagen');
    }

    const sa = parseServiceAccountFromEnv();
    const auth = new GoogleAuth({
      credentials: sa || undefined,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const token = await auth.getAccessToken();
    if (!token) throw new Error('Failed to obtain Google access token for Vertex Imagen');

    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/imagen-3.0-generate-001:predict`;
    const body = {
      instances: [{ prompt: String(prompt || '').trim() }],
      parameters: {
        sampleCount: 1,
        aspectRatio: String(aspectRatio || '1:1'),
        negativePrompt:
          'text, watermark, logo, borders, low quality, pixelated, blurry, cartoony, distorted, bad anatomy, unnatural lighting',
      },
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    const raw = await res.text();
    if (!res.ok) {
      let errMsg = raw.slice(0, 500);
      try {
        const j = JSON.parse(raw);
        errMsg = j?.error?.message || j?.message || errMsg;
      } catch {
        // keep text fallback
      }
      const e = new Error(`Vertex Imagen request failed (${res.status}): ${errMsg}`);
      e.code = 'VERTEX_IMAGEN_HTTP_ERROR';
      e.statusCode = res.status;
      throw e;
    }

    const data = JSON.parse(raw);
    const preds = Array.isArray(data?.predictions) ? data.predictions : [];
    const b64 = extractImagenBase64(preds[0]);
    if (!b64) {
      const keys = preds[0] && typeof preds[0] === 'object' ? Object.keys(preds[0]) : [];
      throw new Error(`Vertex Imagen returned no image bytes (predictionKeys=${JSON.stringify(keys)})`);
    }
    return `data:image/jpeg;base64,${b64}`;
  } catch (error) {
    const msg =
      typeof error?.message === 'string'
        ? error.message
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
    const e = new Error(`Vertex Imagen error: ${msg}`);
    e.code = error?.code || 'VERTEX_IMAGEN_ERROR';
    e.statusCode = error?.statusCode || undefined;
    throw e;
  }
}

module.exports = { generateAdImage };
