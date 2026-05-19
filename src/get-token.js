/**
 * Run once to get your OAuth2 refresh token.
 * Usage: node src/get-token.js
 *
 * Steps:
 * 1. Fill CLIENT_ID and CLIENT_SECRET below (or set in .env)
 * 2. Run this script — it prints an auth URL
 * 3. Open the URL, approve access, copy the code from the redirect URL
 * 4. Paste the code here when prompted
 * 5. Copy the printed refresh_token into your .env
 */
require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Approve access and copy the code from the page.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    console.log('\n✓ Add this to your .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (err) {
    console.error('Failed to exchange code:', err.message);
  }
});
