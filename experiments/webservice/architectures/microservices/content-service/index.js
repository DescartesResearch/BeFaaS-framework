const express = require('express')
const { configureBeFaaSLib, callService } = require('./shared/libConfig')
const { createBoundaryAuthMiddleware } = require('./shared/authMiddleware')

const getAds = require('./functions/getads')
const supportedCurrencies = require('./functions/supportedcurrencies')
const currency = require('./functions/currency')

const app = express()
app.use(express.json())
app.use(createBoundaryAuthMiddleware())

const { namespace } = configureBeFaaSLib()

function createContext (authHeader = null, contextId = null, xPair = null, authPayload = null) {
  return {
    contextId,
    xPair,
    authPayload,
    call: async (functionName, event) => {
      const eventWithHeaders = authHeader
        ? { ...event, headers: { authorization: authHeader } }
        : event

      if (functionName === 'getads') {
        return await getAds(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      if (functionName === 'supportedcurrencies') {
        return await supportedCurrencies(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      if (functionName === 'currency') {
        return await currency(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      return await callService(functionName, event, authHeader)
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'content-service' })
})

app.post('/getads', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const result = await getAds(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in getads:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/supportedcurrencies', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const result = await supportedCurrencies(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in supportedcurrencies:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/currency', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const result = await currency(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in currency:', error)
    res.status(500).json({ error: error.message })
  }
})

const port = process.env.PORT || 3004

app.listen(port, () => {
  console.log(`Content Service listening on port ${port}`)
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