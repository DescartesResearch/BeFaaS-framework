const crypto = require('crypto');

const COGNITO_JWKS = process.env.COGNITO_JWKS ? JSON.parse(process.env.COGNITO_JWKS) : null;
const EDGE_PRIVATE_KEY = process.env.EDGE_PRIVATE_KEY;
const COGNITO_ISSUER = process.env.COGNITO_ISSUER;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const INTERNAL_TOKEN_TTL_SECONDS = 45;
const INTERNAL_ISSUER = 'edge-auth-service';
const INTERNAL_AUDIENCE = 'internal-services';

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

function base64UrlEncode(buffer) {
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

function jwkToPublicKey (jwk) {
  if (jwk.kid && jwkKeyCache.has(jwk.kid)) {
    return jwkKeyCache.get(jwk.kid);
  }
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (jwk.kid) {
    jwkKeyCache.set(jwk.kid, keyObject);
  }
  return keyObject;
}

function verifyCognitoToken (token) {
  if (!COGNITO_JWKS || !COGNITO_JWKS.keys) {
    throw new Error('JWKS not configured');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Parse header to get key ID
  const header = JSON.parse(base64UrlDecode(headerB64).toString());
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString());

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 5) {
    throw new Error('Token expired');
  }

  // Validate token_use claim
  if (payload.token_use !== 'access') {
    throw new Error('Invalid token_use: expected access token');
  }

  // Validate issuer
  if (COGNITO_ISSUER && payload.iss !== COGNITO_ISSUER) {
    throw new Error('Invalid issuer');
  }

  // Validate client_id
  if (COGNITO_CLIENT_ID && payload.client_id !== COGNITO_CLIENT_ID) {
    throw new Error('Invalid client_id');
  }

  // Find matching key in JWKS
  const key = COGNITO_JWKS.keys.find(k => k.kid === header.kid);
  if (!key) {
    throw new Error(`Key ${header.kid} not found in JWKS`);
  }

  // Verify signature
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

  const publicKey = jwkToPublicKey(key);
  const isValid = crypto.verify(
    algorithm,
    Buffer.from(signingInput),
    publicKey,
    signature
  );

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  return payload;
}

// Cache the Ed25519 private key
let cachedPrivateKey = null;

function getPrivateKey() {
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

function signInternalToken(payload) {
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

function createInternalToken(externalPayload) {
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
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  // Extract Authorization header
  const authHeaderArray = headers.authorization || headers.Authorization;
  const authHeader = authHeaderArray?.[0]?.value;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (requiresAuth(uri)) {
      console.error(`Edge auth: Protected endpoint ${uri} accessed without token`);
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

    return request;
  }

  const externalToken = authHeader.replace('Bearer ', '');

  try {
    // 1. Verify external token
    const externalPayload = verifyCognitoToken(externalToken);

    // 2. Create and sign internal token
    const internalToken = createInternalToken(externalPayload);

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

    return request;

  } catch (error) {
    console.error('Edge auth error:', error.message);

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
