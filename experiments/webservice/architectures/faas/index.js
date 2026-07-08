const { createRestHandler } = require('./restHandler')
const handler = require('./handler')

module.exports = createRestHandler(handler, { db: 'redis' })
