const lib = require('@befaas/lib')
const { products } = require('../../productcatalog/products')

/**
 *
 * Searches the product catalog for a given product.
 *
 * Example Request: {
 *  "id": "QWERTY"
 * }
 *
 * Example Response: {
 *   "id": "QWERTY",
 *   "name": "Bathing Suit",
 *   "description": "You will never want to take this off!",
 *   "picture": "bathing_suit.jpg",
 *   "priceUsd": {
 *     "currencyCode": "USD",
 *     "units": 64,
 *     "nanos": 990000000
 *   },
 *   "categories": ["clothing", "bath"]
 * }
 *
 */

async function handle(event, ctx) {
  const id = event.id
  return products[id] || { error: 'Product not found.' }
}

module.exports = handle
