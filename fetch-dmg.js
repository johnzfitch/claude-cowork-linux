#!/usr/bin/env node
// Fetch Claude Desktop download URL via Homebrew cask metadata.
// The old claude.ai/api/desktop endpoint is now behind Cloudflare challenges;
// the Homebrew cask API tracks the same releases without browser requirements.
//
// Usage:
//   node fetch-dmg.js              # prints "version url"
//   node fetch-dmg.js --url        # prints just the download URL
//   node fetch-dmg.js --json       # prints JSON with version, url, sha256, filename
//   node fetch-dmg.js --version X  # constructs URL for a specific version (no cask lookup)

'use strict';

const https = require('https');
const path = require('path');

const CASK_API = 'https://formulae.brew.sh/api/cask/claude.json';

// Anthropic's CDN URL pattern. Used when --version is given to bypass the
// cask (which only knows the latest). The pattern is stable as of May 2026.
const CDN_URL_TEMPLATE = 'https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude-Setup-universal.dmg';
// Versioned pattern observed in cask history:
const VERSIONED_CDN_TEMPLATE = 'https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-VERSION/Claude-Setup-universal.dmg';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ': ' + res.statusMessage));
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

function httpHead(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      method: 'HEAD',
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'Accept': '*/*' },
    }, (res) => {
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('HEAD timeout')); });
    req.end();
  });
}

function getVersionArg(args) {
  const idx = args.indexOf('--version');
  if (idx < 0) return null;
  const val = args[idx + 1];
  if (!val || val.startsWith('-')) {
    process.stderr.write('--version requires a value (e.g. --version 1.6259.1)\n');
    process.exit(1);
  }
  // Basic sanity: version should be digits and dots only.
  if (!/^\d+\.\d+\.\d+$/.test(val)) {
    process.stderr.write('Version must be digits and dots (e.g. 1.6259.1), got: ' + val + '\n');
    process.exit(1);
  }
  return val;
}

async function resolveVersionedUrl(version) {
  // Try the versioned CDN pattern first. If it 404s, fall back to the
  // redirect-based API URL which sometimes resolves to the right version.
  const candidates = [
    VERSIONED_CDN_TEMPLATE.replace('VERSION', version),
    'https://claude.ai/api/desktop/darwin/universal/dmg/' + version + '/redirect',
  ];
  for (const url of candidates) {
    try {
      const status = await httpHead(url);
      if (status >= 200 && status < 400) return url;
    } catch (_) {}
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const requestedVersion = getVersionArg(args);

  // If --version is given, try to construct a direct URL without the cask.
  if (requestedVersion) {
    const url = await resolveVersionedUrl(requestedVersion);
    if (!url) {
      process.stderr.write('Could not find a download URL for version ' + requestedVersion + '.\n');
      process.stderr.write('The CDN may not serve historical versions. Try downloading manually\n');
      process.stderr.write('and passing the file via CLAUDE_ARCHIVE=/path/to/Claude.dmg\n');
      process.exit(1);
    }
    const filename = 'Claude-Setup-universal.dmg';
    if (args.includes('--url')) {
      process.stdout.write(url + '\n');
    } else if (args.includes('--json')) {
      process.stdout.write(JSON.stringify({ version: requestedVersion, url, sha256: null, filename }) + '\n');
    } else {
      process.stdout.write(requestedVersion + ' ' + url + '\n');
    }
    return;
  }

  // Default: look up latest via cask API.
  const text = await httpGet(CASK_API);

  let cask;
  try {
    cask = JSON.parse(text);
  } catch {
    process.stderr.write('Failed to parse cask response: ' + text.slice(0, 200) + '\n');
    process.exit(1);
  }

  if (!cask.url || !cask.version) {
    process.stderr.write('Unexpected cask response: ' + JSON.stringify(cask).slice(0, 200) + '\n');
    process.exit(1);
  }

  // Cask version format: "1.1.7464,commithash" -- extract the numeric part
  const version = cask.version.split(',')[0];
  const url = cask.url;
  const sha256 = cask.sha256 || null;
  const filename = path.basename(new URL(url).pathname);

  if (args.includes('--url')) {
    process.stdout.write(url + '\n');
  } else if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ version, url, sha256, filename }) + '\n');
  } else {
    process.stdout.write(version + ' ' + url + '\n');
  }
}

main().catch(function(err) {
  process.stderr.write('Error: ' + err.message + '\n');
  process.exit(1);
});
