
const crypto = require('crypto');
const https = require('https');
const { performance } = require('perf_hooks');

const COGNITO_JWKS_URL = process.env.COGNITO_JWKS_URL;
const EDGE_PRIVATE_KEY = process.env.EDGE_PRIVATE_KEY;
const COGNITO_ISSUER = process.env.COGNITO_ISSUER;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const INTERNAL_TOKEN_TTL_SECONDS = 45;
const INTERNAL_ISSUER = 'edge-auth-service';
const INTERNAL_AUDIENCE = 'internal-services';
const JWKS_FETCH_TIMEOUT_MS = 1500;
const JWKS_MIN_REFETCH_INTERVAL_MS = 5000;

const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
const INSTANCE_BOOT_MS = Date.now();

function logEdge (fields) {
  console.log('BEFAAS-EDGE' + JSON.stringify({
    timestamp: Date.now(),
    now: performance.now(),
    instanceId: INSTANCE_ID,
    ...fields
  }));
}

const PROTECTED_PATH_PATTERNS = [
  '/cart',
  '/addCartItem',
  '/emptyCart',
  '/checkout'
];

function requiresAuth (uri) {
  const path = uri.split('?')[0];

  const segments = path.split('/').filter(Boolean);
  return PROTECTED_PATH_PATTERNS.some(pattern => {
    const patternSegment = pattern.replace(/^\//, '');
    return segments.includes(patternSegment);
  });
}

function base64UrlEncode (buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode (str) {
  const pad = str.length % 4;
  if (pad) {
    str += '='.repeat(4 - pad);
  }
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str, 'base64');
}

function generateRequestId () {
  return crypto.randomBytes(16).toString('hex');
}

const jwkKeyCache = new Map();
let jwksLastFetchMs = 0;
let jwksFetchCount = 0;
let jwksInflight = null;

function fetchJwks (trigger) {
  if (jwksInflight) {
    logEdge({ event: 'jwksFetchPiggyback', trigger });
    return jwksInflight;
  }

  const fetchStart = performance.now();
  jwksInflight = new Promise((resolve, reject) => {
    const req = https.get(COGNITO_JWKS_URL, { timeout: JWKS_FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`JWKS fetch failed: HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const jwks = JSON.parse(body);
          if (!jwks || !Array.isArray(jwks.keys)) {
            return reject(new Error('JWKS response malformed'));
          }
          jwkKeyCache.clear();
          for (const jwk of jwks.keys) {
            if (!jwk.kid) continue;
            jwkKeyCache.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
          }
          jwksLastFetchMs = Date.now();
          jwksFetchCount += 1;
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`JWKS fetch timed out after ${JWKS_FETCH_TIMEOUT_MS} ms`));
    });
    req.on('error', reject);
  }).then(() => {
    logEdge({
      event: 'jwksFetch',
      trigger,
      fetchNumber: jwksFetchCount,
      durationMs: performance.now() - fetchStart,
      keyCount: jwkKeyCache.size,
      instanceAgeMs: Date.now() - INSTANCE_BOOT_MS
    });
  }, (err) => {
    logEdge({
      event: 'jwksFetchError',
      trigger,
      durationMs: performance.now() - fetchStart,
      error: err.message
    });
    throw err;
  }).finally(() => {
    jwksInflight = null;
  });

  return jwksInflight;
}

async function getSigningKey (kid) {
  if (jwkKeyCache.has(kid)) {
    return jwkKeyCache.get(kid);
  }
  const trigger = jwksLastFetchMs === 0 ? 'cold' : 'unknownKid';
  const sinceLast = Date.now() - jwksLastFetchMs;
  if (sinceLast < JWKS_MIN_REFETCH_INTERVAL_MS && jwksLastFetchMs !== 0) {
    logEdge({ event: 'jwksRefetchDebounced', kid, sinceLastMs: sinceLast });
    throw new Error(`Key ${kid} not found in JWKS`);
  }
  await fetchJwks(trigger);
  if (jwkKeyCache.has(kid)) {
    return jwkKeyCache.get(kid);
  }
  throw new Error(`Key ${kid} not found in JWKS`);
}

async function verifyCognitoToken (token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString());
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString());

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 5) {
    throw new Error('Token expired');
  }

  // Validate token_use claim
  if (payload.token_use !== 'access') {
    throw new Error('Invalid token_use: expected access token');
  }

  if (COGNITO_ISSUER && payload.iss !== COGNITO_ISSUER) {
    throw new Error('Invalid issuer');
  }

  if (COGNITO_CLIENT_ID && payload.client_id !== COGNITO_CLIENT_ID) {
    throw new Error('Invalid client_id');
  }

  // Resolve signing key from runtime JWKS cache (fetches on cold/unknown kid)
  const keyResolveStart = performance.now();
  const publicKey = await getSigningKey(header.kid);
  const keyResolveMs = performance.now() - keyResolveStart;

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  let algorithm;
  switch (header.alg) {
    case 'RS256':
      algorithm = 'RSA-SHA256';
      break;
    case 'RS384':
      algorithm = 'RSA-SHA384';
      break;
    case 'RS512':
      algorithm = 'RSA-SHA512';
      break;
    default:
      throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  const cryptoVerifyStart = performance.now();
  const isValid = crypto.verify(
    algorithm,
    Buffer.from(signingInput),
    publicKey,
    signature
  );
  const cryptoVerifyMs = performance.now() - cryptoVerifyStart;

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  return { payload, phases: { keyResolveMs, cryptoVerifyMs } };
}

// Cache the Ed25519 private key
let cachedPrivateKey = null;

function getPrivateKey () {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!EDGE_PRIVATE_KEY) {
    throw new Error('EDGE_PRIVATE_KEY not configured');
  }
  const privateKeyDer = Buffer.from(EDGE_PRIVATE_KEY, 'base64');
  cachedPrivateKey = crypto.createPrivateKey({
    key: privateKeyDer,
    format: 'der',
    type: 'pkcs8'
  });
  return cachedPrivateKey;
}

function signInternalToken (payload) {
  const privateKey = getPrivateKey();

  // Create JWT header
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign with Ed25519
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

function createInternalToken (externalPayload) {
  const now = Math.floor(Date.now() / 1000);

  const internalPayload = {
    sub: externalPayload.sub || externalPayload.username,
    iss: INTERNAL_ISSUER,
    aud: INTERNAL_AUDIENCE,
    exp: now + INTERNAL_TOKEN_TTL_SECONDS,
    iat: now,
    request_id: generateRequestId()
  };

  return signInternalToken(internalPayload);
}

exports.handler = async (event) => {
  const handlerStart = performance.now();
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  const authHeaderArray = headers.authorization || headers.Authorization;
  const authHeader = authHeaderArray?.[0]?.value;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (requiresAuth(uri)) {
      console.error(`Edge auth: Protected endpoint ${uri} accessed without token`);
      logEdge({
        event: 'authCheck',
        uri,
        outcome: 'missingToken401',
        totalMs: performance.now() - handlerStart
      });
      return {
        status: '401',
        statusDescription: 'Unauthorized',
        body: JSON.stringify({
          error: 'Authentication required',
          message: `Endpoint ${uri} requires authentication`,
          path: uri
        }),
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
          'x-befaas-edge-error': [{ key: 'X-BeFaaS-Edge-Error', value: 'Missing authentication token' }]
        }
      };
    }

    request.headers['x-befaas-edge-processed'] = [{
      key: 'X-BeFaaS-Edge-Processed',
      value: 'passthrough'
    }];

    logEdge({
      event: 'authCheck',
      uri,
      outcome: 'publicPassthrough',
      totalMs: performance.now() - handlerStart
    });
    return request;
  }

  const externalToken = authHeader.replace('Bearer ', '');

  try {
    // 1. Verify external token (Cognito JWT).
    const jwksFetchCountBefore = jwksFetchCount;
    const { payload: externalPayload, phases } = await verifyCognitoToken(externalToken);
    const triggeredJwksFetch = jwksFetchCount > jwksFetchCountBefore;

    // 2. Create and sign internal token (Ed25519).
    const signStart = performance.now();
    const internalToken = createInternalToken(externalPayload);
    const signMs = performance.now() - signStart;

    // 3. Replace Authorization header with internal token
    request.headers.authorization = [{
      key: 'Authorization',
      value: `Bearer ${internalToken}`
    }];

    // 4. Add edge processing marker
    request.headers['x-befaas-edge-processed'] = [{
      key: 'X-BeFaaS-Edge-Processed',
      value: 'true'
    }];

    // 5. Add original subject for logging
    const sub = externalPayload.sub || externalPayload.username || 'unknown';
    request.headers['x-befaas-edge-subject'] = [{
      key: 'X-BeFaaS-Edge-Subject',
      value: sub.substring(0, 36)
    }];

    const totalMs = performance.now() - handlerStart;
    logEdge({
      event: 'authCheck',
      uri,
      outcome: 'success',
      totalMs,
      keyResolveMs: phases.keyResolveMs,
      cryptoVerifyMs: phases.cryptoVerifyMs,
      signMs,
      triggeredJwksFetch,
      instanceAgeMs: Date.now() - INSTANCE_BOOT_MS
    });

    return request;

  } catch (error) {
    console.error('Edge auth error:', error.message);
    logEdge({
      event: 'authCheck',
      uri,
      outcome: 'invalidToken401',
      totalMs: performance.now() - handlerStart,
      error: error.message
    });

    return {
      status: '401',
      statusDescription: 'Unauthorized',
      body: JSON.stringify({
        error: 'Invalid or expired token'
      }),
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }]
      }
    };
  }
};