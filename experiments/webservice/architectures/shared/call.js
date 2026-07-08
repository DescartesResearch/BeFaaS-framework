
class BaseCallProvider {
  constructor (options = {}) {
    this.authHeader = options.authHeader || null
  }

  async call (functionName, payload) {
    throw new Error('call() must be implemented by architecture-specific provider')
  }

  canCallLocally (functionName) {
    return false
  }

  canDirectInvoke (functionName) {
    return false
  }
}

function preparePayloadWithAuth (payload, authHeader) {
  if (!authHeader) {
    return payload
  }
  return {
    ...payload,
    headers: { authorization: authHeader }
  }
}

function buildCallHeaders ({ authHeader, contextId, xPair }) {
  const headers = {
    'content-type': 'application/json'
  }
  if (contextId) {
    headers['x-context'] = contextId
  }
  if (xPair) {
    headers['x-pair'] = xPair
  }
  if (authHeader) {
    headers.authorization = authHeader
  }
  return headers
}

module.exports = {
  BaseCallProvider,
  preparePayloadWithAuth,
  buildCallHeaders
}
