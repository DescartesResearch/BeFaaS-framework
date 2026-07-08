const lib = require('@befaas/lib')
const valid = require('card-validator')
const { verifyJWT } = require('./auth');

function sanitizeCreditCard (card) {
  return card.replace(/[^0-9]/g, '')
}

function getTransactionId () {
  return (Math.random() * 99999999999999999).toString(36)
}

/**
 * The Payment Service accepts a payment value and a credit card. The service
 * checks the credit card number for plausible validity.
 *
 * The service returns a transactionID result on success and an {error: "..."}
 * response on failure.
 *
 * Ex Payload Body: {
 *  "amount": {
 *    "units": 100,
 *    "nanos": 500000000,
 *    "currencyCode": "PHP"
 *  },
 *  "creditCard": {
 *    "creditCardNumber": "378282246310005",
 *    "creditCardCvv": 123,
 *    "creditCardExpirationYear": 2000,
 *    "creditCardExpirationMonth": 10
 *   }
 * }
 *
 * Response: {
 *   "transactionId": "x1234b"
 *  }
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

  const ok = valid.number(
    sanitizeCreditCard(event.creditCard.creditCardNumber)
  ).isPotentiallyValid
  return ok
    ? { transactionId: getTransactionId() }
    : { error: 'credit card is invalid' }
}

module.exports = handle
