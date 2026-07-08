
const lib = require('@befaas/lib')
const _ = require('lodash')
const fs = require('fs')
const path = require('path')

function getStorageObj(ctx) {
  if (!ctx.state) ctx.state = {}
  if (!ctx.state.storageObj) ctx.state.storageObj = {}
  return ctx.state.storageObj
}

function loadTemplates (basePath) {
  const templatesPath = basePath || __dirname
  const templatesDir = path.join(templatesPath, 'html_templates')

  if (!fs.existsSync(templatesDir)) {
    console.error(`Templates directory not found: ${templatesDir}`)
    console.error(`Current directory: ${__dirname}`)
    console.error(`Base path: ${basePath}`)
    throw new Error(`Templates directory not found: ${templatesDir}`)
  }

  const templateFiles = ['home.html', 'product.html', 'cart.html', 'order.html']
  for (const file of templateFiles) {
    const filePath = path.join(templatesDir, file)
    if (!fs.existsSync(filePath)) {
      console.error(`Template file not found: ${filePath}`)
      throw new Error(`Template file not found: ${filePath}`)
    }
  }

  return {
    home: _.template(
      fs.readFileSync(path.join(templatesDir, 'home.html'))
    ),
    product: _.template(
      fs.readFileSync(path.join(templatesDir, 'product.html'))
    ),
    cart: _.template(
      fs.readFileSync(path.join(templatesDir, 'cart.html'))
    ),
    order: _.template(
      fs.readFileSync(path.join(templatesDir, 'order.html'))
    )
  }
}

let templates = null
function getTemplates(basePath) {
  if (!templates) {
    templates = loadTemplates(basePath)
  }
  return templates
}

function initTemplates(basePath) {
  templates = loadTemplates(basePath)
}

function getCookies(ctx) {
  const storageObj = getStorageObj(ctx)
  const newMockedCookies = ctx.cookies.get('storageObj')
  if (newMockedCookies) {
    Object.assign(storageObj, JSON.parse(newMockedCookies))
  }
}

function storeCookies(ctx) {
  const storageObj = getStorageObj(ctx)
  ctx.cookies.set('storageObj', JSON.stringify(storageObj), { overwrite: true, sameSite: true })
}

function getSessionID(ctx) {
  const storageObj = getStorageObj(ctx)
  if (!storageObj.sessionId) {
    storageObj.sessionId = lib.helper.generateRandomID()
  }
  return storageObj.sessionId
}

function getUserCurrency(ctx) {
  const storageObj = getStorageObj(ctx)
  return storageObj.userCurrency || 'EUR'
}

function getUserName(ctx) {
  const storageObj = getStorageObj(ctx)
  return storageObj.userName || ''
}

function getCartSize(ctx) {
  const storageObj = getStorageObj(ctx)
  return _.parseInt(storageObj.cartSize) || 0
}

function increaseCartSize(ctx, inc) {
  const storageObj = getStorageObj(ctx)
  storageObj.cartSize = getCartSize(ctx) + inc
}

function emptyCartSize(ctx) {
  const storageObj = getStorageObj(ctx)
  storageObj.cartSize = 0
}

function getJWTToken(ctx) {
  const storageObj = getStorageObj(ctx)
  return storageObj.jwtToken || ''
}

async function convertPrice(ctx, priceUsd) {
  if (getUserCurrency(ctx) === 'USD') {
    return priceUsd
  }
  return ctx.call('currency', {
    from: priceUsd,
    toCode: getUserCurrency(ctx)
  })
}

function addPrice(a, b) {
  const nanos = (a.nanos + b.nanos) % 1e9
  const units = Math.trunc((a.nanos + b.nanos) / 1e9) + a.units + b.units
  return {
    currencyCode: a.currencyCode,
    nanos: nanos,
    units: units
  }
}

function scalePrice(price, scalar) {
  const nanos = (price.nanos * scalar) % 1e9
  const units = Math.trunc((price.nanos * scalar) / 1e9) + price.units * scalar
  return {
    currencyCode: price.currencyCode,
    nanos: nanos,
    units: units
  }
}

function printPrice(price) {
  return (
    _.toString(price.units) +
    '.' +
    _.toString(price.nanos).substr(0, 2) +
    ' ' +
    price.currencyCode
  )
}

function setupAuth(ctx) {
  getCookies(ctx)
  const incomingAuth = ctx.request?.headers?.authorization
  const token = incomingAuth
    ? incomingAuth.replace(/^Bearer\s+/i, '')
    : getJWTToken(ctx)
  if (token) {
    const originalCall = ctx.call.bind(ctx)
    ctx.call = async (fn, payload) => {
      const enrichedPayload = {
        ...payload,
        headers: { authorization: `Bearer ${token}` }
      }
      return await originalCall(fn, enrichedPayload)
    }
  }
}

async function handleHome(ctx) {
  setupAuth(ctx)
  const requestId = lib.helper.generateRandomID()
  const [supportedCurrencies, productList, cats] = await Promise.all([
    ctx.call('supportedcurrencies', {}),
    ctx.call('listproducts', {}),
    ctx.call('getads', {})
  ])

  const products = await Promise.all(
    productList.products.map(async p =>
      Object.assign({ price: await convertPrice(ctx, p.priceUsd) }, p)
    )
  )

  const options = {
    session_id: getSessionID(ctx),
    request_id: requestId,
    user_id: getUserName(ctx),
    user_currency: getUserCurrency(ctx),
    currencies: supportedCurrencies.currencyCodes,
    products,
    cart_size: getCartSize(ctx),
    banner_color: 'white',
    ads: cats.ads
  }
  ctx.type = 'text/html'
  storeCookies(ctx)
  ctx.body = getTemplates().home(options)
}

async function handleProduct(ctx) {
  setupAuth(ctx)
  const productId = ctx.params.productId

  const requestId = lib.helper.generateRandomID()
  const product = await ctx.call('getproduct', { id: productId })

  if (product.error) {
    ctx.type = 'application/json'
    ctx.body = product
    ctx.status = 422
    return
  }

  const [price, supportedCurrencies, recommendedIds, cat] = await Promise.all([
    convertPrice(ctx, product.priceUsd),
    ctx.call('supportedcurrencies', {}),
    ctx.call('listrecommendations', {
      userId: getUserName(ctx),
      productIds: [productId]
    }),
    ctx.call('getads', {})
  ])

  product.price = price

  const options = {
    session_id: getSessionID(ctx),
    request_id: requestId,
    product: product,
    user_id: getUserName(ctx),
    user_currency: getUserCurrency(ctx),
    currencies: supportedCurrencies.currencyCodes,
    recommendations: recommendedIds.productIds,
    cart_size: getCartSize(ctx),
    ad: cat.ads[0]
  }
  ctx.type = 'text/html'
  storeCookies(ctx)
  ctx.body = getTemplates().product(options)
}

async function handleCart(ctx) {
  setupAuth(ctx)
  const requestId = lib.helper.generateRandomID()

  const cartResult = await ctx.call('getcart', { userId: getUserName(ctx) })

  if (cartResult?.error) {
    if (cartResult.error === 'AuthTimeout') {
      ctx.status = 424
      ctx.body = { error: 'Get cart failed', message: 'Authentication service timeout' }
      return
    }
    ctx.status = cartResult.statusCode || 400
    ctx.body = { error: cartResult.error }
    return
  }

  const cart = cartResult.items || []

  const products = await Promise.all(
    cart.map(async i =>
      Object.assign(
        { quantity: i.quantity },
        await ctx.call('getproduct', { id: i.productId })
      )
    )
  )

  const productsWithPrice = await Promise.all(
    products.map(async p =>
      Object.assign(
        { price: scalePrice(await convertPrice(ctx, p.priceUsd), p.quantity) },
        p
      )
    )
  )

  const [shippingCostUsd, supportedCurrencies] = await Promise.all([
    ctx.call('shipmentquote', { items: cart }),
    ctx.call('supportedcurrencies', {})
  ])
  const shippingCost = await convertPrice(ctx, shippingCostUsd.costUsd)

  const totalCost = _.reduce(
    _.map(productsWithPrice, 'price'),
    addPrice,
    shippingCost
  )

  const options = {
    session_id: getSessionID(ctx),
    request_id: requestId,
    items: productsWithPrice,
    user_id: getUserName(ctx),
    user_currency: getUserCurrency(ctx),
    currencies: supportedCurrencies.currencyCodes,
    cart_size: getCartSize(ctx),
    shipping_cost: shippingCost,
    total_cost: totalCost,
    credit_card_expiration_years: _.range(
      new Date().getFullYear(),
      new Date().getFullYear() + 10
    )
  }

  ctx.type = 'text/html'
  storeCookies(ctx)
  ctx.body = getTemplates().cart(options)
}

async function handleCheckout(ctx) {
  setupAuth(ctx)
  emptyCartSize(ctx)
  const requestId = lib.helper.generateRandomID()

  const order = ctx.request.body
  const [supportedCurrencies, checkoutResult] = await Promise.all([
    ctx.call('supportedcurrencies', {}),
    ctx.call('checkout', {
      userId: getUserName(ctx),
      userCurrency: getUserCurrency(ctx),
      address: {
        streetAddress: order.street_address,
        city: order.city,
        state: order.state,
        country: order.country,
        zipCode: _.parseInt(order.zip_code)
      },
      email: order.email,
      creditCard: {
        creditCardNumber: order.credit_card_number,
        creditCardCvv: _.parseInt(order.credit_card_cvv),
        creditCardExpirationYear: _.parseInt(order.credit_card_expiration_year),
        creditCardExpirationMonth: _.parseInt(order.credit_card_expiration_month)
      }
    })
  ])

  if (!checkoutResult || !checkoutResult.order) {
    if (checkoutResult?.error === 'AuthTimeout') {
      ctx.status = 424
      ctx.body = { error: 'Checkout failed', message: 'Authentication service timeout' }
      return
    }
    ctx.status = checkoutResult?.statusCode || 400
    ctx.body = { error: checkoutResult?.error || 'Checkout failed' }
    return
  }

  const options = {
    session_id: getSessionID(ctx),
    request_id: requestId,
    user_id: getUserName(ctx),
    user_currency: getUserCurrency(ctx),
    currencies: supportedCurrencies.currencyCodes,
    cart_size: 0,
    shipping_cost: printPrice(checkoutResult.order.shippingCost),
    tracking_id: checkoutResult.order.shippingTrackingId,
    total_cost: printPrice(checkoutResult.order.totalCost),
    order_id: checkoutResult.order.orderId
  }

  ctx.type = 'text/html'
  storeCookies(ctx)
  ctx.body = getTemplates().order(options)
}

async function handleSetUser(ctx) {
  getCookies(ctx)
  const userName = ctx.request.body.userName
  const password = ctx.request.body.password

  const authResult = await ctx.call('login', { userName, password })

  const acceptHeader = ctx.request.headers.accept || ''
  const wantsJson = acceptHeader.includes('application/json')

  if (!authResult.accessToken || authResult.success === false) {
    ctx.status = 401
    ctx.type = 'application/json'
    if (wantsJson) {
      ctx.body = {
        success: false,
        error: authResult.error || 'Authentication failed',
        userName
      }
    } else {
      ctx.response.redirect('back')
    }
    return
  }

  // Success path
  const storageObj = getStorageObj(ctx)
  emptyCartSize(ctx)
  storageObj.userName = userName
  storageObj.userPassword = password || ''
  storageObj.jwtToken = authResult.accessToken

  ctx.type = 'application/json'
  storeCookies(ctx)

  if (wantsJson) {
    ctx.body = {
      success: true,
      accessToken: authResult.accessToken,
      userName
    }
  } else {
    ctx.response.redirect('back')
  }
}

async function handleRegister(ctx) {
  getCookies(ctx)
  const storageObj = getStorageObj(ctx)
  const userName = ctx.request.body.userName
  const password = ctx.request.body.password

  const registerResult = await ctx.call('register', { userName, password })

  if (registerResult.success) {
    const authResult = await ctx.call('login', { userName, password })
    if (authResult.success) {
      emptyCartSize(ctx)
      storageObj.userName = userName
      storageObj.userPassword = password || ''
      storageObj.jwtToken = authResult.accessToken
    } else {
      storageObj.userName = ''
      storageObj.jwtToken = ''
    }
  } else {
    const authResult = await ctx.call('login', { userName, password })
    if (authResult.success) {
      emptyCartSize(ctx)
      storageObj.userName = userName
      storageObj.userPassword = password || ''
      storageObj.jwtToken = authResult.accessToken
    } else {
      storageObj.jwtToken = ''
    }
  }

  ctx.type = 'application/json'
  storeCookies(ctx)
  ctx.response.redirect('back')
}

async function handleLogout(ctx) {
  getCookies(ctx)
  const storageObj = getStorageObj(ctx)
  emptyCartSize(ctx)
  storageObj.userName = ''
  storageObj.userPassword = ''
  storageObj.jwtToken = ''
  ctx.type = 'application/json'
  storeCookies(ctx)
  ctx.response.redirect('back')
}

async function handleLogoutAndLeave(ctx) {
  getCookies(ctx)
  const storageObj = getStorageObj(ctx)
  storageObj.userName = ''
  storageObj.userPassword = ''
  storageObj.jwtToken = ''
  emptyCartSize(ctx)
  ctx.type = 'application/json'
  storeCookies(ctx)
  ctx.response.redirect('./')
}

async function handleSetCurrency(ctx) {
  getCookies(ctx)
  const storageObj = getStorageObj(ctx)
  storageObj.userCurrency = ctx.request.body.currencyCode
  ctx.type = 'application/json'
  storeCookies(ctx)
  ctx.response.redirect('back')
}

async function handleEmptyCart(ctx) {
  setupAuth(ctx)
  const userId = getUserName(ctx)
  await ctx.call('emptycart', { userId: userId })
  emptyCartSize(ctx)
  ctx.type = 'application/json'
  storeCookies(ctx)
  ctx.response.redirect('back')
}

async function handleAddCartItem(ctx) {
  setupAuth(ctx)
  const userName = getUserName(ctx)
  const productId = ctx.request.body.productId
  const quantity = _.parseInt(ctx.request.body.quantity)

  const acceptHeader = ctx.request.headers.accept || ''
  const wantsJson = acceptHeader.includes('application/json')

  if (userName) {
    const result = await ctx.call('addcartitem', {
      userId: userName,
      item: {
        productId: productId,
        quantity: quantity
      }
    })

    if (result?.error) {
      if (result.error === 'AuthTimeout') {
        ctx.status = 424
        ctx.body = { error: 'Add to cart failed', message: 'Authentication service timeout' }
        return
      }
      ctx.status = result.statusCode || 400
      ctx.body = { error: result.error }
      return
    }

    increaseCartSize(ctx, quantity)
  }

  ctx.type = 'application/json'
  storeCookies(ctx)

  if (wantsJson) {
    ctx.body = {
      success: true,
      productId,
      quantity,
      cartSize: getCartSize(ctx)
    }
  } else {
    ctx.response.redirect('back')
  }
}

module.exports = {
  initTemplates,
  getTemplates,
  handleHome,
  handleProduct,
  handleCart,
  handleCheckout,
  handleSetUser,
  handleRegister,
  handleLogout,
  handleLogoutAndLeave,
  handleSetCurrency,
  handleEmptyCart,
  handleAddCartItem,
  setupAuth,
  getCookies,
  storeCookies,
  convertPrice,
  addPrice,
  scalePrice,
  printPrice
}
