const lib = require('@befaas/lib')
const { verifyJWT } = require('./auth')

/**
 *
 * Checkout Service
 *
 * Place a order with your whole cart. This call
 * gets the current shipment service price for the current user
 * cart and initiates payment in the given currency.
 * After successfully completing shipment and payment the user's cart will
 * be cleared. Additionally, a confirmation email listing all used prices
 * will be sent to the customer.
 *
 *
 * Payload Body:
 {
  "userId": "56437829",
  "userCurrency": "PHP",
  "address": {
    "streetAddress": "Schillerstrasse 9",
    "city": "Munich",
    "state": "Bavaria",
    "country": "Germany"
  },
  "email": "mail@foo",
  "creditCard": {
    "creditCardNumber": "378282246310005",
    "creditCardCvv": 123,
    "creditCardExpirationYear": 2000,
    "creditCardExpirationMonth": 10
  }
 }
 *
 *
 * Response after the order has been placed: {
 *   "orderId": "123fasd4",
 *   "shippingTrackingId": "3uwfs",
 *   "shippingCost": {
 *     "units": 100,
 *     "nanos": 500000000,
 *     "currencyCode": "PHP"
 *   },
 *   "shippingAddress": {
 *     "streetAddress": "Schillerstrasse 9",
 *     "city": "Munich",
 *     "state": "Bavaria",
 *     "country": "Germany"
 *   },
 *   "items" : [
 *     {
 *       "item": {
 *         "productId": "1234b",
 *         "quantity": 3
 *       },
 *       "cost": {
 *         {
 *           "units": 100,
 *           "nanos": 500000000,
 *           "currencyCode": "PHP"
 *         }
 *       }
 *     }
 *   ]
 * }
 *
 */

async function convertPrice (ctx, priceUsd, userCurrency) {
  if (userCurrency === 'USD') {
    return priceUsd
  } else {
    return await ctx.call('currency', { from: priceUsd, toCode: userCurrency })
  }
}

// Should only be used if (a.currencyCode === b.currencyCode)
function addPrices (a, b) {
  const nanos = (a.nanos + b.nanos) % 1e9
  const units = Math.trunc((a.nanos + b.nanos) / 1e9) + a.units + b.units
  return {
    currencyCode: a.currencyCode,
    nanos: nanos,
    units: units
  }
}

function scalePrice (price, scalar) {
  const nanos = (price.nanos * scalar) % 1e9
  const units = Math.trunc((price.nanos * scalar) / 1e9) + price.units * scalar
  return {
    currencyCode: price.currencyCode,
    nanos: nanos,
    units: units
  }
}

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

  const cart = await ctx.call('getcart', {
    userId: event.userId
  })
  let totalOrderPrice = {
    currencyCode: event.userCurrency,
    units: 0,
    nanos: 0
  }
  if (!cart.items || cart.items.length === 0) {
    return { error: 'cart is empty' }
  }
  const cartItems = []
  await Promise.all(
    cart.items.map(async item => {
      const product = await ctx.call('getproduct', {
        id: item.productId
      })
      const productPrice = await convertPrice(
        ctx,
        product.priceUsd,
        event.userCurrency
      )
      cartItems.push({
        item: item,
        cost: productPrice
      })
      totalOrderPrice = await addPrices(
        totalOrderPrice,
        await scalePrice(productPrice, item.quantity)
      )
    })
  )

  const shipmentPrice = (
    await ctx.call('shipmentquote', {
      address: event.address,
      items: cart.items
    })
  ).costUsd

  const convertedShipmentPrice = await convertPrice(
    ctx,
    shipmentPrice,
    event.userCurrency
  )
  totalOrderPrice = await addPrices(totalOrderPrice, convertedShipmentPrice)

  const { transactionId } = await ctx.call('payment', {
    creditCard: event.creditCard,
    amount: totalOrderPrice
  })

  if (!transactionId) return { error: 'failed to charge credit card' }

  const trackingId = (
    await ctx.call('shiporder', {
      address: event.address,
      items: cart.items
    })
  ).id
  const orderResult = {
    orderId: lib.helper.generateRandomID(),
    shippingTrackingId: trackingId,
    shippingCost: convertedShipmentPrice,
    totalCost: totalOrderPrice,
    shippingAddress: event.address,
    items: cartItems
  }
  await ctx.call('email', {
    email: event.email,
    order: orderResult
  })
  await ctx.call('emptycart', {
    userId: event.userId
  })
  return { order: orderResult }
}

module.exports = handle
