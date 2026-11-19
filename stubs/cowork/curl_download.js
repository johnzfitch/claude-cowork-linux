'use strict';

// ============================================================================
// Claude Code release downloads through curl (#204)
// ============================================================================
//
// Claude Desktop installs the Claude Code binary before a session starts. Its
// downloader (`[download:N] Starting download from ...` in startup.log) calls
// electron.net.request() with redirect "follow", a 30 s idle timer and two
// retries, then checks the file's SHA-256 against the manifest built into the
// bundle and writes `.verified` itself.
//
// On system Electron 44 (CachyOS, #204) that request connects but never
// receives a byte: `Stalled: no data for 30000ms`, three times, then every
// session fails with "No path to Claude code executable". curl fetches the
// same URL in seconds.
//
// So GET requests to the Claude Code release CDN are handed to curl instead,
// behind an object with the part of Electron's ClientRequest/IncomingMessage
// surface that downloader uses (setHeader, end, abort, 'response', 'error';
// statusCode, headers, a readable body). Everything else -- the checksum,
// resume via Range, retries, `.verified` -- stays the bundle's own code, so a
// bad transfer still fails its checksum exactly as it would under Electron.
//
// Scope is deliberately narrow: only https://downloads.claude.ai/claude-code-releases/,
// only GET, only redirect "follow", only the default session. Any other
// request goes to Electron's net untouched. If curl fails before a response
// (not installed in PATH, or a proxy only Chromium knows about), the next
// request goes to Electron's net once, so the bundle's own retry still gets a
// chance on the old path.
//
// Off switch: CLAUDE_COWORK_CURL_DOWNLOADS=0.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROUTED_HOST = 'downloads.claude.ai';
const ROUTED_PATH_PREFIX = '/claude-code-releases/';
const MAX_HEADER_BYTES = 256 * 1024;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Returns the URL string when this request should go through curl, else null.
function routedUrlFor(options) {
  let url;
  let opts = {};
  if (typeof options === 'string') {
    url = options;
  } else if (options instanceof URL) {
    url = options.href;
  } else if (options && typeof options === 'object' && typeof options.url === 'string') {
    url = options.url;
    opts = options;
  } else {
    return null;
  }

  const method = opts.method === undefined ? 'GET' : String(opts.method).toUpperCase();
  if (method !== 'GET') return null;
  if (opts.redirect !== undefined && opts.redirect !== 'follow') return null;
  // A caller-chosen session or partition may carry its own proxy, cookies or
  // protocol handlers; leave those to Electron.
  if (opts.session !== undefined || opts.partition !== undefined) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== ROUTED_HOST) return null;
  if (parsed.port !== '' && parsed.port !== '443') return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.pathname.startsWith(ROUTED_PATH_PREFIX)) return null;
  return parsed.href;
}

function findExecutable(name, envPath) {
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function assertHeader(name, value) {
  if (typeof name !== 'string' || !HEADER_TOKEN.test(name)) {
    throw new TypeError('Invalid header name: ' + JSON.stringify(name));
  }
  if (/[\r\n\0]/.test(String(value))) {
    throw new TypeError('Invalid value for header ' + JSON.stringify(name));
  }
}

function buildCurlArgs(url, headers, options) {
  const protocols = (options && options.protocols) || '=https';
  const args = [
    '-q', // ignore ~/.curlrc: an -i or -o there would break the parsing below
    '--silent',
    '--show-error',
    // Pass bytes on as they arrive. curl block-buffers stdout when it is a
    // pipe, which would hold back a slow trickle and trip the downloader's
    // idle timer for no reason.
    '--no-buffer',
    '--location',
    '--max-redirs', '10',
    '--proto', protocols,
    '--proto-redir', protocols,
    '--dump-header', '-',
    '--suppress-connect-headers',
  ];
  for (const { name, value } of headers) {
    // `Name;` is curl's spelling for a header with an empty value; `Name:`
    // would remove the header instead.
    args.push('--header', value === '' ? name + ';' : name + ': ' + value);
  }
  args.push('--url', url);
  return args;
}

function parseHeaderBlock(text) {
  const lines = text.split(/\r?\n/);
  const statusLine = lines.shift() || '';
  const match = statusLine.match(/^HTTP\/(\d+)(?:\.(\d+))?\s+(\d{3})(?:\s+(.*))?$/);
  if (!match) return null;
  const headers = {};
  const rawHeaders = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const key = name.toLowerCase();
    rawHeaders.push(name, value);
    if (key === 'set-cookie') {
      (headers[key] = headers[key] || []).push(value);
    } else if (headers[key] === undefined) {
      headers[key] = value;
    } else if (key !== 'content-length' && key !== 'content-type' && key !== 'location') {
      headers[key] += ', ' + value;
    }
  }
  return {
    httpVersionMajor: Number(match[1]),
    httpVersionMinor: match[2] === undefined ? 0 : Number(match[2]),
    statusCode: Number(match[3]),
    statusMessage: match[4] || '',
    headers,
    rawHeaders,
  };
}

// Consumes curl's stdout (header blocks from --dump-header -, then the body)
// and reports the final response's head plus any body bytes that arrived in
// the same chunk. With --location curl prints one block per hop; 1xx blocks
// and 3xx blocks that carry a Location are hops, not the answer.
function createHeadParser() {
  let buffered = Buffer.alloc(0);
  let done = false;
  return {
    push(chunk) {
      if (done) throw new Error('head already parsed');
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      for (;;) {
        const end = buffered.indexOf('\r\n\r\n');
        const endLf = buffered.indexOf('\n\n');
        let cut = -1;
        let sep = 0;
        if (end !== -1 && (endLf === -1 || end < endLf)) {
          cut = end;
          sep = 4;
        } else if (endLf !== -1) {
          cut = endLf;
          sep = 2;
        }
        if (cut === -1) {
          if (buffered.length > MAX_HEADER_BYTES) {
            throw new Error('curl response headers exceed ' + MAX_HEADER_BYTES + ' bytes');
          }
          return null;
        }
        const block = parseHeaderBlock(buffered.subarray(0, cut).toString('latin1'));
        buffered = buffered.subarray(cut + sep);
        if (!block) throw new Error('curl printed an unparseable status line');
        if (block.statusCode < 200) continue;
        if (block.statusCode >= 300 && block.statusCode < 400 && block.headers.location) continue;
        done = true;
        return { head: block, rest: buffered };
      }
    },
  };
}

class CurlIncomingMessage extends PassThrough {
  constructor(head) {
    super();
    this.statusCode = head.statusCode;
    this.statusMessage = head.statusMessage;
    this.headers = head.headers;
    this.rawHeaders = head.rawHeaders;
    this.httpVersionMajor = head.httpVersionMajor;
    this.httpVersionMinor = head.httpVersionMinor;
    this.httpVersion = head.httpVersionMajor + '.' + head.httpVersionMinor;
  }
}

// Ends a response stream with an error, unless nobody listens for one: the
// downloader leaves the body of a 404 or 416 unread, and an 'error' with no
// listener would be an uncaught exception in Claude Desktop's main process.
function destroyResponse(response, error) {
  if (response.destroyed) return;
  if (response.listenerCount('error') > 0) response.destroy(error);
  else response.destroy();
}

class CurlClientRequest extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.method = 'GET';
    this._curlPath = options.curlPath || 'curl';
    this._spawn = options.spawn || childProcess.spawn;
    this._env = options.env || process.env;
    this._protocols = options.protocols;
    this._log = options.log || (() => {});
    this._onCurlFailure = options.onCurlFailure || (() => {});
    this._headers = new Map();
    this._child = null;
    this._response = null;
    this._started = false;
    this._finished = false;
    this._stderr = '';
    if (options.headers && typeof options.headers === 'object') {
      for (const [name, value] of Object.entries(options.headers)) this.setHeader(name, value);
    }
  }

  setHeader(name, value) {
    if (this._started) throw new Error('Cannot set headers after the request was started');
    assertHeader(name, value);
    this._headers.set(name.toLowerCase(), { name, value: String(value) });
  }

  getHeader(name) {
    const entry = this._headers.get(String(name).toLowerCase());
    return entry ? entry.value : undefined;
  }

  removeHeader(name) {
    if (this._started) throw new Error('Cannot remove headers after the request was started');
    this._headers.delete(String(name).toLowerCase());
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null && chunk.length !== 0) {
      throw new Error('A GET request routed through curl takes no body');
    }
    return true;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
    }
    this.write(chunk);
    if (this._started || this._finished) return this;
    this._started = true;
    if (typeof callback === 'function') this.once('finish', callback);
    this._start();
    return this;
  }

  abort() {
    if (this._finished) return;
    this._finished = true;
    this._kill();
    this.emit('abort');
    const response = this._response;
    if (response && !response.readableEnded && !response.destroyed) {
      response.emit('aborted');
      destroyResponse(response, new Error('Request aborted'));
    }
    this.emit('close');
  }

  _kill() {
    if (this._child && this._child.exitCode === null && this._child.signalCode === null) {
      try { this._child.kill('SIGTERM'); } catch (_) {}
    }
  }

  _fail(error) {
    if (this._finished) return;
    this._finished = true;
    this._kill();
    if (this._response) {
      destroyResponse(this._response, error);
    } else {
      this._onCurlFailure(error);
      this.emit('error', error);
    }
    this.emit('close');
  }

  _start() {
    const args = buildCurlArgs(this.url, this._headers.values(), { protocols: this._protocols });
    this._log('[curl-download] GET ' + this.url + ' via ' + this._curlPath);
    let child;
    try {
      child = this._spawn(this._curlPath, args, {
        env: this._env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      process.nextTick(() => this._fail(new Error('Could not start curl: ' + error.message)));
      return;
    }
    this._child = child;
    process.nextTick(() => this.emit('finish'));

    const parser = createHeadParser();
    const onHeadData = (chunk) => {
      if (this._finished) return;
      let parsed;
      try {
        parsed = parser.push(chunk);
      } catch (error) {
        child.stdout.removeListener('data', onHeadData);
        this._fail(error);
        return;
      }
      if (!parsed) return;
      child.stdout.removeListener('data', onHeadData);
      child.stdout.pause();
      const response = new CurlIncomingMessage(parsed.head);
      this._response = response;
      if (parsed.rest.length) response.write(parsed.rest);
      child.stdout.pipe(response, { end: false });
      this.emit('response', response);
    };
    child.stdout.on('data', onHeadData);
    child.stderr.on('data', (chunk) => {
      if (this._stderr.length < 4096) this._stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      this._fail(new Error('Could not start curl: ' + error.message));
    });
    child.on('close', (code, signal) => {
      if (this._finished) return;
      if (code === 0 && this._response) {
        this._finished = true;
        this._response.end();
        this.emit('close');
        return;
      }
      const detail = this._stderr.trim().split('\n').pop() || 'no output';
      const how = signal ? 'was killed by ' + signal : 'exited with code ' + code;
      this._fail(new Error(
        this._response
          ? 'curl ' + how + ' mid-transfer: ' + detail
          : (code === 0 ? 'curl exited without a response' : 'curl ' + how + ': ' + detail)
      ));
    });
  }
}

// Returns an object that stands in for electron.net: `request` is routed,
// every other member is the real net's (inherited, so getters still work).
function createCurlRoutedNet(realNet, options = {}) {
  if (!realNet || typeof realNet.request !== 'function') return null;
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const curlPath = options.curlPath || findExecutable('curl', env.PATH);
  if (!curlPath) {
    log('[curl-download] curl not found in PATH; Claude Code downloads stay on Electron net');
    return null;
  }
  const originalRequest = realNet.request;
  let useElectronNext = false;

  function request(requestOptions, callback) {
    const url = routedUrlFor(requestOptions);
    if (!url || useElectronNext) {
      if (url) {
        useElectronNext = false;
        log('[curl-download] curl failed last time; trying Electron net for ' + url);
      }
      return originalRequest.apply(realNet, arguments);
    }
    const req = new CurlClientRequest(url, {
      curlPath,
      env,
      log,
      spawn: options.spawn,
      protocols: options.protocols,
      headers: requestOptions && typeof requestOptions === 'object' && !(requestOptions instanceof URL)
        ? requestOptions.headers
        : undefined,
      onCurlFailure: (error) => {
        useElectronNext = true;
        log('[curl-download] ' + error.message);
      },
    });
    if (typeof callback === 'function') req.once('response', callback);
    return req;
  }
  request.__coworkCurlRouted = true;

  const routed = Object.create(realNet);
  Object.defineProperty(routed, 'request', { value: request, enumerable: true, writable: true, configurable: true });
  return routed;
}

// One routed net per real net object, for the electron module Proxy's get
// trap. Returns the real net when routing is off or unavailable.
function createNetRouter(options = {}) {
  const env = options.env || process.env;
  if (env.CLAUDE_COWORK_CURL_DOWNLOADS === '0') {
    if (options.log) options.log('[curl-download] disabled by CLAUDE_COWORK_CURL_DOWNLOADS=0');
    return (realNet) => realNet;
  }
  const cache = new WeakMap();
  return (realNet) => {
    if (!realNet || (typeof realNet !== 'object' && typeof realNet !== 'function')) return realNet;
    if (!cache.has(realNet)) {
      let routed = null;
      try {
        routed = createCurlRoutedNet(realNet, options);
      } catch (error) {
        if (options.log) options.log('[curl-download] setup failed: ' + error.message);
      }
      cache.set(realNet, routed || realNet);
    }
    return cache.get(realNet);
  };
}

module.exports = {
  ROUTED_HOST,
  ROUTED_PATH_PREFIX,
  routedUrlFor,
  buildCurlArgs,
  parseHeaderBlock,
  createHeadParser,
  CurlClientRequest,
  createCurlRoutedNet,
  createNetRouter,
  findExecutable,
};
