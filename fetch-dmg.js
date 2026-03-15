#!/usr/bin/env node
// Fetch latest Claude Desktop DMG URL from Anthropic's API.
// Replaces fetch-dmg.py + rnet dependency with zero external deps.

'use strict';

const https = require('https');

const API_URL = 'https://claude.ai/api/desktop/darwin/universal/dmg/latest';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const text = await fetch(API_URL);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    process.stderr.write(`Failed to parse API response: ${text.slice(0, 200)}\n`);
    process.exit(1);
  }

  if (!data.url || !data.version) {
    process.stderr.write(`Unexpected API response: ${JSON.stringify(data).slice(0, 200)}\n`);
    process.exit(1);
  }

  if (args.includes('--url')) {
    process.stdout.write(data.url + '\n');
  } else if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    process.stdout.write(`${data.version} ${data.url}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
