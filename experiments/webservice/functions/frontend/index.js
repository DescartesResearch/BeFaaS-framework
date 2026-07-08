const lib = require('@befaas/lib')
const handlers = require('./handlers')

function createHandlerContext (ctx) {
  return {
    call: async (fn, payload) => ctx.lib.call(fn, payload),
    request: ctx.request,
    params: ctx.params,
    cookies: ctx.cookies,
    response: ctx.response,
    state: ctx.state || {}, // Per-request state for session storage (prevents race conditions)
    get type () { return ctx.type },
    set type (v) { ctx.type = v },
    get body () { return ctx.body },
    set body (v) { ctx.body = v },
    get status () { return ctx.status },
    set status (v) { ctx.status = v }
  }
}

// Wrap a handler to adapt FaaS context
function wrapHandler (handler) {
  return async (ctx) => {
    const handlerCtx = createHandlerContext(ctx)
    await handler(handlerCtx)
  }
}

module.exports = lib.serverless.router(router => {
  router.get('/', wrapHandler(handlers.handleHome))
  router.get('/product/:productId', wrapHandler(handlers.handleProduct))
  router.get('/cart', wrapHandler(handlers.handleCart))
  router.post('/checkout', wrapHandler(handlers.handleCheckout))
  router.post('/setUser', wrapHandler(handlers.handleSetUser))
  router.post('/register', wrapHandler(handlers.handleRegister))
  router.post('/logout', wrapHandler(handlers.handleLogout))
  router.post('/logoutAndLeave', wrapHandler(handlers.handleLogoutAndLeave))
  router.post('/setCurrency', wrapHandler(handlers.handleSetCurrency))
  router.post('/emptyCart', wrapHandler(handlers.handleEmptyCart))
  router.post('/addCartItem', wrapHandler(handlers.handleAddCartItem))
})
