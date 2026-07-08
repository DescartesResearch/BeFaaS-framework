const lib = require('@befaas/lib')
const { verifyJWT } = require('./auth')

/**
 *
 * Empties a users cart.
 *
 * Example Payload: {
 *   "userId": "USER12"
 * }
 *
 * Example Response: { }
 *
 */

async function handle (event, ctx) {
  // Verify JWT token
  if (!ctx.authPayload) {
    let isValid
    try {
      isValid = await verifyJWT(event, ctx.contextId, ctx.xPair)
    } catch (err) {
      if (err.isAuthTimeout) {
        return { error: 'AuthTimeout', statusCode: 424 }
      }
      throw err
    }

    if (!isValid) {
      return { error: 'Unauthorized' }
    }
  }

  if (!event.userId) {
    return { error: 'Wrong input format.' }
  }
  return await ctx.call('cartkvstorage', {
    operation: 'empty',
    userId: event.userId
  })
}

module.exports = handle
