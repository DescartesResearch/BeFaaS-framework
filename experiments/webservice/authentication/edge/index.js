
const { performance } = require('perf_hooks');
const crypto = require('crypto');

const INTERNAL_ISSUER = 'edge-auth-service';
const INTERNAL_AUDIENCE = 'internal-services';
const MAX_CLOCK_SKEW_SECONDS = 5;

const EDGE_PUBLIC_KEY = process.env.EDGE_PUBLIC_KEY;
const CLOUDFRONT_SECRET = process.env.CLOUDFRONT_SECRET || null;
const fnName = process.env.BEFAAS_FN_NAME || 'unknownFn';
const deploymentId = process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId';

const requestIdCache = new Map();
const REQUEST_ID_CACHE_TTL_MS = 120000; // 2 minutes
const MAX_CACHE_SIZE = 10000;
const CLEANUP_INTERVAL = 100;
let requestsSinceCleanup = 0;

function logAuthTiming (contextId, xPair, durationMs, success) {
  console.log(
    'BEFAAS' +
      JSON.stringify({
        timestamp: new Date().getTime(),
        now: performance.now(),
        deploymentId,
        fn: { name: fnName },
        event: {
          contextId,
          xPair,
          authCheck: {
            durationMs,
            success,
            method: 'edge'
          }
        }
      })
  );
}

function base64UrlDecode (str) {
  const pad = str.length % 4;
  if (pad) {
    str += '='.repeat(4 - pad);
  }
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str, 'base64');
}

function cleanRequestIdCache () {
  const now = Date.now();
  for (const [id, timestamp] of requestIdCache.entries()) {
    if (now - timestamp > REQUEST_ID_CACHE_TTL_MS) {
      requestIdCache.delete(id);
    }
  }

  // If still too large, remove oldest entries
  if (requestIdCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(requestIdCache.entries());
    entries.sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [id] of toRemove) {
      requestIdCache.delete(id);
    }
  }
}

function checkReplayPrevention (requestId) {
  // Only run expensive cleanup periodically or when cache is near capacity
  requestsSinceCleanup++;
  if (requestsSinceCleanup >= CLEANUP_INTERVAL || requestIdCache.size > MAX_CACHE_SIZE * 0.8) {
    cleanRequestIdCache();
    requestsSinceCleanup = 0;
  }

  if (requestIdCache.has(requestId)) {
    return false; // Replay detected
  }

  requestIdCache.set(requestId, Date.now());
  return true;
}

let cachedPublicKey = null;

function verifyEd25519Signature (publicKeyBase64, message, signatureBase64url) {
  try {
    if (!cachedPublicKey) {
      const publicKeyDer = Buffer.from(publicKeyBase64, 'base64');
      cachedPublicKey = crypto.createPublicKey({
        key: publicKeyDer,
        format: 'der',
        type: 'spki'
      });
    }

    const signature = base64UrlDecode(signatureBase64url);

    return crypto.verify(
      null,
      Buffer.from(message),
      cachedPublicKey,
      signature
    );
  } catch (err) {
    console.error('Ed25519 verification error:', err.message);
    return false;
  }
}

async function verifyJWT (event, contextId, xPair) {
  const startTime = performance.now();
  const logContextId = contextId || 'unknown';
  const logXPair = xPair || 'unknown';

  try {
    if (!EDGE_PUBLIC_KEY) {
      console.error('EDGE_PUBLIC_KEY environment variable not set');
      const duration = performance.now() - startTime;
      logAuthTiming(logContextId, logXPair, duration, false);
      return false;
    }

    const authHeader = event.headers?.authorization || event.headers?.Authorization;

    if (!authHeader) {
      const duration = performance.now() - startTime;
      logAuthTiming(logContextId, logXPair, duration, false);
      return false;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    let header, payload;
    try {
      header = JSON.parse(base64UrlDecode(headerB64).toString());
      payload = JSON.parse(base64UrlDecode(payloadB64).toString());
    } catch (err) {
      throw new Error('Invalid JWT encoding');
    }

    if (header.alg !== 'EdDSA') {
      throw new Error(`Invalid algorithm: expected EdDSA, got ${header.alg}`);
    }

    if (payload.iss !== INTERNAL_ISSUER) {
      throw new Error(`Invalid issuer: expected ${INTERNAL_ISSUER}, got ${payload.iss}`);
    }

    if (payload.aud !== INTERNAL_AUDIENCE) {
      throw new Error(`Invalid audience: expected ${INTERNAL_AUDIENCE}, got ${payload.aud}`);
    }

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now - MAX_CLOCK_SKEW_SECONDS) {
      throw new Error('Token expired');
    }

    // Verify not issued in the future
    if (payload.iat && payload.iat > now + MAX_CLOCK_SKEW_SECONDS) {
      throw new Error('Token issued in the future');
    }

    // Verify Ed25519 signature BEFORE consuming replay cache
    const signingInput = `${headerB64}.${payloadB64}`;
    const isValid = verifyEd25519Signature(EDGE_PUBLIC_KEY, signingInput, signatureB64);

    if (!isValid) {
      throw new Error('Invalid signature');
    }

    if (!payload.request_id) {
      throw new Error('Missing request_id claim');
    }

    if (!checkReplayPrevention(payload.request_id)) {
      throw new Error('Replay attack detected: request_id already used');
    }

    // Verify CloudFront origin secret (prevents API Gateway bypass)
    if (CLOUDFRONT_SECRET) {
      const cfSecret = event.headers?.['x-cloudfront-secret'] || event.headers?.['X-CloudFront-Secret'];
      if (cfSecret && cfSecret !== CLOUDFRONT_SECRET) {
        throw new Error('Invalid CloudFront origin secret');
      }
    }

    const duration = performance.now() - startTime;
    logAuthTiming(logContextId, logXPair, duration, true);

    return payload;

  } catch (err) {
    const duration = performance.now() - startTime;
    logAuthTiming(logContextId, logXPair, duration, false);
    console.error('Error verifying internal JWT:', err.message);
    return false;
  }
}

module.exports = { verifyJWT };
