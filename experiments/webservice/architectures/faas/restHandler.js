
const lib = require('@befaas/lib');
const { requiresAuth } = require('./shared/authConfig');
const { createAuthCall } = require('./call');
const { verifyJWT } = require('./auth');

function createRestHandler (handler, options = {}) {
  const functionName = process.env.BEFAAS_FN_NAME || options.functionName;
  const needsAuth = requiresAuth(functionName);

  return lib.serverless.rpcHandler(options, async (event, ctx) => {
    if (!needsAuth) {
      return await handler(event, ctx);
    }

    const authHeader = event.headers?.authorization;

    let authPayload;
    try {
      authPayload = await verifyJWT(event, ctx.contextId, ctx.xPair);
    } catch (err) {
      if (err.isAuthTimeout) {
        return { error: 'AuthTimeout', statusCode: 424 };
      }
      throw err;
    }

    if (!authPayload) {
      return { error: 'Unauthorized' };
    }

    ctx.authPayload = authPayload;

    if (authHeader) {
      ctx.call = createAuthCall(ctx, authHeader);
    }

    return await handler(event, ctx);
  });
}

module.exports = { createRestHandler };
