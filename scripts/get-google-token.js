// One-time script. Run this ONCE to link your Google account to the app.
// It opens a tiny local web server, walks you through Google's login screen
// in your browser, and prints a "refresh token" you paste into .env.
// After that, this script is never needed again — the server uses the
// refresh token to create calendar events without you logging in each time.

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in your .env file.');
  console.error('Add those two values first, then run this script again.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // required to get a refresh_token back, not just a short-lived token
  prompt: 'consent', // forces Google to show the consent screen and re-issue a refresh_token every time
  scope: ['https://www.googleapis.com/auth/calendar.events'],
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Log in with the Google account you want bookings to appear on.');
console.log('3. Click Allow.');
console.log('4. This script will catch the response automatically — come back here after.\n');
console.log('Waiting for you to finish in the browser...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.end('Not the callback path.');
    return;
  }

  const urlObj = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  const code = urlObj.searchParams.get('code');

  if (!code) {
    res.end('No authorization code found in the URL. Something went wrong.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.end('Success! You can close this tab and go back to your terminal.');

    console.log('\n=========================================');
    console.log('SUCCESS. Copy this into your .env file as:');
    console.log('=========================================\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.log(
        'WARNING: No refresh_token was returned. This usually means you already ' +
        'authorized this app before. Go to https://myaccount.google.com/permissions, ' +
        'remove access for this app, then run this script again.'
      );
    }

    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Error exchanging code for tokens:', err.message);
    res.end('Something went wrong — check your terminal.');
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  // Waiting silently — the console.log above already told the user what to do.
});