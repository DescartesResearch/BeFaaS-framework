const express = require('express')
const cookieParser = require('cookie-parser')
const path = require('path')
const crypto = require('crypto')
const { configureBeFaaSLib, callService } = require('./shared/libConfig')
const { createBoundaryAuthMiddleware } = require('./shared/authMiddleware')
const { requiresAuth } = require('./shared/arch-shared/authConfig')

const { startHandlerTiming, logColdStartIfNeeded, createCallContext } = require('./shared/call')

const AUTH_REQUIRED_HTML_PATHS = {
  GET: new Set(['/cart']),
  POST: new Set(['/checkout', '/addCartItem', '/emptyCart'])
}

function frontendApiPathRequiresAuth (requestPath, method) {
  if (requestPath.startsWith('/api/')) {
    return requiresAuth(requestPath.slice('/api/'.length))
  }
  const methodPaths = AUTH_REQUIRED_HTML_PATHS[method]
  return !!(methodPaths && methodPaths.has(requestPath))
}

const login = require('./functions/login')
const register = require('./functions/register')

const frontendHandlers = require('./functions/frontend/handlers')

let Redis
try {
  Redis = require('ioredis')
} catch (e) {
  Redis = null
}

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(createBoundaryAuthMiddleware({ pathMatcher: frontendApiPathRequiresAuth }))

function generateRandomID () {
  return crypto.randomBytes(8).toString('hex')
}

app.use((req, res, next) => {
  if (req.path === '/health') {
    return next()
  }

  const contextId = req.headers['x-context'] || generateRandomID()
  const xPair = req.headers['x-pair'] || `${contextId}-${generateRandomID()}`

  req.contextId = contextId
  req.xPair = xPair

  const route = `${req.method.toLowerCase()}:${req.path}`

  const endTiming = startHandlerTiming(contextId, xPair, route)

  res.on('finish', () => {
    endTiming(res.statusCode)
  })

  next()
})

const { namespace } = configureBeFaaSLib()

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
let redis = null

function initRedis () {
  if (!Redis) {
    console.log('Redis client not available - skipping Redis initialization')
    return
  }
  try {
    redis = new Redis(redisUrl, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true
    })

    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message)
    })

    redis.on('connect', () => {
      console.log('Connected to Redis for user authentication')
    })

    redis.connect().catch(err => {
      console.error('Failed to connect to Redis:', err.message)
    })
  } catch (err) {
    console.error('Failed to initialize Redis:', err.message)
  }
}

initRedis()

let templatesInitialized = false
function ensureTemplatesInitialized () {
  if (!templatesInitialized) {
    try {
      const templatesPath = path.join(__dirname, 'functions', 'frontend')
      console.log(`Initializing frontend templates from: ${templatesPath}`)
      frontendHandlers.initTemplates(templatesPath)
      templatesInitialized = true
      console.log('Frontend templates initialized successfully')
    } catch (err) {
      console.error('Failed to initialize frontend templates:', err.message)
      throw err
    }
  }
}

function createContext (req, res, authHeader = null, state = {}) {
  const contextId = req.contextId || generateRandomID()
  const xPair = req.xPair || `${contextId}-${generateRandomID()}`

  const callCtx = createCallContext(authHeader, contextId, xPair)

  return {
    call: async (functionName, event) => {
      const eventWithHeaders = authHeader
        ? { ...event, headers: { authorization: authHeader } }
        : event

      if (functionName === 'login') {
        return await login(eventWithHeaders, createContext(req, res, authHeader, state))
      }
      if (functionName === 'register') {
        return await register(eventWithHeaders, createContext(req, res, authHeader, state))
      }
      return await callCtx.call(functionName, event)
    },
    db: {
      get: async (key) => {
        if (!redis) return null
        try {
          const value = await redis.get(key)
          return value ? JSON.parse(value) : null
        } catch (err) {
          console.error('Redis get error:', err.message)
          return null
        }
      },
      set: async (key, value) => {
        if (!redis) return
        try {
          if (value === null) {
            await redis.del(key)
          } else {
            await redis.set(key, JSON.stringify(value))
          }
        } catch (err) {
          console.error('Redis set error:', err.message)
        }
      }
    },
    request: { body: req.body, headers: req.headers },
    params: req.params,
    cookies: {
      get: (name) => req.cookies[name],
      set: (name, value, options) => res.cookie(name, value, options)
    },
    response: {
      redirect: (url) => {
        if (url === 'back') {
          res.redirect('back')
        } else {
          res.redirect(url)
        }
      }
    },
    state, // Per-request state for session storage (prevents race conditions)
    get type () { return res.get('Content-Type') },
    set type (v) { res.type(v) },
    get body () { return res._body },
    set body (v) { res._body = v; if (!res.headersSent) res.send(v) },
    get status () { return res.statusCode },
    set status (v) { res.status(v) }
  }
}

function wrapFrontendHandler (handler) {
  return async (req, res) => {
    try {
      ensureTemplatesInitialized()
      const authHeader = req.headers.authorization
      const ctx = createContext(req, res, authHeader)
      await handler(ctx)
    } catch (error) {
      console.error('Error in frontend handler:', error)
      res.status(500).json({ error: error.message })
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'frontend-service' })
})

app.get('/', wrapFrontendHandler(frontendHandlers.handleHome))
app.get('/product/:productId', wrapFrontendHandler(frontendHandlers.handleProduct))
app.get('/cart', wrapFrontendHandler(frontendHandlers.handleCart))
app.post('/checkout', wrapFrontendHandler(frontendHandlers.handleCheckout))
app.post('/setUser', wrapFrontendHandler(frontendHandlers.handleSetUser))
app.post('/register', wrapFrontendHandler(frontendHandlers.handleRegister))
app.post('/logout', wrapFrontendHandler(frontendHandlers.handleLogout))
app.post('/logoutAndLeave', wrapFrontendHandler(frontendHandlers.handleLogoutAndLeave))
app.post('/setCurrency', wrapFrontendHandler(frontendHandlers.handleSetCurrency))
app.post('/emptyCart', wrapFrontendHandler(frontendHandlers.handleEmptyCart))
app.post('/addCartItem', wrapFrontendHandler(frontendHandlers.handleAddCartItem))

app.post('/api/login', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const ctx = createContext(req, res, authHeader)
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const result = await login(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in login:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/register', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const ctx = createContext(req, res, authHeader)
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const result = await register(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in register:', error)
    res.status(500).json({ error: error.message })
  }
})

const port = process.env.PORT || 3000

app.listen(port, () => {
  console.log(`Frontend Service listening on port ${port}`)
  console.log(`Using Cloud Map namespace: ${namespace}`)
})

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server')
  process.exit(0)
})

module.exports = app
