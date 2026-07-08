const lib = require('@befaas/lib')
const { EUR_RATES } = require('../../currency/exchangerates')

/**
 *
 * A dict with list of supported currency codes will be returned when called by a POST request.
 *
 * Does not need a payload.
 *
 * Response: {"currencyCodes": ["EUR", "USD"]}
 *
 */
async function handle (event, ctx) {
  return { currencyCodes: Object.keys(EUR_RATES) }
}

module.exports = handle
