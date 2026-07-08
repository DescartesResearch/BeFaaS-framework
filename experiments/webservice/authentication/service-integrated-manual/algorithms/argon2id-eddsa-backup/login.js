const { SignJWT, importPKCS8 } = require('jose')
const { argon2Verify } = require('hash-wasm')

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h'

let cachedPrivateKey = null

async function getPrivateKey () {
  if (cachedPrivateKey) return cachedPrivateKey
  const pem = Buffer.from(process.env.JWT_PRIVATE_KEY, 'base64').toString('utf8')
  cachedPrivateKey = await importPKCS8(pem, 'EdDSA')
  return cachedPrivateKey
}

async function handle (event, ctx) {
  const { userName, password } = event

  if (!userName || !password) {
    return { success: false, error: 'userName and password are required' }
  }

  const userKey = `user:${userName}`

  // Check if user exists in Redis
  const user = await ctx.db.get(userKey)
  if (!user) {
    return { success: false, error: 'User not found' }
  }

  // Verify password
  const isValidPassword = await argon2Verify({ password, hash: user.passwordHash })
  if (!isValidPassword) {
    return { success: false, error: 'Invalid password' }
  }

  const privateKey = await getPrivateKey()
  const now = Math.floor(Date.now() / 1000)

  // Generate JWT tokens
  const accessToken = await new SignJWT({ sub: userName, username: userName, token_use: 'access' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt(now)
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(privateKey)

  const idToken = await new SignJWT({ sub: userName, username: userName, token_use: 'id' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt(now)
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(privateKey)

  const refreshToken = await new SignJWT({ sub: userName, username: userName, token_use: 'refresh' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt(now)
    .setExpirationTime('7d')
    .sign(privateKey)

  return {
    success: true,
    accessToken,
    idToken,
    refreshToken
  }
}

module.exports = handle
