const authMethod = process.env.AUTH_METHOD || 'none';
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;
const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1';

// Cache for user tokens to avoid re-authenticating on every request
const tokenCache = new Map();

// Only load Cognito SDK if auth is not 'none'
let CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand, AdminConfirmSignUpCommand;
if (authMethod !== 'none') {
  const cognitoSdk = require('@aws-sdk/client-cognito-identity-provider');
  CognitoIdentityProviderClient = cognitoSdk.CognitoIdentityProviderClient;
  InitiateAuthCommand = cognitoSdk.InitiateAuthCommand;
  SignUpCommand = cognitoSdk.SignUpCommand;
  AdminConfirmSignUpCommand = cognitoSdk.AdminConfirmSignUpCommand;
}

function getAuthConfig() {
  return {
    method: authMethod,
    enabled: authMethod !== 'none',
    userPoolId,
    clientId,
    region
  };
}

async function authenticateUser(username, password) {
  if (authMethod === 'none') {
    return null;
  }

  // Check cache first
  const cacheKey = `${username}:${password}`;
  if (tokenCache.has(cacheKey)) {
    const cached = tokenCache.get(cacheKey);
    if (cached.expiresAt > Date.now() + 300000) { // 5 minutes buffer
      return cached.token;
    }
  }

  try {
    const client = new CognitoIdentityProviderClient({ region });

    const command = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    });

    const response = await client.send(command);

    if (response.AuthenticationResult) {
      const token = response.AuthenticationResult.AccessToken;
      const expiresIn = response.AuthenticationResult.ExpiresIn || 3600;

      tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + (expiresIn * 1000)
      });

      return token;
    }

    throw new Error('Authentication failed: No access token received');
  } catch (error) {
    console.error(`Failed to authenticate user ${username}:`, error.message);
    throw error;
  }
}

async function registerUser(username, password, email) {
  if (authMethod === 'none') {
    return { success: true };
  }

  try {
    const client = new CognitoIdentityProviderClient({ region });

    const signUpCommand = new SignUpCommand({
      ClientId: clientId,
      Username: username,
      Password: password,
      UserAttributes: [
        {
          Name: 'email',
          Value: email || `${username}@test.com`
        }
      ]
    });

    const response = await client.send(signUpCommand);

    // Auto-confirm user for testing (requires admin privileges)
    if (userPoolId) {
      const confirmCommand = new AdminConfirmSignUpCommand({
        UserPoolId: userPoolId,
        Username: username
      });

      await client.send(confirmCommand);
    }

    return {
      success: true,
      userSub: response.UserSub,
      confirmed: true
    };
  } catch (error) {
    // If user already exists, that's okay
    if (error.name === 'UsernameExistsException') {
      console.log(`User ${username} already exists, skipping registration`);
      return { success: true, alreadyExists: true };
    }

    console.error(`Failed to register user ${username}:`, error.message);
    throw error;
  }
}

function getAuthHeader(token) {
  if (!token || authMethod === 'none') {
    return {};
  }

  return {
    'Authorization': `Bearer ${token}`
  };
}

async function preAuthenticateUsers(users) {
  if (authMethod === 'none') {
    console.log('Auth method is "none", skipping pre-authentication');
    return;
  }

  console.log(`Pre-authenticating ${users.length} users...`);

  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  for (const user of users) {
    try {
      // Ensure user exists and is confirmed
      await registerUser(user.userName, user.password, user.email);

      // Authenticate to warm up the cache
      await authenticateUser(user.userName, user.password);

      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        user: user.userName,
        error: error.message
      });
    }
  }

  console.log(`Pre-authentication complete: ${results.success} successful, ${results.failed} failed`);

  if (results.errors.length > 0) {
    console.log('First 5 errors:', results.errors.slice(0, 5));
  }

  return results;
}

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  getAuthConfig,
  authenticateUser,
  registerUser,
  getAuthHeader,
  preAuthenticateUsers,
  clearTokenCache
};