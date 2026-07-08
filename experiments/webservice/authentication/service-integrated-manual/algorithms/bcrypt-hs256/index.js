const jwt = require('jsonwebtoken')
const { performance } = require('perf_hooks')

const JWT_SECRET = process.env.JWT_SECRET || 'befaas-default-secret-change-in-production'
const fnName = process.env.BEFAAS_FN_NAME || 'unknownFn'
const deploymentId = process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId'

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

    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256']
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
