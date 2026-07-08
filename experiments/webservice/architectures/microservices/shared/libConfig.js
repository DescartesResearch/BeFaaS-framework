
const {
  MicroservicesCallProvider,
  callService,
  createServiceCall,
  registerLocalHandler,
  configureBeFaaSLib,
  lib,
  currentService,
  serviceUrls,
  isAWS,
  namespace,
  localHandlers,
  getFunctionEndpoint
} = require('./call')

const { functionToService } = require('./arch-shared/serviceConfig')

const functionEndpoints = {}
for (const functionName of Object.keys(functionToService)) {
  functionEndpoints[functionName] = getFunctionEndpoint(functionName)
}

module.exports = {
  MicroservicesCallProvider,
  createServiceCall,
  getFunctionEndpoint,
  configureBeFaaSLib,
  lib,
  callService,
  registerLocalHandler,
  currentService,
  functionToService,
  functionEndpoints,
  serviceUrls,
  isAWS,
  namespace,
  localHandlers
}