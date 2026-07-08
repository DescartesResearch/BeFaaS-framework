
async function handle (event, ctx) {
  const { userName, password } = event

  if (!userName || !password) {
    return { success: false, error: 'userName and password are required' }
  }

  const userKey = `user:${userName}`

  const existingUser = await ctx.db.get(userKey)
  if (existingUser) {
    return { success: false, error: 'Username already exists' }
  }

  await ctx.db.set(userKey, { password })

  return {
    success: true,
    message: 'User registered successfully'
  }
}

module.exports = handle
