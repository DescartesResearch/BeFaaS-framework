const { requiresAuth } = require('./arch-shared/authConfig')
const { verifyJWT } = require('../auth')

const AUTH_GRANULARITY = process.env.BEFAAS_AUTH_GRANULARITY || 'per-function'

function pathRequiresAuth (requestPath) {
  const fnName = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath
  return requiresAuth(fnName)
}

function createBoundaryAuthMiddleware ({ pathMatcher = pathRequiresAuth } = {}) {
  return async function authBoundary (req, res, next) {
    if (AUTH_GRANULARITY !== 'per-service') {
      return next()
    }

    if (!pathMatcher(req.path, req.method)) {
      return next()
    }

    const authHeader = req.headers.authorization || req.headers.Authorization
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const event = { headers: { authorization: authHeader } }
    const contextId = req.headers['x-context'] || req.headers['x-context-id']
    const xPair = req.headers['x-pair']

    try {
      const payload = await verifyJWT(event, contextId, xPair)
      if (!payload) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      req.authPayload = payload
      return next()
    } catch (err) {
      if (err && err.isAuthTimeout) {
        return res.status(424).json({ error: 'AuthTimeout' })
      }
      return next(err)
    }
  }
}

module.exports = {
  createBoundaryAuthMiddleware,
  pathRequiresAuth,
  AUTH_GRANULARITY
}
