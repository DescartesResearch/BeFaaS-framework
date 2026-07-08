
const { BaseCallProvider, preparePayloadWithAuth } = require('./shared/call')
const { startRpcTiming, logRpcIn } = require('./shared/metrics')
const lib = require('@befaas/lib')

const localHandlers = {}

let sharedDb = null

function initDb (dbType = 'redis') {
  if (!sharedDb) {
    const dbConnect = require('@befaas/lib/db').connect(dbType)
    const measurement = (name) => () => {}
    sharedDb = dbConnect(measurement)
    console.log(`Monolith database initialized: ${dbType}`)
  }
  return sharedDb
}

function getDb () {
  if (!sharedDb) {
    initDb('redis')
  }
  return sharedDb
}

function registerLocalHandler (functionName, handler) {
  localHandlers[functionName] = handler
}

function registerHandlers (handlers) {
  for (const [name, handler] of Object.entries(handlers)) {
    registerLocalHandler(name, handler)
  }
}

function getRegisteredFunctions () {
  return Object.keys(localHandlers)
}

class MonolithCallProvider extends BaseCallProvider {
  constructor (options = {}) {
    super(options)
    this.contextId = options.contextId || null
    this.xPair = options.xPair || null
    this.authPayload = options.authPayload || null
  }

  canCallLocally (functionName) {
    return !!localHandlers[functionName]
  }

  canDirectInvoke (functionName) {
    return false
  }

  async call (functionName, payload) {
    const handler = localHandlers[functionName]
    if (!handler) {
      throw new Error(`Function not found: ${functionName}. Registered: ${Object.keys(localHandlers).join(', ')}`)
    }

    const payloadWithHeaders = preparePayloadWithAuth(payload, this.authHeader)

    const callXPair = `${this.contextId || 'unknown'}-${lib.helper.generateRandomID()}`

    const endTiming = startRpcTiming(
      this.contextId || 'unknown',
      this.xPair || 'unknown',
      functionName,
      callXPair
    )

    // Log incoming RPC on the target function side
    logRpcIn(this.contextId || 'unknown', callXPair)

    // Create inner context for the called function
    const innerCtx = createCallContext(this.authHeader, this.contextId, callXPair, this.authPayload)

    try {
      const result = await handler(payloadWithHeaders, innerCtx)
      endTiming()
      return result
    } catch (error) {
      endTiming()
      console.error(`[LOCAL CALL ERROR] ${functionName}: ${error.message}`)
      throw error
    }
  }
}

function createCallContext (authHeader = null, contextId = null, xPair = null, authPayload = null) {
  const ctxId = contextId || lib.helper.generateRandomID()
  const pair = xPair || `${ctxId}-${lib.helper.generateRandomID()}`

  // Create provider with full tracing context
  const provider = new MonolithCallProvider({
    authHeader,
    contextId: ctxId,
    xPair: pair,
    authPayload
  })

  return {
    call: (functionName, payload) => provider.call(functionName, payload),
    db: getDb(),
    contextId: ctxId,
    xPair: pair,
    authPayload
  }
}

async function monolithCall (functionName, payload, authHeader = null) {
  const provider = new MonolithCallProvider({ authHeader })
  return provider.call(functionName, payload)
}

function createMonolithCall (authHeader) {
  const provider = new MonolithCallProvider({ authHeader })
  return (functionName, payload) => provider.call(functionName, payload)
}

module.exports = {
  MonolithCallProvider,
  monolithCall,
  createMonolithCall,
  createCallContext,
  registerLocalHandler,
  registerHandlers,
  getRegisteredFunctions,
  localHandlers,
  initDb,
  getDb
}
