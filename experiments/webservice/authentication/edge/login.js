
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { performance } = require('perf_hooks');

const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const fnName = process.env.BEFAAS_FN_NAME || 'login';
const deploymentId = process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId';

const cognitoClient = new CognitoIdentityProviderClient({
  region: AWS_REGION
});

function logAuthTiming(contextId, durationMs, success) {
  console.log(
    'BEFAAS' +
      JSON.stringify({
        timestamp: new Date().getTime(),
        now: performance.now(),
        deploymentId,
        fn: { name: fnName },
        event: {
          contextId,
          authCheck: {
            durationMs,
            success,
            method: 'edge',
            operation: 'login'
          }
        }
      })
  );
}

async function handle(event, ctx) {
  const startTime = performance.now();
  const contextId = ctx?.contextId || 'unknown';

  const { userName, password } = event;

  if (!userName || !password) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);
    return { success: false, error: 'userName and password are required' };
  }

  if (!COGNITO_CLIENT_ID) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);
    return { success: false, error: 'Cognito not configured (COGNITO_CLIENT_ID missing)' };
  }

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: userName,
        PASSWORD: password
      }
    });

    const response = await cognitoClient.send(command);

    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, true);

    return {
      success: true,
      accessToken: response.AuthenticationResult.AccessToken,
      idToken: response.AuthenticationResult.IdToken,
      refreshToken: response.AuthenticationResult.RefreshToken
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);

    const errorMsg = error.message || String(error);

    // Handle timeout errors
    if (errorMsg.includes('time-out') || errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      console.error('Cognito login timeout:', error);
      return {
        success: false,
        error: 'Authentication service timeout',
        isAuthTimeout: true
      };
    }

    console.error('Login error:', errorMsg);
    return { success: false, error: errorMsg };
  }
}

module.exports = handle;