#!/usr/bin/env node
// Fetch latest Claude Desktop download URL via Homebrew cask metadata.
// The old claude.ai/api/desktop endpoint is now behind Cloudflare challenges;
// the Homebrew cask API tracks the same releases without browser requirements.

'use strict';

const https = require('https');
const path = require('path');

const CASK_API = 'https://formulae.brew.sh/api/cask/claude.json';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json' },
    }, (res) => {
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
  const text = await fetch(CASK_API);

  let cask;
  try {
    cask = JSON.parse(text);
  } catch {
    process.stderr.write(`Failed to parse cask response: ${text.slice(0, 200)}\n`);
    process.exit(1);
  }

  if (!cask.url || !cask.version) {
    process.stderr.write(`Unexpected cask response: ${JSON.stringify(cask).slice(0, 200)}\n`);
    process.exit(1);
  }

  // Cask version format: "1.1.7464,commithash" — extract the numeric part
  const version = cask.version.split(',')[0];
  const url = cask.url;
  const sha256 = cask.sha256 || null;
  const filename = path.basename(new URL(url).pathname);

  if (args.includes('--url')) {
    process.stdout.write(url + '\n');
  } else if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ version, url, sha256, filename }) + '\n');
  } else {
    process.stdout.write(`${version} ${url}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
