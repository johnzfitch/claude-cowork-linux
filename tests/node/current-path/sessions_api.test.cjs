const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANTHROPIC_BETA,
  buildAuthHeaders,
  buildCurlRequestArgs,
  CURL_CONNECT_TIMEOUT_SECONDS,
  CURL_MAX_TIME_SECONDS,
  createSessionsApi,
  readAuthTokenFromFileDescriptor,
} = require('../../../stubs/cowork/sessions_api.js');

test('ensureSession reuses fully persisted remote identity without issuing a request', () => {
  let requestCount = 0;
  const sessionsApi = createSessionsApi({
    authToken: 'oauth-token',
    requestSync: () => {
      requestCount += 1;
      return { statusCode: 500, body: '{}' };
    },
  });

  const result = sessionsApi.ensureSession({
    localSessionId: 'local_demo_session',
    remoteSessionAccessToken: 'bridge-token',
    remoteSessionId: 'remote-existing',
  });

  assert.equal(result.success, true);
  assert.equal(result.remoteSessionId, 'remote-existing');
  assert.equal(result.sessionAccessToken, 'bridge-token');
  assert.equal(result.source, 'metadata');
  assert.equal(requestCount, 0);
});

test('ensureSession looks up a partial remote mapping before falling back to create', () => {
  const seenRequests = [];
  const sessionsApi = createSessionsApi({
    authToken: 'oauth-token',
    organizationUuid: 'org-uuid',
    requestSync: (request) => {
      seenRequests.push(request);
      if (request.method === 'GET') {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'not found' }),
        };
      }
      if (request.method === 'POST') {
        return {
          statusCode: 200,
          body: JSON.stringify({
            id: 'remote-created',
            session_access_token: 'bridge-token',
          }),
        };
      }
      throw new Error('Unexpected request: ' + request.method + ' ' + request.url);
    },
  });

  const result = sessionsApi.ensureSession({
    cwd: '/home/zack/dev/claude-cowork-linux-recovery',
    localSessionId: 'local_demo_session',
    model: 'claude-opus-4-6',
    remoteSessionId: 'remote-stale',
    userSelectedFolders: ['/home/zack/dev/claude-cowork-linux-recovery'],
  });

  assert.equal(result.success, true);
  assert.equal(result.remoteSessionId, 'remote-created');
  assert.equal(result.sessionAccessToken, 'bridge-token');
  assert.equal(result.source, 'created');
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0].method, 'GET');
  assert.match(seenRequests[0].url, /^https:\/\/api\.anthropic\.com\/v1\/sessions\/remote-stale$/);
  assert.equal(seenRequests[0].headers.Authorization, 'Bearer oauth-token');
  assert.equal(seenRequests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seenRequests[0].headers['anthropic-beta'], 'oauth-2025-04-20,ccr-byoc-2025-07-29');
  assert.equal(seenRequests[0].headers['x-organization-uuid'], 'org-uuid');
  assert.equal(seenRequests[1].method, 'POST');
  assert.equal(seenRequests[1].headers.Authorization, 'Bearer oauth-token');
  assert.equal(seenRequests[1].headers['x-organization-uuid'], 'org-uuid');
  assert.deepEqual(JSON.parse(seenRequests[1].body), {
    title: 'claude-cowork-linux-recovery',
    events: [],
    permission_mode: 'default',
    session_context: {
      model: 'claude-opus-4-6',
      outcomes: [],
      sources: [],
    },
    source: 'remote-control',
    workspace_roots: ['/home/zack/dev/claude-cowork-linux-recovery'],
  });
});

test('ensureSession reads desktop auth from the inherited file descriptor and falls back to that token', () => {
  const seenRequests = [];
  const readPaths = [];
  const sessionsApi = createSessionsApi({
    authFileDescriptor: '9',
    organizationUuid: 'org-uuid',
    readTextFileSync: (targetPath, encoding) => {
      readPaths.push({ targetPath, encoding });
      return 'fd-token\n';
    },
    requestSync: (request) => {
      seenRequests.push(request);
      return {
        statusCode: 200,
        body: JSON.stringify({
          id: 'remote-created',
        }),
      };
    },
  });

  const result = sessionsApi.ensureSession({
    cwd: '/home/zack/dev/claude-cowork-linux-recovery',
    localSessionId: 'local_demo_session',
    model: 'claude-opus-4-6',
    organizationUuid: 'org-uuid',
  });

  assert.equal(result.success, true);
  assert.equal(result.remoteSessionId, 'remote-created');
  assert.equal(result.sessionAccessToken, 'fd-token');
  assert.equal(readPaths.length >= 1, true);
  assert.equal(readPaths[0].targetPath, '/proc/self/fd/9');
  assert.equal(seenRequests[0].headers.Authorization, 'Bearer fd-token');
});

test('ensureSession falls back to the default Sessions API base URL when the caller passes null', () => {
  const seenRequests = [];
  const sessionsApi = createSessionsApi({
    authToken: 'oauth-token',
    baseUrl: null,
    requestSync: (request) => {
      seenRequests.push(request);
      return {
        statusCode: 200,
        body: JSON.stringify({
          id: 'remote-created',
          session_access_token: 'bridge-token',
        }),
      };
    },
  });

  const result = sessionsApi.ensureSession({
    cwd: '/home/zack/dev/claude-cowork-linux-recovery',
    localSessionId: 'local_demo_session',
  });

  assert.equal(result.success, true);
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].url, 'https://api.anthropic.com/v1/sessions');
});

test('buildCurlRequestArgs applies bounded network timeouts', () => {
  const args = buildCurlRequestArgs({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/sessions',
    headers: {
      Authorization: 'Bearer oauth-token',
    },
    body: JSON.stringify({ title: 'demo' }),
  });

  assert.equal(CURL_CONNECT_TIMEOUT_SECONDS, 2);
  assert.equal(CURL_MAX_TIME_SECONDS, 5);
  assert.deepEqual(args.slice(0, 7), [
    '-sS',
    '--connect-timeout',
    '2',
    '--max-time',
    '5',
    '-X',
    'POST',
  ]);
});

test('updateAuthToken', () => {
  const api = createSessionsApi({ baseUrl: 'https://api.example.com' });
  assert.ok(!api.isConfigured());
  api.updateAuthToken('test-token-value');
  assert.ok(api.isConfigured());
});

test('updateAuthToken ignores empty strings', () => {
  const api = createSessionsApi({ baseUrl: 'https://api.example.com' });
  api.updateAuthToken('');
  assert.ok(!api.isConfigured());
});

test('updateAuthToken ignores non-string values', () => {
  const api = createSessionsApi({ baseUrl: 'https://api.example.com' });
  api.updateAuthToken(42);
  assert.ok(!api.isConfigured());
});

test('postEvents sends correct request shape', () => {
  let capturedRequest = null;
  const api = createSessionsApi({
    authToken: 'test-token',
    baseUrl: 'https://api.example.com',
    requestSync: (req) => {
      capturedRequest = req;
      return { body: '{"ok":true}', statusCode: 200 };
    },
  });
  api.postEvents('session-123', [{ type: 'assistant', content: 'hello' }]);
  assert.ok(capturedRequest);
  assert.strictEqual(capturedRequest.method, 'POST');
  assert.ok(capturedRequest.url.includes('/v1/sessions/session-123/events'));
  const body = JSON.parse(capturedRequest.body);
  assert.ok(Array.isArray(body.events));
  assert.strictEqual(body.events.length, 1);
});

test('postEvents rejects missing remoteSessionId', () => {
  const api = createSessionsApi({ authToken: 'test-token' });
  const result = api.postEvents('', []);
  assert.strictEqual(result.success, false);
});

test('buildAuthHeaders CRLF guard rejects tokens with CRLF', () => {
  const headers = buildAuthHeaders('token-with\r\ninjection', null);
  assert.deepStrictEqual(headers, {});
});

test('buildAuthHeaders CRLF guard rejects tokens with null bytes', () => {
  const headers = buildAuthHeaders('token-with\0null', null);
  assert.deepStrictEqual(headers, {});
});

test('readAuthTokenFromFileDescriptor rejects fd > 9', () => {
  assert.strictEqual(readAuthTokenFromFileDescriptor(10), null);
  assert.strictEqual(readAuthTokenFromFileDescriptor(9999), null);
});

test('readAuthTokenFromFileDescriptor rejects fd < 3', () => {
  assert.strictEqual(readAuthTokenFromFileDescriptor(0), null);
  assert.strictEqual(readAuthTokenFromFileDescriptor(2), null);
});

test('combined beta header contains both beta flags', () => {
  assert.ok(ANTHROPIC_BETA.includes('oauth-2025-04-20'));
  assert.ok(ANTHROPIC_BETA.includes('ccr-byoc-2025-07-29'));
});
