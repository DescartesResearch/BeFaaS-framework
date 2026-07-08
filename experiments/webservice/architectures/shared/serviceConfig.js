
// Map functions to their owning service
const functionToService = {
  'cartkvstorage': 'cart',
  'getcart': 'cart',
  'addcartitem': 'cart',
  'emptycart': 'cart',

  'getproduct': 'product',
  'listproducts': 'product',
  'searchproducts': 'product',
  'listrecommendations': 'product',

  'checkout': 'order',
  'payment': 'order',
  'shiporder': 'order',
  'shipmentquote': 'order',
  'email': 'order',

  'getads': 'content',
  'supportedcurrencies': 'content',
  'currency': 'content',

  'frontend': 'frontend',
  'login': 'frontend',
  'register': 'frontend'
}

const serviceFunctions = {}
for (const [fn, service] of Object.entries(functionToService)) {
  if (!serviceFunctions[service]) {
    serviceFunctions[service] = []
  }
  serviceFunctions[service].push(fn)
}

const services = Object.keys(serviceFunctions)

const allFunctions = Object.keys(functionToService)

function getServiceForFunction (functionName) {
  return functionToService[functionName] || null
}

function getFunctionsForService (serviceName) {
  return serviceFunctions[serviceName] || []
}

function isSameService (fn1, fn2) {
  const s1 = functionToService[fn1]
  const s2 = functionToService[fn2]
  return s1 && s2 && s1 === s2
}

module.exports = {
  functionToService,
  serviceFunctions,
  services,
  allFunctions,
  getServiceForFunction,
  getFunctionsForService,
  isSameService
}