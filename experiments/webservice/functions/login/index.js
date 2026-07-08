const lib = require('@befaas/lib')
const { CognitoIdentityProviderClient, InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider')
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

/**
 * Login Service authenticates a user against Cognito and returns JWT tokens.
 *
 * Ex Payload Body: {
 *   "userName": "testuser",
 *   "password": "TestPassword123!"
 * }
 *
 * Response on success: {
 *   "success": true,
 *   "accessToken": "...",
 *   "idToken": "...",
 *   "refreshToken": "..."
 * }
 *
 * Response on failure: {
 *   "success": false,
 *   "error": "..."
 * }
 */
async function handle(event, ctx) {
  const { userName, password } = event

  if (!userName || !password) {
    return { success: false, error: 'userName and password are required' }
  }

  try {
    const authParameters = {
      USERNAME: userName,
      PASSWORD: password
    }

    const command = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: authParameters
    })

    const response = await cognitoClient.send(command)

    return {
      success: true,
      accessToken: response.AuthenticationResult.AccessToken,
      idToken: response.AuthenticationResult.IdToken,
      refreshToken: response.AuthenticationResult.RefreshToken
    }
  } catch (error) {
    console.error('Login error:', error.message)
    return { success: false, error: error.message }
  }
}

module.exports = handle
