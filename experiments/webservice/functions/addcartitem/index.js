const { verifyJWT } = require('./auth');

/**
 *
 * Adds a new item to a users cart.
 *
 * Example Payload: {
 *   "userId": "USER12",
 *   "item": {
 *     "productId": "QWERTY",
 *     "quantity": 2
 *   }
 * }
 *
 * Example Response: { }
 *
 */

async function handle(event, ctx) {
  // Verify JWT token
  if (!ctx.authPayload) {
    let isValid;
    try {
      isValid = await verifyJWT(event, ctx.contextId, ctx.xPair);
    } catch (err) {
      if (err.isAuthTimeout) {
        return { error: 'AuthTimeout', statusCode: 424 };
      }
      throw err;
    }

    if (!isValid) {
      return { error: 'Unauthorized' };
    }
  }

  if (!event.userId || !event.item) {
    return { error: 'Wrong input format.' }
  }
  if (!event.item.productId || !event.item.quantity) {
    return { error: 'There is no item to be added.' }
  }
  return await ctx.call('cartkvstorage', {
    operation: 'add',
    userId: event.userId,
    itemId: event.item.productId,
    quantity: event.item.quantity
  })
}

module.exports = handle
