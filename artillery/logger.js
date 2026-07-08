const lib = require('@befaas/lib')
const fs = require('fs')
const path = require('path')
const { performance } = require('perf_hooks')

const LIB_VERSION = require('@befaas/lib/package.json').version
const deploymentId =
  process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId'

const fnName = 'artillery'

// This is a workaround to artillery not resolving variables before the beforeRequest callback
// this results in the url field being {{ functionName }} instead of the actual url
function resolveVar (url, context) {
  const regex = /{{\s*\w+\s*}}/gm
  const match = url.match(regex)
  if (!match) return url
  for (var i = 0; i < match.length; i++) {
    const varname = match[i].match(/\w+/gm)
    url = url.replace(match[i], context.vars[varname])
  }
  return url
}

function logEvent (event, phase = null) {
  const logData = {
    version: LIB_VERSION,
    deploymentId,
    timestamp: new Date().getTime(),
    now: performance.now(),
    fn: {
      id: '',
      name: fnName
    },
    event
  }

  if (phase !== null) {
    logData.phase = phase
  }

  console.log('BEFAAS' + JSON.stringify(logData))
}

const yaml = require('js-yaml')

let phases = null
let experimentStartTime = null

function loadPhases () {
  if (phases !== null) return phases

  try {
    const workloadPath = path.resolve(__dirname, 'workload.yml')
    const workloadContent = fs.readFileSync(workloadPath, 'utf8')
    const config = yaml.load(workloadContent)

    if (config && config.config && Array.isArray(config.config.phases)) {
      phases = config.config.phases.map((phase, index) => ({
        index,
        name: phase.name || null,
        duration: phase.duration || 0
      }))
      console.log('BEFAAS_PHASES_LOADED' + JSON.stringify(phases))
    } else {
      phases = []
    }
  } catch (e) {
    console.error('BEFAAS_PHASES_ERROR: Could not load workload.yml:', e.message)
    phases = []
  }

  return phases
}

function getPhaseInfo () {
  const loadedPhases = loadPhases()
  if (loadedPhases.length === 0) return null

  // Initialize experiment start time on first call
  if (experimentStartTime === null) {
    experimentStartTime = Date.now()
  }

  const elapsedSeconds = (Date.now() - experimentStartTime) / 1000
  let cumulativeTime = 0

  for (const phase of loadedPhases) {
    cumulativeTime += phase.duration
    if (elapsedSeconds < cumulativeTime) {
      return {
        index: phase.index,
        name: phase.name
      }
    }
  }

  // Past all phases - return last phase
  const lastPhase = loadedPhases[loadedPhases.length - 1]
  return {
    index: lastPhase.index,
    name: lastPhase.name
  }
}

function beforeAuthRequest (requestParams, context, ee, next) {
  return beforeRequest(requestParams, context, ee, next, 'auth')
}

function beforeAnonymousRequest (requestParams, context, ee, next) {
  return beforeRequest(requestParams, context, ee, next, 'anonymous')
}

function beforeFailedAuthRequest (requestParams, context, ee, next) {
  return beforeRequest(requestParams, context, ee, next, 'failed-auth')
}

function beforeScenario (context, ee, next) {
  const phase = getPhaseInfo()
  logEvent({
    type: 'scenario-start',
    scenarioName: context.scenario?.name || 'unknown'
  }, phase)
  return next()
}

function beforeRequest (requestParams, context, ee, next, authType) {
  const url = resolveVar(requestParams.url, context)
  const contextId = lib.helper.generateRandomID()
  const xPair = `${contextId}-${lib.helper.generateRandomID()}`

  // Preserve existing headers (including Authorization set by Artillery)
  if (!requestParams.headers) {
    requestParams.headers = {}
  }

  requestParams.headers['x-context'] = contextId
  requestParams.headers['x-pair'] = xPair

  if (context.vars.token && !requestParams.headers.Authorization) {
    requestParams.headers.Authorization = `Bearer ${context.vars.token}`
  }

  const phase = getPhaseInfo()
  logEvent({ url, contextId, xPair, type: 'before', authType }, phase)
  return next()
}

function afterResponse (requestParams, response, context, ee, next, authType) {
  const phase = getPhaseInfo()
  const eventData = {
    url: requestParams.url,
    contextId: requestParams.headers['x-context'],
    xPair: requestParams.headers['x-pair'],
    type: 'after',
    authType,
    statusCode: response.statusCode
  }

  if (authType === 'auth' && requestParams.url && requestParams.url.includes('/setUser')) {
    eventData.responseHeaders = response.headers
    if (response.body) {
      const bodyStr = typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
      eventData.responseBodyPreview = bodyStr.substring(0, 500)
    }
    eventData.tokenCaptured = !!context.vars.token
  }

  logEvent(eventData, phase)

  return next()
}

function afterAuthResponse (requestParams, response, context, ee, next) {
  return afterResponse(requestParams, response, context, ee, next, 'auth')
}

function afterAnonymousResponse (requestParams, response, context, ee, next) {
  return afterResponse(requestParams, response, context, ee, next, 'anonymous')
}

function afterFailedAuthResponse (requestParams, response, context, ee, next) {
  return afterResponse(requestParams, response, context, ee, next, 'failed-auth')
}

const timestamp = Math.round(Date.now() / 1000)

function emergencyNever (requestParams, context, ee, next) {
  requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-noambulance.jpg'))
  return beforeRequest(requestParams, context, ee, next)
}

function singleEmergency (requestParams, context, ee, next) {
  const now = Math.round(Date.now() / 1000)
  if (now - timestamp > 300) { // after 5 minutes (10 seconds before end of workload) send in ambulance
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-ambulance.jpg'))
  } else {
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-noambulance.jpg'))
  }
  return beforeRequest(requestParams, context, ee, next)
}

function emergencyScaling (requestParams, context, ee, next) {
  const now = Math.round(Date.now() / 1000)
  const phases = [1, 2, 3, 4, 5, 6, 7].map(x => x * 120)
  let emergency = false

  for (const phase of phases) {
    if (now - timestamp > phase && now - timestamp < phase + 5) {
      emergency = true
    }
  }

  if (emergency) {
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-ambulance.jpg'))
  } else {
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-noambulance.jpg'))
  }

  return beforeRequest(requestParams, context, ee, next)
}

function emergencyEveryTwoMinutesFiveSecondsEach (requestParams, context, ee, next) {
  const now = Math.round(Date.now() / 1000)
  if (((now - timestamp) % 120) < 5) {
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-ambulance.jpg'))
  } else {
    requestParams.formData.image = fs.createReadStream(path.resolve(__dirname, 'image-noambulance.jpg'))
  }

  return beforeRequest(requestParams, context, ee, next)
}

module.exports = {
  beforeScenario,
  beforeAuthRequest,
  beforeAnonymousRequest,
  beforeFailedAuthRequest,
  afterAuthResponse,
  afterAnonymousResponse,
  afterFailedAuthResponse,
  singleEmergency,
  emergencyEveryTwoMinutesFiveSecondsEach,
  emergencyNever,
  emergencyScaling
}
