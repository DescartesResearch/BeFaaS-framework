
const lodash = require('lodash')
const fetch = require('node-fetch')
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda')

const { BaseCallProvider, preparePayloadWithAuth, buildCallHeaders } = require('./shared/call')
const { startRpcTiming } = require('./shared/metrics')

const helper = require('@befaas/lib/helper')
const experiment = helper.loadExperiment()

const endpoints = {
  aws: process.env.AWS_LAMBDA_ENDPOINT,
  google: process.env.GOOGLE_CLOUDFUNCTION_ENDPOINT,
  azure: process.env.AZURE_FUNCTIONS_ENDPOINT,
  tinyfaas: process.env.TINYFAAS_ENDPOINT,
  openfaas: process.env.OPENFAAS_ENDPOINT,
  openwhisk: process.env.OPENWHISK_ENDPOINT
}

const publisherEndpoints = {
  aws: process.env.PUBLISHER_AWS_ENDPOINT,
  google: process.env.PUBLISHER_GOOGLE_ENDPOINT,
  azure: process.env.PUBLISHER_AZURE_ENDPOINT,
  tinyfaas: process.env.PUBLISHER_TINYFAAS_ENDPOINT
}

const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME

const directInvokeEnabled = process.env.DIRECT_INVOKE_ENABLED !== 'false'

let lambdaClient = null

function getLambdaClient () {
  if (!lambdaClient) {
    lambdaClient = new LambdaClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
    })
  }
  return lambdaClient
}

function getLambdaFunctionName (fn) {
  const envKey = `LAMBDA_FN_${fn.toUpperCase()}`
  return process.env[envKey] || null
}

function isDirectInvokeAvailable (fn) {
  if (!isLambda || !directInvokeEnabled) {
    return false
  }
  return !!getLambdaFunctionName(fn)
}

async function directInvoke (fn, payload, headers = {}) {
  const functionName = getLambdaFunctionName(fn)
  if (!functionName) {
    throw new Error(`Direct invoke not available for function: ${fn}`)
  }

  const client = getLambdaClient()

  const event = {
    version: '2.0',
    routeKey: 'POST /call',
    rawPath: `/${fn}/call`,
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    requestContext: {
      http: {
        method: 'POST',
        path: `/${fn}/call`
      },
      routeKey: 'POST /call',
      stage: '$default'
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false
  }

  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify(event)
  })

  const response = await client.send(command)
  const responsePayload = JSON.parse(Buffer.from(response.Payload).toString())

  if (response.FunctionError) {
    const errorMsg = `[DIRECT INVOKE ERROR] ${fn} failed: ${responsePayload.errorMessage || 'Unknown error'}`
    console.error(errorMsg)
    const error = new Error(errorMsg)
    error.functionName = fn
    error.lambdaError = responsePayload
    throw error
  }

  if (responsePayload.statusCode && responsePayload.statusCode >= 400) {
    const errorMsg = `[DIRECT INVOKE ERROR] ${fn} returned ${responsePayload.statusCode}: ${responsePayload.body}`
    console.error(errorMsg)
    const error = new Error(errorMsg)
    error.statusCode = responsePayload.statusCode
    error.functionName = fn
    error.responseBody = responsePayload.body
    throw error
  }

  try {
    return typeof responsePayload.body === 'string'
      ? JSON.parse(responsePayload.body)
      : responsePayload.body || responsePayload
  } catch (e) {
    console.error(`[DIRECT INVOKE ERROR] ${fn} JSON parse failed: ${e.message}`)
    throw e
  }
}

class FaaSCallProvider extends BaseCallProvider {
  constructor (options = {}) {
    super(options)
    this.contextId = options.contextId || null
    this.xPair = options.xPair || null
  }

  canDirectInvoke (functionName) {
    const provider = lodash.get(experiment, `program.functions.${functionName}.provider`)
    return provider === 'aws' && isDirectInvokeAvailable(functionName)
  }

  canCallLocally (functionName) {
    return false
  }

  async call (functionName, payload) {
    if (!lodash.isObject(payload)) throw new Error('payload is not an object')

    let provider = ''
    if (functionName === 'publisher') {
      const targetFn = payload.fun
      provider = lodash.get(experiment, `program.functions.${targetFn}.provider`)
      if (!publisherEndpoints[provider]) throw new Error('unknown publisher provider')
    } else {
      provider = lodash.get(experiment, `program.functions.${functionName}.provider`)
      if (!endpoints[provider]) throw new Error('unknown provider')
    }

    const bodyWithHeaders = preparePayloadWithAuth(payload, this.authHeader)

    const headers = buildCallHeaders({
      authHeader: this.authHeader,
      contextId: this.contextId,
      xPair: this.xPair
    })

    if (provider === 'aws' && functionName !== 'publisher' && isDirectInvokeAvailable(functionName)) {
      return await directInvoke(functionName, bodyWithHeaders, headers)
    }

    const endpoint = functionName === 'publisher'
      ? `${publisherEndpoints[provider]}/call`
      : `${endpoints[provider]}/${functionName}/call`

    const res = await fetch(endpoint, {
      method: 'post',
      body: JSON.stringify(bodyWithHeaders || {}),
      headers
    })

    const text = await res.text()
    if (!res.ok) {
      const errorMsg = `[CALL ERROR] ${functionName} returned ${res.status}: ${text.substring(0, 500)}`
      console.error(errorMsg)
      const error = new Error(errorMsg)
      error.statusCode = res.status
      error.functionName = functionName
      error.responseBody = text
      throw error
    }

    try {
      return JSON.parse(text)
    } catch (e) {
      console.error(`[CALL ERROR] ${functionName} JSON parse failed: ${e.message}, body: ${text.substring(0, 200)}`)
      throw e
    }
  }
}

async function faasCall (fn, contextId, xPair, payload, authHeader = null) {
  const provider = new FaaSCallProvider({
    authHeader,
    contextId,
    xPair
  })
  return provider.call(fn, payload)
}

function createAuthCall (ctx, authHeader) {
  const helper = require('@befaas/lib/helper')

  return async (fn, payload) => {
    const callXPair = `${ctx.contextId}-${helper.generateRandomID()}`

    const endTiming = startRpcTiming(ctx.contextId, ctx.xPair, fn, callXPair)

    try {
      const res = await faasCall(fn, ctx.contextId, callXPair, payload, authHeader)
      return res
    } finally {
      endTiming()
    }
  }
}

module.exports = {
  FaaSCallProvider,
  faasCall,
  createAuthCall,
  authCall: faasCall
}
