const { CognitoIdentityProviderClient, SignUpCommand, AdminConfirmSignUpCommand } = require('@aws-sdk/client-cognito-identity-provider')
const { NodeHttpHandler } = require('@smithy/node-http-handler')

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'us-east-1',
  requestHandler: new NodeHttpHandler({
    maxSockets: 200,
    connectionTimeout: 10000,
    socketTimeout: 10000
  })
})

const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID
const COGNITO_CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID

async function handle (event, ctx) {
  const { userName, password } = event

  if (!userName || !password) {
    return { success: false, error: 'userName and password are required' }
  }

  try {
    const signUpParams = {
      ClientId: COGNITO_CLIENT_ID,
      Username: userName,
      Password: password
    }

    // Only include SecretHash if client secret is configured
    if (COGNITO_CLIENT_SECRET) {
      const crypto = require('crypto')
      const secretHash = crypto
        .createHmac('SHA256', COGNITO_CLIENT_SECRET)
        .update(userName + COGNITO_CLIENT_ID)
        .digest('base64')
      signUpParams.SecretHash = secretHash
    }

    const signUpCommand = new SignUpCommand(signUpParams)

    await cognitoClient.send(signUpCommand)

    // Auto-confirm the user for demo purposes
    const confirmCommand = new AdminConfirmSignUpCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: userName
    })

    await cognitoClient.send(confirmCommand)

    return {
      success: true,
      message: 'User registered successfully'
    }
  } catch (error) {
    console.error('Registration error:', error.message)

    if (error.name === 'UsernameExistsException') {
      return { success: false, error: 'Username already exists' }
    }

    return { success: false, error: error.message }
  }
}

module.exports = handle
