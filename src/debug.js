require('dotenv').config();
const { google } = require('googleapis');

const { GMAIL_USER, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

console.log('--- ENV CHECK ---');
console.log('GMAIL_USER:            ', GMAIL_USER || '❌ missing');
console.log('GOOGLE_CLIENT_ID:      ', GOOGLE_CLIENT_ID ? '✓ set' : '❌ missing');
console.log('GOOGLE_CLIENT_SECRET:  ', GOOGLE_CLIENT_SECRET ? '✓ set' : '❌ missing');
console.log('GOOGLE_REFRESH_TOKEN:  ', GOOGLE_REFRESH_TOKEN && GOOGLE_REFRESH_TOKEN !== 'your-refresh-token' ? '✓ set' : '❌ missing or still placeholder');
console.log('');

async function main() {
  try {
    const oAuth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

    console.log('--- FETCHING ACCESS TOKEN ---');
    const { token } = await Promise.race([
      oAuth2Client.getAccessToken(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 8s — possible network issue or invalid credentials')), 8000)),
    ]);
    if (token) {
      console.log('✓ Access token fetched successfully');
    } else {
      console.log('❌ Access token is null — refresh token invalid or revoked');
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

main();
