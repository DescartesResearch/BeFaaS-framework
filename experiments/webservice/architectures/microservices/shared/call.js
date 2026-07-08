
const axios = require('axios')
const crypto = require('crypto')

const { BaseCallProvider, preparePayloadWithAuth, buildCallHeaders } = require('./arch-shared/call')
const { getServiceForFunction } = require('./arch-shared/serviceConfig')
const { startRpcTiming, logRpcIn, startHandlerTiming, logColdStartIfNeeded } = require('./arch-shared/metrics')

const namespace = process.env.CLOUDMAP_NAMESPACE

const currentService = process.env.CURRENT_SERVICE || null

const isAWS = namespace && namespace !== 'local'

const localHandlers = {}

// eslint-disable-next-line multiline-ternary
const serviceUrls = isAWS ? {
  cart: `http://cart-service.${namespace}:3002`,
  product: `http://product-service.${namespace}:3001`,
  order: `http://order-service.${namespace}:3003`,
  content: `http://content-service.${namespace}:3004`,
  frontend: `http://frontend-service.${namespace}:3000`
} : {
  cart: process.env.CART_SERVICE_URL || 'http://cart-service:3002',
  product: process.env.PRODUCT_SERVICE_URL || 'http://product-service:3001',
  order: process.env.ORDER_SERVICE_URL || 'http://order-service:3003',
  content: process.env.CONTENT_SERVICE_URL || 'http://content-service:3004',
  frontend: process.env.FRONTEND_SERVICE_URL || 'http://frontend-service:3000'
}

function getFunctionEndpoint (functionName) {
  const service = getServiceForFunction(functionName)
  if (!service || !serviceUrls[service]) {
    return null
  }

  // Frontend service uses /api prefix
  if (service === 'frontend') {
    return `${serviceUrls[service]}/api/${functionName}`
  }

  return `${serviceUrls[service]}/${functionName}`
}

function registerLocalHandler (functionName, handler) {
  localHandlers[functionName] = handler
}

function generateRandomID () {
  return crypto.randomBytes(8).toString('hex')
}

class MicroservicesCallProvider extends BaseCallProvider {
  constructor (options = {}) {
    super(options)
    this.currentService = options.currentService || currentService
    this.contextId = options.contextId || null
    this.xPair = options.xPair || null
  }

  canCallLocally (functionName) {
    const targetService = getServiceForFunction(functionName)
    return (
      this.currentService &&
      targetService === this.currentService &&
      !!localHandlers[functionName]
    )
  }

  canDirectInvoke (functionName) {
    return false
  }

  async call (functionName, payload) {
    const payloadWithHeaders = preparePayloadWithAuth(payload, this.authHeader)

    const callXPair = `${this.contextId || 'unknown'}-${generateRandomID()}`

    if (this.canCallLocally(functionName)) {
      const endTiming = startRpcTiming(
        this.contextId || 'unknown',
        this.xPair || 'unknown',
        functionName,
        callXPair
      )

      logRpcIn(this.contextId || 'unknown', callXPair)

      try {
        const result = await localHandlers[functionName](payloadWithHeaders)
        endTiming()
        return result
      } catch (error) {
        endTiming()
        console.error(`[LOCAL CALL ERROR] ${functionName}: ${error.message}`)
        throw error
      }
    }

    const endpoint = getFunctionEndpoint(functionName)
    if (!endpoint) {
      throw new Error(`Unknown function: ${functionName}`)
    }

    const endTiming = startRpcTiming(
      this.contextId || 'unknown',
      this.xPair || 'unknown',
      functionName,
      callXPair
    )

    const headers = buildCallHeaders({
      authHeader: this.authHeader,
      contextId: this.contextId,
      xPair: callXPair
    })

    try {
      const response = await axios.post(endpoint, payloadWithHeaders, {
        headers,
        timeout: 30000
      })
      endTiming()
      return response.data
    } catch (error) {
      endTiming()
      console.error(`[HTTP CALL ERROR] ${functionName}: ${error.message}`)
      if (error.response) {
        return error.response.data
      }
      throw error
    }
  }
}

async function callService (functionName, payload, authHeader = null) {
  const provider = new MicroservicesCallProvider({ authHeader })
  return provider.call(functionName, payload)
}

function createServiceCall (authHeader) {
  const provider = new MicroservicesCallProvider({ authHeader })
  return (functionName, payload) => provider.call(functionName, payload)
}

function createCallContext (authHeader = null, contextId = null, xPair = null) {
  const ctxId = contextId || generateRandomID()
  const pair = xPair || `${ctxId}-${generateRandomID()}`

  const provider = new MicroservicesCallProvider({
    authHeader,
    contextId: ctxId,
    xPair: pair
  })

  return {
    call: (functionName, payload) => provider.call(functionName, payload),
    contextId: ctxId,
    xPair: pair
  }
}

function configureBeFaaSLib () {
  const environment = isAWS ? `AWS (namespace: ${namespace})` : 'local Docker Compose'
  console.log(`Microservices HTTP calls configured for ${environment}`)

  return {
    namespace,
    isAWS,
    callService,
    currentService
  }
}

const lib = {
  call: callService,
  init: () => console.log('lib.init() - no-op for microservices'),
  shutdown: async () => console.log('lib.shutdown() - no-op for microservices'),
  configure: () => {},
  context: (overrides = {}) => ({
    call: overrides.call || callService,
    ...overrides
  })
}

module.exports = {
  MicroservicesCallProvider,
  callService,
  createServiceCall,
  createCallContext,
  registerLocalHandler,
  configureBeFaaSLib,
  lib,
  currentService,
  serviceUrls,
  isAWS,
  namespace,
  localHandlers,
  getFunctionEndpoint,
  generateRandomID,
  startHandlerTiming,
  logColdStartIfNeeded,
  logRpcIn
}
