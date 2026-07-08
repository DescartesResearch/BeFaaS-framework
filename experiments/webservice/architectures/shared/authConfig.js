
const authRequiredFunctions = new Set([
  'getcart',
  'addcartitem',
  'emptycart',
  'cartkvstorage',
  'checkout',
  'payment'
])

const publicFunctions = new Set([
  'listproducts',
  'getproduct',
  'searchproducts',
  'listrecommendations',
  'getads',
  'supportedcurrencies',
  'currency',
  'shipmentquote',
  'shiporder',
  'email',
  'frontend',
  'login',
  'register'
])

function requiresAuth (functionName) {
  return authRequiredFunctions.has(functionName)
}

function isPublic (functionName) {
  return publicFunctions.has(functionName)
}

module.exports = {
  requiresAuth,
  isPublic,
  authRequiredFunctions,
  publicFunctions
}
