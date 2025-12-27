/**
 * FordConnect 2.0 OAuth Flow Test with Manual URL Copy/Paste
 *
 * This script uses the custom URI scheme redirect (fordapp://userauthorized)
 * like Home Assistant does, avoiding the AADB2C90075 error.
 *
 * The user must manually complete the login in the browser and paste the
 * redirect URL back into the script.
 *
 * Run with: node test-v2-oauth.js
 */

const axios = require('axios').default;
const qs = require('qs');
const tough = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

console.log('=== FordConnect 2.0 OAuth Flow Test ===\n');

// Configuration - using official FordPass Client ID (same as Home Assistant)
const config = {
  oauth_id: '4566605f-43a7-400a-946e-89cc9fdb0bd7',  // Official FordPass OAuth ID
  v2_clientId: '09852200-05fd-41f6-8c21-d36d3497dc64',  // Official FordPass Client ID (pre-registered in Azure B2C)
  redirect_uri: 'fordapp://userauthorized',  // Custom URI scheme like Home Assistant
  appId: '667D773E-1BDC-4139-8AD0-2B16474E8DC7',  // Application ID for Europe region
  locale: 'de-DE',  // Germany locale
  login_url: 'https://login.ford.de',  // Login URL for Germany
  user: 'tombox2020+f@gmail.com',
  password: 'Fucked666!',
};

// Setup request client with cookies
const cookieJar = new tough.CookieJar();
const requestClient = axios.create({
  withCredentials: true,
  httpsAgent: new HttpsCookieAgent({
    cookies: {
      jar: cookieJar,
    },
  }),
});

let sessionV2 = {};
let autonomTokenV2 = null;
const vinArray = [];
let codeVerifier = null;

/**
 * Generate PKCE code challenge (same as Home Assistant implementation)
 */
function generateCodeChallenge() {
  // Generate random 43-character code verifier
  const verifier = crypto.randomBytes(32).toString('base64url');

  // Generate SHA256 hash for code challenge
  const challenge = crypto.createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return {
    code_verifier: verifier,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };
}

/**
 * Generate FordConnect 2.0 Authorization URL (using official FordPass credentials + PKCE)
 */
function generateV2ConnectUrl() {
  // Generate PKCE challenge
  const pkce = generateCodeChallenge();
  codeVerifier = pkce.code_verifier;

  const authUrl = `${config.login_url}/${config.oauth_id}/B2C_1A_SignInSignUp_${config.locale}/oauth2/v2.0/authorize`;

  // Build URL with all parameters exactly as Home Assistant does
  const params = new URLSearchParams({
    'redirect_uri': config.redirect_uri,
    'response_type': 'code',
    'max_age': '3600',
    'code_challenge': pkce.code_challenge,
    'code_challenge_method': pkce.code_challenge_method,
    'scope': ` ${config.v2_clientId} openid`,  // Note: space before clientId
    'client_id': config.v2_clientId,
    'ui_locales': config.locale,
    'language_code': config.locale,
    'ford_application_id': config.appId,
    'country_code': 'DEU'
  });

  return `${authUrl}?${params.toString()}`;
}

/**
 * Prompt user to paste redirect URL
 */
function promptForRedirectUrl() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\n📋 Please paste the complete redirect URL here (fordapp://userauthorized/?code=...) and press Enter:');
    console.log('   (The URL should start with: fordapp://userauthorized/?code=)\n');

    rl.question('Paste URL: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Extract authorization code from redirect URL
 */
function extractCodeFromUrl(url) {
  console.log('\n🔍 Extracting authorization code from URL...');

  // Check if URL starts with expected redirect URI
  if (!url.startsWith('fordapp://userauthorized')) {
    throw new Error(`Invalid redirect URL format. Expected fordapp://userauthorized/?code=..., got: ${url}`);
  }

  // Extract query parameters
  const queryString = url.includes('?') ? url.split('?')[1] : null;
  if (!queryString) {
    throw new Error('No query parameters found in redirect URL');
  }

  const params = qs.parse(queryString);
  const code = params.code;

  if (!code) {
    throw new Error('No authorization code found in redirect URL');
  }

  console.log(`✅ Authorization code extracted: ${code.substring(0, 60)}...`);
  return code;
}

/**
 * Exchange authorization code for access token (using official FordPass Client ID)
 */
async function exchangeCodeForToken(code) {
  console.log('\n📤 Exchanging authorization code for access token...');
  console.log('   Using official FordPass Client ID (no secret required)');

  try {
    // Prepare data exactly as HA does
    const tokenData = {
      grant_type: 'authorization_code',
      client_id: config.v2_clientId,
      scope: `${config.v2_clientId} openid`,
      redirect_uri: config.redirect_uri,
      resource: '',  // Empty string - required by Azure B2C
      code: code,
      code_verifier: codeVerifier,
    };

    console.log('   Token exchange URL:', `${config.login_url}/${config.oauth_id}/B2C_1A_SignInSignUp_${config.locale}/oauth2/v2.0/token`);
    console.log('   Data being sent:', JSON.stringify(tokenData, null, 2));

    const response = await requestClient({
      method: 'post',
      url: `${config.login_url}/${config.oauth_id}/B2C_1A_SignInSignUp_${config.locale}/oauth2/v2.0/token`,
      headers: {
        'Accept-Encoding': 'gzip',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/4.12.0',
      },
      data: qs.stringify(tokenData),  // URL-encode the data
      timeout: 30000,  // 30 second timeout
    });

    const firstToken = response.data;
    console.log('✅ Step 1: OAuth token received');
    console.log(`   Temporary Token: ${firstToken.access_token.substring(0, 50)}...`);

    // Step 2: Exchange for final FordConnect token
    console.log('\n📤 Step 2: Exchanging for final FordConnect token...');

    const finalTokenResponse = await requestClient({
      method: 'post',
      url: 'https://api.foundational.ford.com/api/token/v2/cat-with-b2c-access-token',
      headers: {
        'Accept-Encoding': 'gzip',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.12.0',
        'Application-Id': config.appId,
      },
      data: JSON.stringify({ idpToken: firstToken.access_token }),
      timeout: 30000,
    });

    sessionV2 = finalTokenResponse.data;
    console.log('✅ Token exchange successful!');
    console.log(`   Access Token: ${sessionV2.access_token.substring(0, 50)}...`);
    console.log(`   Refresh Token: ${sessionV2.refresh_token ? '✓' : '✗'}`);
    console.log(`   Token Type: ${sessionV2.token_type}`);
    console.log(`   Expires in: ${sessionV2.expires_in}s (${Math.floor(sessionV2.expires_in / 60)} minutes)`);

    // Save session to file for later use
    fs.writeFileSync('./session-v2.json', JSON.stringify(sessionV2, null, 2));
    console.log('   Session saved to: session-v2.json\n');

    return true;
  } catch (error) {
    console.error('❌ Token exchange failed');
    console.error('   Error:', error.message);

    if (error.code === 'ECONNABORTED') {
      console.error('   Reason: Request timed out after 30 seconds');
    }

    if (error.response) {
      console.error('   HTTP Status:', error.response.status);
      console.error('   Response Headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('   Response Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('   No response received from server');
      console.error('   Request details:', error.request);
    } else {
      console.error('   Error details:', error);
    }

    return false;
  }
}

/**
 * Test Garage Endpoint (Vehicle List)
 * Uses FordConnect API with access_token
 */
async function testGarageV2() {
  console.log('--- Testing Garage Endpoint (Vehicle List) ---');

  try {
    const response = await requestClient({
      method: 'post',
      url: 'https://api.vehicle.ford.com/api/expdashboard/v1/details/',
      headers: {
        'Accept-Encoding': 'gzip',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.12.0',
        'auth-token': sessionV2.access_token,
        'Application-Id': config.appId,
        'countryCode': 'DEU',
        'locale': config.locale
      },
      data: JSON.stringify({ dashboardRefreshRequest: 'All' }),
    });

    if (response.status === 207 || response.status === 200) {
      const vehicles = response.data.userVehicles?.vehicleDetails || [];
      console.log(`✅ Found ${vehicles.length} vehicle(s)\n`);

      vehicles.forEach((vehicle, index) => {
        console.log(`   Vehicle ${index + 1}:`);
        console.log(`   - VIN: ${vehicle.VIN}`);
        console.log(`   - Model: ${vehicle.modelName || 'N/A'}`);
        console.log(`   - Nickname: ${vehicle.nickName || 'N/A'}`);
        console.log(`   - Year: ${vehicle.modelYear || 'N/A'}`);
        console.log('');

        vinArray.push(vehicle.VIN);
      });

      return true;
    }
  } catch (error) {
    console.error('❌ Garage request failed');
    console.error('   Status:', error.response?.status);
    console.error('   Error:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test Telemetry Endpoint (Vehicle Status)
 * Uses Autonomic API with auto_access_token
 */
async function testTelemetryV2() {
  console.log('--- Testing Telemetry Endpoint (Vehicle Status) ---');

  if (vinArray.length === 0) {
    console.error('❌ No VINs available - run testGarageV2() first');
    return false;
  }

  if (!autonomTokenV2 || !autonomTokenV2.access_token) {
    console.error('❌ No Autonomic token available');
    return false;
  }

  try {
    const vin = vinArray[0];
    console.log(`   Testing with VIN: ${vin}`);

    const response = await requestClient({
      method: 'get',
      url: `https://api.autonomic.ai/v1/telemetry/sources/fordpass/vehicles/${vin}`,
      headers: {
        'Accept-Encoding': 'gzip',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.12.0',
        'authorization': `Bearer ${autonomTokenV2.access_token}`,
        'Application-Id': config.appId,
      },
      params: {
        lrdt: '01-01-1970 00:00:00'
      }
    });

    console.log('✅ Telemetry data received\n');

    // Save response to file for inspection
    fs.writeFileSync('./telemetry-response.json', JSON.stringify(response.data, null, 2));
    console.log('   Full response saved to: telemetry-response.json');

    // Display structure summary
    console.log('   Response structure:');
    const keys = Object.keys(response.data);
    console.log(`   - Root keys: ${keys.join(', ')}`);

    if (response.data.metrics) {
      const metricKeys = Object.keys(response.data.metrics);
      console.log(`   - Metrics count: ${metricKeys.length}`);
    }
    if (response.data.states) {
      const stateKeys = Object.keys(response.data.states);
      console.log(`   - States count: ${stateKeys.length}`);
    }
    console.log('');

    return true;
  } catch (error) {
    console.error('❌ Telemetry request failed');
    console.error('   Status:', error.response?.status);
    console.error('   Error:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test Autonomic Token Exchange
 */
async function testAutonomTokenV2() {
  console.log('--- Testing Autonomic Token Exchange ---');

  try {
    const response = await requestClient({
      method: 'post',
      url: 'https://accounts.autonomic.ai/v1/auth/oidc/token',
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: {
        subject_token: sessionV2.access_token,
        subject_issuer: 'fordpass',
        client_id: 'fordpass-prod',
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      },
    });

    autonomTokenV2 = response.data;
    console.log('✅ Autonomic token received');
    console.log(`   Token: ${autonomTokenV2.access_token.substring(0, 50)}...`);
    console.log(`   Expires in: ${autonomTokenV2.expires_in}s\n`);

    return true;
  } catch (error) {
    console.error('❌ Autonomic token exchange failed');
    console.error('   Error:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test Messages (includes health alerts)
 * Uses FordConnect API with access_token
 */
async function testHealthV2() {
  console.log('--- Testing Messages Endpoint (includes health alerts) ---');

  try {
    const response = await requestClient({
      method: 'get',
      url: 'https://api.foundational.ford.com/api/messagecenter/v3/messages',
      headers: {
        'Accept-Encoding': 'gzip',
        'Connection': 'Keep-Alive',
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.12.0',
        'auth-token': sessionV2.access_token,
        'Application-Id': config.appId,
      },
    });

    console.log('✅ Messages data received');

    const messages = response.data.result?.messages || [];
    console.log(`   Found ${messages.length} message(s)`);

    fs.writeFileSync('./messages-response.json', JSON.stringify(response.data, null, 2));
    console.log('   Response saved to: messages-response.json\n');

    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log('⚠️  Messages endpoint not available\n');
    } else {
      console.error('❌ Messages request failed');
      console.error('   Status:', error.response?.status);
      console.error('   Error:', error.response?.data || error.message);
    }
    return false;
  }
}

/**
 * Main OAuth flow
 */
async function runOAuthFlow() {
  console.log('Starting FordConnect 2.0 OAuth Flow...\n');
  console.log('=' .repeat(70) + '\n');

  console.log('Configuration:');
  console.log(`   OAuth ID: ${config.oauth_id}`);
  console.log(`   Client ID: ${config.v2_clientId}`);
  console.log(`   Redirect URI: ${config.redirect_uri}`);
  console.log(`   Login URL: ${config.login_url}`);
  console.log(`   Locale: ${config.locale}`);
  console.log(`   Username: ${config.user}`);
  console.log(`   (Using official FordPass Client ID - no secret required)\n`);

  // Step 1: Generate authorization URL
  const authUrl = generateV2ConnectUrl();
  console.log('Step 1: Authorization URL generated\n');
  console.log('Copy and paste this URL into your browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('=' .repeat(70) + '\n');

  // Step 2: Manual authorization instructions
  console.log('Step 2: IMPORTANT - Before opening the URL:');
  console.log('   1. Open your browser Developer Tools (F12 or Cmd+Option+I)');
  console.log('   2. Go to the Network tab');
  console.log('   3. NOW paste the URL above into the browser address bar');
  console.log('   4. Log in with your Ford account');
  console.log('   5. Authorize the application');
  console.log('   6. After redirect fails, check Network tab for the last request');
  console.log('   7. Look for a request to a URL starting with: fordapp://userauthorized/?code=');
  console.log('   8. COPY that complete URL\n');
  console.log('Alternative method (easier):');
  console.log('   1. Paste the URL above into your browser');
  console.log('   2. Log in with your Ford account');
  console.log('   3. After redirect, browser will show "Cannot open page"');
  console.log('   4. COPY the complete URL from the browser address bar\n');

  const redirectUrl = await promptForRedirectUrl();

  // Step 4: Extract authorization code
  let code;
  try {
    code = extractCodeFromUrl(redirectUrl);
  } catch (error) {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
  }

  // Step 5: Exchange code for token
  console.log('\nStep 5: Exchanging authorization code for access token...');
  const success = await exchangeCodeForToken(code);

  if (!success) {
    console.log('\n❌ OAuth flow failed\n');
    process.exit(1);
  }

  // Step 6: Test API endpoints
  console.log('Step 6: Testing API endpoints...\n');
  console.log('=' .repeat(70) + '\n');

  await testGarageV2();
  await testTelemetryV2();
  await testHealthV2();
  await testAutonomTokenV2();

  console.log('=' .repeat(70) + '\n');
  console.log('✅ OAuth flow completed successfully!\n');
  console.log('📝 Next steps:');
  console.log('   1. Review the saved response files:');
  console.log('      - session-v2.json (access + refresh token)');
  console.log('      - telemetry-response.json (vehicle data structure)');
  console.log('      - health-response.json (health alerts)');
  console.log('   2. Use session-v2.json for further testing');
  console.log('   3. Configure ioBroker adapter with the same credentials\n');
}

/**
 * Run complete OAuth flow and tests
 */
async function main() {
  try {
    // Run OAuth flow
    await runOAuthFlow();

    console.log('\n' + '='.repeat(70));
    console.log('\n✅ All tests completed successfully!\n');

  } catch (error) {
    console.error('\n' + '='.repeat(70));
    console.error('\n❌ Test failed:', error.message, '\n');
    process.exit(1);
  }
}

// Run the script
main();
