const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough, pipeline } = require('stream');
const { promisify } = require('util');

const {
  routedUrlFor,
  buildCurlArgs,
  parseHeaderBlock,
  createHeadParser,
  CurlClientRequest,
  createCurlRoutedNet,
  createNetRouter,
  findExecutable,
} = require('../../../stubs/cowork/curl_download.js');

const REAL_CURL = findExecutable('curl', process.env.PATH);
const CCD_URL = 'https://downloads.claude.ai/claude-code-releases/2.1.222/darwin-arm64/claude.app.tar.zst';

// ---------------------------------------------------------------------------
// Which requests are routed
// ---------------------------------------------------------------------------

test('routedUrlFor takes the Claude Desktop downloader call shape (#204)', () => {
  // The exact options object the bundle's downloader passes to net.request.
  assert.equal(routedUrlFor({ url: CCD_URL, redirect: 'follow', useSessionCookies: true, cache: 'no-store' }), CCD_URL);
  assert.equal(routedUrlFor(CCD_URL), CCD_URL);
  assert.equal(routedUrlFor(new URL(CCD_URL)), CCD_URL);
  assert.equal(routedUrlFor({ url: CCD_URL, method: 'get' }), CCD_URL);
  assert.equal(routedUrlFor({ url: 'https://downloads.claude.ai:443/claude-code-releases/x' }),
    'https://downloads.claude.ai/claude-code-releases/x');
});

test('routedUrlFor leaves every other request on Electron net', () => {
  const cases = [
    { url: 'https://claude.ai/api/account' },
    { url: 'https://downloads.claude.ai/releases/darwin/universal/6.6395.1/Claude.zip' },
    { url: 'http://downloads.claude.ai/claude-code-releases/x' },
    { url: 'https://downloads.claude.ai.example.com/claude-code-releases/x' },
    { url: 'https://user:pw@downloads.claude.ai/claude-code-releases/x' },
    { url: 'https://downloads.claude.ai:8443/claude-code-releases/x' },
    { url: CCD_URL, method: 'POST' },
    { url: CCD_URL, method: 'HEAD' },
    { url: CCD_URL, redirect: 'manual' },
    { url: CCD_URL, redirect: 'error' },
    { url: CCD_URL, session: {} },
    { url: CCD_URL, partition: 'persist:x' },
    { protocol: 'https:', hostname: 'downloads.claude.ai', path: '/claude-code-releases/x' },
    { url: 'not a url' },
    null,
    undefined,
    42,
  ];
  for (const options of cases) {
    assert.equal(routedUrlFor(options), null, JSON.stringify(options));
  }
});

// ---------------------------------------------------------------------------
// curl argv and header parsing
// ---------------------------------------------------------------------------

test('buildCurlArgs ignores ~/.curlrc, follows https-only redirects and passes headers', () => {
  const args = buildCurlArgs(CCD_URL, [
    { name: 'Range', value: 'bytes=100-' },
    { name: 'X-Empty', value: '' },
  ]);
  assert.equal(args[0], '-q', '-q only works as the first argument');
  assert.ok(args.includes('--location'));
  assert.ok(args.includes('--no-buffer'), 'bytes must reach the idle timer as they arrive');
  assert.deepEqual(args.slice(args.indexOf('--proto'), args.indexOf('--proto') + 2), ['--proto', '=https']);
  assert.deepEqual(args.slice(args.indexOf('--proto-redir'), args.indexOf('--proto-redir') + 2), ['--proto-redir', '=https']);
  assert.ok(args.includes('--suppress-connect-headers'), 'a proxy CONNECT reply must not look like the response');
  assert.ok(!args.includes('--fail'), 'non-2xx statuses must reach the caller, which handles 206/416');
  assert.deepEqual(args.slice(-2), ['--url', CCD_URL]);
  assert.ok(args.includes('Range: bytes=100-'));
  assert.ok(args.includes('X-Empty;'));
});

test('setHeader refuses header injection', () => {
  const req = new CurlClientRequest(CCD_URL, { spawn: () => { throw new Error('not started'); } });
  assert.throws(() => req.setHeader('Range', 'bytes=0-\r\nX-Evil: 1'), TypeError);
  assert.throws(() => req.setHeader('Bad Name', 'x'), TypeError);
  req.setHeader('Cache-Control', 'no-cache');
  assert.equal(req.getHeader('cache-control'), 'no-cache');
});

test('parseHeaderBlock reads HTTP/1.1 and HTTP/2 status lines and folds duplicates', () => {
  const h1 = parseHeaderBlock('HTTP/1.1 206 Partial Content\r\nContent-Length: 10\r\nContent-Range: bytes 5-14/15\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nVary: A\r\nVary: B');
  assert.equal(h1.statusCode, 206);
  assert.equal(h1.statusMessage, 'Partial Content');
  assert.equal(h1.headers['content-length'], '10');
  assert.equal(h1.headers['content-range'], 'bytes 5-14/15');
  assert.deepEqual(h1.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(h1.headers.vary, 'A, B');
  const h2 = parseHeaderBlock('HTTP/2 200\r\ncontent-length: 3');
  assert.equal(h2.statusCode, 200);
  assert.equal(h2.httpVersionMajor, 2);
  assert.equal(h2.statusMessage, '');
  assert.equal(parseHeaderBlock('garbage'), null);
});

test('createHeadParser skips redirect and 1xx hops and keeps body bytes', () => {
  const stream = Buffer.concat([
    Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'),
    Buffer.from('HTTP/2 302\r\nlocation: https://cdn.example/x\r\n\r\n'),
    Buffer.from('HTTP/2 200\r\ncontent-length: 6\r\n\r\n'),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x0d, 0x0a]), // binary body, contains CRLF
  ]);
  // Feed it one byte at a time: block boundaries must survive any chunking.
  const parser = createHeadParser();
  let parsed = null;
  let i = 0;
  for (; i < stream.length && !parsed; i++) parsed = parser.push(stream.subarray(i, i + 1));
  assert.ok(parsed);
  assert.equal(parsed.head.statusCode, 200);
  const body = Buffer.concat([parsed.rest, stream.subarray(i)]);
  assert.deepEqual([...body], [0x28, 0xb5, 0x2f, 0xfd, 0x0d, 0x0a]);
});

test('createHeadParser treats a 3xx without Location as the answer', () => {
  const parsed = createHeadParser().push(Buffer.from('HTTP/1.1 304 Not Modified\r\n\r\n'));
  assert.equal(parsed.head.statusCode, 304);
});

test('createHeadParser refuses unbounded header output', () => {
  const parser = createHeadParser();
  assert.throws(() => parser.push(Buffer.alloc(300 * 1024, 0x41)), /exceed/);
});

// ---------------------------------------------------------------------------
// Real curl against a local server
// ---------------------------------------------------------------------------

function startServer(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function localRequest(url) {
  return new CurlClientRequest(url, { curlPath: REAL_CURL, protocols: '=http', env: { PATH: process.env.PATH } });
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

const BODY = crypto.randomBytes(256 * 1024 + 17);

function serveBody(req, res) {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/file' });
    res.end();
    return;
  }
  if (req.url === '/missing') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nope');
    return;
  }
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d+)-$/);
  if (range) {
    const start = Number(range[1]);
    if (start >= BODY.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Length': String(BODY.length - start),
      'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
    });
    res.end(BODY.subarray(start));
    return;
  }
  res.writeHead(200, { 'Content-Length': String(BODY.length), 'X-Seen-Cache-Control': req.headers['cache-control'] || '' });
  res.end(BODY);
}

// Drives a CurlClientRequest the way the bundle's downloader drives
// electron.net.request: headers, end(), 'response', status check, then
// pipeline(response, file).
async function downloadLikeTheBundle(url, { range, file } = {}) {
  const req = localRequest(url);
  req.setHeader('Cache-Control', 'no-cache');
  req.setHeader('Pragma', 'no-cache');
  if (range) req.setHeader('Range', `bytes=${range}-`);
  const result = new Promise((resolve, reject) => {
    req.on('response', async (res) => {
      try {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          resolve({ statusCode: res.statusCode, headers: res.headers });
          return;
        }
        assert.equal(typeof res.isPaused, 'function');
        let dataEvents = 0;
        res.on('data', () => { dataEvents += 1; });
        await promisify(pipeline)(res, fs.createWriteStream(file, { flags: range ? 'a' : 'w' }));
        resolve({ statusCode: res.statusCode, headers: res.headers, dataEvents });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
  req.end();
  return result;
}

test('a download through real curl follows redirects and delivers the exact bytes', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  const base = await startServer(t, serveBody);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'download.partial');

  const result = await downloadLikeTheBundle(base + '/redirect', { file });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-length'], String(BODY.length));
  assert.equal(result.headers['x-seen-cache-control'], 'no-cache', 'request headers must reach the server');
  assert.ok(result.dataEvents > 0, "the downloader's idle timer is fed by 'data' events");
  assert.ok(fs.readFileSync(file).equals(BODY));
});

test('a resumed download gets 206 and Content-Range, and 416 reaches the caller', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  const base = await startServer(t, serveBody);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'download.partial');
  fs.writeFileSync(file, BODY.subarray(0, 1000));

  const resumed = await downloadLikeTheBundle(base + '/file', { range: 1000, file });
  assert.equal(resumed.statusCode, 206);
  assert.equal(resumed.headers['content-range'], `bytes 1000-${BODY.length - 1}/${BODY.length}`);
  assert.ok(fs.readFileSync(file).equals(BODY));

  const past = await downloadLikeTheBundle(base + '/file', { range: BODY.length, file });
  assert.equal(past.statusCode, 416);
  const missing = await downloadLikeTheBundle(base + '/missing', { file });
  assert.equal(missing.statusCode, 404);
});

test('a transfer cut short fails the response stream instead of ending it', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  const base = await startServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '100000' });
    res.write(Buffer.alloc(1000, 1));
    setTimeout(() => res.socket.destroy(), 50);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    downloadLikeTheBundle(base + '/file', { file: path.join(dir, 'x') }),
    /curl exited with code \d+ mid-transfer/,
  );
});

test('a failed transfer of an unread response does not throw', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  // The downloader returns on a 404 without reading the body. If that body
  // is then cut off, the stream must close quietly: an 'error' with no
  // listener would crash Claude Desktop's main process.
  const base = await startServer(t, (req, res) => {
    res.writeHead(404, { 'Content-Length': '100000' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 50);
  });
  const req = localRequest(base + '/missing');
  const responsePromise = once(req, 'response');
  req.end();
  const res = await responsePromise;
  assert.equal(res.statusCode, 404);
  await once(res, 'close');
  assert.equal(res.destroyed, true);
});

test('abort() mid-transfer kills curl and errors the response', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  let serverSocketClosed;
  const closed = new Promise((resolve) => { serverSocketClosed = resolve; });
  const base = await startServer(t, (req, res) => {
    res.socket.on('close', serverSocketClosed);
    res.writeHead(200, { 'Content-Length': '100000000' });
    res.write(Buffer.alloc(1000, 2)); // then go quiet, like the #204 stall
  });
  const req = localRequest(base + '/file');
  const responsePromise = once(req, 'response');
  req.end();
  const res = await responsePromise;
  await once(res, 'data');
  const errored = once(res, 'error');
  const aborted = once(req, 'abort');
  req.abort();
  await aborted;
  assert.match((await errored).message, /Request aborted/);
  await closed; // curl is gone, so its connection is too
});

test('a connection failure before any response is an error event', { skip: !REAL_CURL && 'curl not installed' }, async (t) => {
  // Bind then close a port so nothing listens on it.
  const base = await new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const req = localRequest(base + '/file');
  const errored = once(req, 'error');
  req.end();
  const error = await errored;
  assert.match(error.message, /^curl exited with code 7: /);
});

// ---------------------------------------------------------------------------
// The net stand-in
// ---------------------------------------------------------------------------

function fakeNet() {
  const calls = [];
  const net = {
    request(options) {
      calls.push(options);
      const req = new EventEmitter();
      req.end = () => req;
      req.setHeader = () => {};
      req.electron = true;
      return req;
    },
    fetch: () => 'electron-fetch',
  };
  Object.defineProperty(net, 'online', { get: () => true, enumerable: true });
  return { net, calls };
}

// A spawn() that behaves like curl printing the given stdout and exiting.
function fakeCurl(stdout, code = 0, { error } = {}) {
  const spawned = [];
  const spawn = (file, args) => {
    spawned.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    process.nextTick(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (code !== 0) child.stderr.end('curl: (6) Could not resolve host: downloads.claude.ai\n');
      else child.stderr.end();
      child.stdout.end(stdout);
      child.stdout.on('end', () => setImmediate(() => {
        child.exitCode = code;
        child.emit('close', code, null);
      }));
    });
    return child;
  };
  return { spawn, spawned };
}

test('the routed net sends release downloads to curl and everything else to Electron', async () => {
  const { net, calls } = fakeNet();
  const curl = fakeCurl(Buffer.from('HTTP/2 200\r\ncontent-length: 2\r\n\r\nok'));
  const routed = createCurlRoutedNet(net, { curlPath: '/usr/bin/curl', spawn: curl.spawn, env: {} });

  assert.equal(routed.fetch(), 'electron-fetch', 'other members are the real net');
  assert.equal(routed.online, true, 'getters still work');

  const other = routed.request({ url: 'https://claude.ai/api/account', redirect: 'error' });
  assert.equal(other.electron, true);
  assert.equal(calls.length, 1);

  const req = routed.request({ url: CCD_URL, redirect: 'follow', useSessionCookies: true, cache: 'no-store' });
  assert.ok(req instanceof CurlClientRequest);
  const responsePromise = once(req, 'response');
  req.end();
  const res = await responsePromise;
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ok');
  assert.equal(curl.spawned[0].file, '/usr/bin/curl');
  assert.equal(calls.length, 1, 'the routed request never touched Electron net');
});

test('after curl fails before a response, the next attempt goes to Electron net once', async () => {
  const { net, calls } = fakeNet();
  const curl = fakeCurl(Buffer.alloc(0), 6);
  const logs = [];
  const routed = createCurlRoutedNet(net, { curlPath: '/usr/bin/curl', spawn: curl.spawn, env: {}, log: (m) => logs.push(m) });

  const first = routed.request({ url: CCD_URL });
  const errored = once(first, 'error');
  first.end();
  assert.match((await errored).message, /curl exited with code 6: curl: \(6\) Could not resolve host/);

  const second = routed.request({ url: CCD_URL });
  assert.equal(second.electron, true, 'retry falls back to Electron net');
  const third = routed.request({ url: CCD_URL });
  assert.ok(third instanceof CurlClientRequest, 'and only once');
  assert.equal(calls.length, 1);
  assert.ok(logs.some((m) => m.includes('trying Electron net')));
});

test('a curl that cannot be started is an error event, not a throw', async () => {
  const { net } = fakeNet();
  const curl = fakeCurl(null, 0, { error: Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }) });
  const routed = createCurlRoutedNet(net, { curlPath: '/nonexistent/curl', spawn: curl.spawn, env: {} });
  const req = routed.request({ url: CCD_URL });
  const errored = once(req, 'error');
  req.end();
  assert.match((await errored).message, /Could not start curl: spawn curl ENOENT/);
});

test('createCurlRoutedNet keeps Electron net when curl is not in PATH', () => {
  const { net } = fakeNet();
  assert.equal(createCurlRoutedNet(net, { env: { PATH: '/nonexistent' } }), null);
  assert.equal(createNetRouter({ env: { PATH: '/nonexistent' } })(net), net);
});

test('createNetRouter honours CLAUDE_COWORK_CURL_DOWNLOADS=0 and caches per net object', () => {
  const { net } = fakeNet();
  assert.equal(createNetRouter({ env: { CLAUDE_COWORK_CURL_DOWNLOADS: '0', PATH: process.env.PATH } })(net), net);

  const router = createNetRouter({ env: { PATH: '/x' }, curlPath: '/usr/bin/curl' });
  const a = router(net);
  assert.notEqual(a, net);
  assert.equal(router(net), a, 'the same stand-in every time the asar reads electron.net');
  assert.equal(a.request.__coworkCurlRouted, true);
  assert.equal(router(undefined), undefined);
});

test('the frame-fix electron Proxy serves net through the curl router', () => {
  const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
  const source = fs.readFileSync(wrapperPath, 'utf8');
  assert.match(source, /require\('\.\/cowork\/curl_download\.js'\)/);
  assert.match(source, /if \(prop === 'net'\) return global\.__coworkNetRouter\(target\.net\);/);
});
