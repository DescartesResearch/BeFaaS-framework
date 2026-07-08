const argon2 = require('argon2')

const ARGON2_MEMORY = 65536  // 64 MiB
const ARGON2_ITERATIONS = 3
const ARGON2_PARALLELISM = 1
const ARGON2_HASH_LENGTH = 32
const ARGON2_SALT_LENGTH = 16

async function handle (event, ctx) {
  const { userName, password } = event

  if (!userName || !password) {
    return { success: false, error: 'userName and password are required' }
  }

  const userKey = `user:${userName}`

  // Check if user already exists
  const existingUser = await ctx.db.get(userKey)
  if (existingUser) {
    return { success: false, error: 'Username already exists' }
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    parallelism: ARGON2_PARALLELISM,
    timeCost: ARGON2_ITERATIONS,
    memoryCost: ARGON2_MEMORY,
    hashLength: ARGON2_HASH_LENGTH,
    saltLength: ARGON2_SALT_LENGTH
  })

  // Store user in Redis
  await ctx.db.set(userKey, {
    userName,
    passwordHash,
    createdAt: new Date().toISOString()
  })

  return {
    success: true,
    message: 'User registered successfully'
  }
}

module.exports = handle
