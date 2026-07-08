const express = require('express')
const { configureBeFaaSLib, callService } = require('./shared/libConfig')
const { createBoundaryAuthMiddleware } = require('./shared/authMiddleware')

const checkout = require('./functions/checkout')
const payment = require('./functions/payment')
const shipmentQuote = require('./functions/shipmentquote')
const shipOrder = require('./functions/shiporder')
const email = require('./functions/email')

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

      if (functionName === 'payment') {
        return await payment(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      if (functionName === 'shipmentquote') {
        return await shipmentQuote(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      if (functionName === 'email') {
        return await email(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }
      if (functionName === 'shiporder') {
        return await shipOrder(eventWithHeaders, createContext(authHeader, contextId, xPair, authPayload))
      }

      return await callService(functionName, event, authHeader)
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'order-service' })
})

app.post('/checkout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const result = await checkout(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in checkout:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/payment', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const result = await payment(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in payment:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/shipmentquote', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const result = await shipmentQuote(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in shipmentquote:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/email', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const result = await email(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in email:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/shiporder', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    const event = authHeader
      ? { ...req.body, headers: { authorization: authHeader } }
      : req.body
    const ctx = createContext(authHeader, req.headers['x-context'], req.headers['x-pair'], req.authPayload || null)
    const result = await shipOrder(event, ctx)
    res.json(result)
  } catch (error) {
    console.error('Error in shiporder:', error)
    res.status(500).json({ error: error.message })
  }
})

const port = process.env.PORT || 3003

app.listen(port, () => {
  console.log(`Order Service listening on port ${port}`)
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
