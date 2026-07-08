const { jwtVerify, importSPKI } = require('jose')
const { performance } = require('perf_hooks')

const fnName = process.env.BEFAAS_FN_NAME || 'unknownFn'
const deploymentId = process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId'

let cachedPublicKey = null

async function getPublicKey () {
  if (cachedPublicKey) return cachedPublicKey
  const pem = Buffer.from(process.env.JWT_PUBLIC_KEY, 'base64').toString('utf8')
  cachedPublicKey = await importSPKI(pem, 'EdDSA')
  return cachedPublicKey
}

function logAuthTiming (contextId, xPair, durationMs, success) {
  console.log(
    'BEFAAS' +
      JSON.stringify({
        timestamp: new Date().getTime(),
        fn: { name: fnName },
        event: {
          contextId,
          xPair,
          authCheck: {
            durationMs,
            success
          }
        }
      })
  )
}

async function verifyJWT (event, contextId, xPair) {
  const startTime = performance.now()
  const logContextId = contextId || 'unknown'
  const logXPair = xPair || 'unknown'

  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization

    if (!authHeader) {
      const duration = performance.now() - startTime
      logAuthTiming(logContextId, logXPair, duration, false)
      return false
    }

    const token = authHeader.replace(/^Bearer\s+/i, '')

    const publicKey = await getPublicKey()
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA']
    })

    const duration = performance.now() - startTime
    logAuthTiming(logContextId, logXPair, duration, true)

    return payload
  } catch (err) {
    const duration = performance.now() - startTime
    logAuthTiming(logContextId, logXPair, duration, false)
    console.error('Error verifying JWT:', err.message)
    return false
  }
}

module.exports = { verifyJWT }
