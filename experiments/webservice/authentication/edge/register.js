
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminConfirmSignUpCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { performance } = require('perf_hooks');

const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const fnName = process.env.BEFAAS_FN_NAME || 'register';
const deploymentId = process.env.BEFAAS_DEPLOYMENT_ID || 'unknownDeploymentId';

const cognitoClient = new CognitoIdentityProviderClient({
  region: AWS_REGION
});

function logAuthTiming (contextId, durationMs, success) {
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
            operation: 'register'
          }
        }
      })
  )
}

async function handle (event, ctx) {
  const startTime = performance.now();
  const contextId = ctx?.contextId || 'unknown';

  const { userName, password, email } = event;

  if (!userName || !password) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);
    return { success: false, error: 'userName and password are required' };
  }

  if (!COGNITO_CLIENT_ID || !COGNITO_USER_POOL_ID) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);
    return {
      success: false,
      error: 'Cognito not configured (COGNITO_CLIENT_ID or COGNITO_USER_POOL_ID missing)'
    };
  }

  try {
    const signUpCommand = new SignUpCommand({
      ClientId: COGNITO_CLIENT_ID,
      Username: userName,
      Password: password,
      UserAttributes: email ? [{ Name: 'email', Value: email }] : []
    });

    await cognitoClient.send(signUpCommand);

    // Auto-confirm the user, since this is an automated benchmark without mail functionalities or so
    const confirmCommand = new AdminConfirmSignUpCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: userName
    });

    await cognitoClient.send(confirmCommand);

    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, true);

    return {
      success: true,
      message: 'User registered and confirmed successfully'
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    logAuthTiming(contextId, duration, false);

    const errorMsg = error.message || String(error);

    if (error.name === 'UsernameExistsException') {
      return { success: false, error: 'User already exists' };
    }

    if (error.name === 'InvalidPasswordException') {
      return { success: false, error: 'Invalid password format' };
    }

    if (errorMsg.includes('time-out') || errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      console.error('Cognito register timeout:', error);
      return {
        success: false,
        error: 'Registration service timeout',
        isAuthTimeout: true
      };
    }

    console.error('Register error:', errorMsg);
    return { success: false, error: errorMsg };
  }
}

module.exports = handle;
