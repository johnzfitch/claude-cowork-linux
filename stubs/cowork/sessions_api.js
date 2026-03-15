const { execFileSync } = require('child_process');
const fs = require('fs');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20,ccr-byoc-2025-07-29';
const CURL_CONNECT_TIMEOUT_SECONDS = 2;
const CURL_MAX_TIME_SECONDS = 5;

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return null;
  }
  return baseUrl.replace(/\/+$/g, '');
}

function normalizeRemoteSessionRecord(value) {
  const candidateValues = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    candidateValues.push(value);
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
      candidateValues.unshift(value.data);
    }
  }

  for (const candidateValue of candidateValues) {
    const remoteSessionId = [
      candidateValue.remoteSessionId,
      candidateValue.sessionId,
      candidateValue.session_id,
      candidateValue.id,
    ].find((candidate) => typeof candidate === 'string' && candidate.trim()) || null;
    const sessionAccessToken = [
      candidateValue.remoteSessionAccessToken,
      candidateValue.sessionAccessToken,
      candidateValue.session_access_token,
      candidateValue.session_ingress_token,
      candidateValue.accessToken,
      candidateValue.access_token,
    ].find((candidate) => typeof candidate === 'string' && candidate.trim()) || null;

    if (!remoteSessionId && !sessionAccessToken) {
      continue;
    }

    return {
      raw: candidateValue,
      remoteSessionId,
      sessionAccessToken,
    };
  }

  return null;
}

function parseJsonResponseBody(responseBody) {
  if (typeof responseBody !== 'string' || !responseBody.trim()) {
    return null;
  }
  return JSON.parse(responseBody);
}

function buildCurlRequestArgs(request) {
  const args = [
    '-sS',
    '--connect-timeout',
    String(CURL_CONNECT_TIMEOUT_SECONDS),
    '--max-time',
    String(CURL_MAX_TIME_SECONDS),
    '-X',
    request.method,
    '-H',
    'Accept: application/json',
  ];

  for (const [headerName, headerValue] of Object.entries(request.headers || {})) {
    if (typeof headerValue !== 'string' || !headerValue.length) {
      continue;
    }
    args.push('-H', headerName + ': ' + headerValue);
  }

  if (request.body !== null && request.body !== undefined) {
    args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', request.body);
  }

  args.push('-w', '\n%{http_code}');
  args.push(request.url);
  return args;
}

function defaultRequestSync(request) {
  const stdout = execFileSync('curl', buildCurlRequestArgs(request), {
    encoding: 'utf8',
  });
  const separatorIndex = stdout.lastIndexOf('\n');
  if (separatorIndex === -1) {
    throw new Error('Invalid curl response format');
  }

  const body = stdout.slice(0, separatorIndex);
  const statusCode = Number(stdout.slice(separatorIndex + 1));
  if (!Number.isFinite(statusCode)) {
    throw new Error('Invalid HTTP status code from curl response');
  }

  return {
    body,
    statusCode,
  };
}

function readAuthTokenFromFileDescriptor(authFileDescriptor, readTextFileSync) {
  const normalizedFd = Number(authFileDescriptor);
  if (!Number.isInteger(normalizedFd) || normalizedFd < 3 || normalizedFd > 9) {
    return null;
  }

  const readFile = typeof readTextFileSync === 'function' ? readTextFileSync : fs.readFileSync;
  const rawToken = readFile('/proc/self/fd/' + normalizedFd, 'utf8');
  if (typeof rawToken !== 'string') {
    return null;
  }
  const trimmedToken = rawToken.trim();
  return trimmedToken || null;
}

function buildAuthHeaders(authToken, organizationUuid) {
  if (typeof authToken !== 'string' || !authToken.trim()) {
    return {};
  }

  const normalizedToken = authToken.trim();
  if (/[\r\n\0]/.test(normalizedToken)) {
    return {};
  }

  const headers = normalizedToken.startsWith('sk-ant-sid')
    ? { Cookie: 'sessionKey=' + normalizedToken }
    : { Authorization: 'Bearer ' + normalizedToken };

  headers['anthropic-version'] = ANTHROPIC_VERSION;
  headers['anthropic-beta'] = ANTHROPIC_BETA;
  if (typeof organizationUuid === 'string' && organizationUuid.trim()) {
    headers['x-organization-uuid'] = organizationUuid.trim();
  }
  return headers;
}

function normalizeSessionListResponse(responseBody) {
  if (Array.isArray(responseBody)) {
    return responseBody;
  }
  if (responseBody && Array.isArray(responseBody.data)) {
    return responseBody.data;
  }
  if (responseBody && Array.isArray(responseBody.sessions)) {
    return responseBody.sessions;
  }
  return [];
}

class SessionsApi {
  constructor(options) {
    const {
      authToken = null,
      authFileDescriptor = null,
      baseUrl = DEFAULT_BASE_URL,
      organizationUuid = null,
      requestSync = null,
      readTextFileSync = null,
      trace = () => {},
    } = options || {};

    this._authToken = typeof authToken === 'string' && authToken.trim() ? authToken : null;
    this._authFileDescriptor = authFileDescriptor;
    this._baseUrl = normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL;
    this._organizationUuid = typeof organizationUuid === 'string' && organizationUuid.trim()
      ? organizationUuid.trim()
      : null;
    this._requestSync = typeof requestSync === 'function' ? requestSync : defaultRequestSync;
    this._readTextFileSync = typeof readTextFileSync === 'function' ? readTextFileSync : fs.readFileSync;
    this._trace = trace;
  }

  getAuthToken() {
    if (typeof this._authToken === 'string' && this._authToken.length > 0) {
      return this._authToken;
    }

    try {
      const fileDescriptorToken = readAuthTokenFromFileDescriptor(this._authFileDescriptor, this._readTextFileSync);
      if (fileDescriptorToken) {
        this._authToken = fileDescriptorToken;
        return fileDescriptorToken;
      }
    } catch (error) {
      this._trace('WARNING: Failed to read sessions auth token from file descriptor: ' + error.message);
    }

    return null;
  }

  isConfigured() {
    return (
      typeof this._baseUrl === 'string' &&
      this._baseUrl.length > 0 &&
      typeof this.getAuthToken() === 'string' &&
      this.getAuthToken().length > 0
    );
  }

  updateAuthToken(authToken) {
    if (typeof authToken === 'string' && authToken.trim()) {
      this._authToken = authToken.trim();
    } else {
      this._trace('WARNING: updateAuthToken called with invalid value (type=' + typeof authToken + ')');
    }
  }

  requestJson(method, pathname, payload, options) {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Sessions API is not configured',
        skipped: true,
      };
    }

    const requestOptions = options && typeof options === 'object' ? options : {};
    const organizationUuid = typeof requestOptions.organizationUuid === 'string' && requestOptions.organizationUuid.trim()
      ? requestOptions.organizationUuid.trim()
      : this._organizationUuid;
    const request = {
      method,
      url: this._baseUrl + pathname,
      headers: buildAuthHeaders(this.getAuthToken(), organizationUuid),
      body: payload === undefined ? null : JSON.stringify(payload),
    };

    let response;
    try {
      response = this._requestSync(request);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    const statusCode = response && Number.isFinite(response.statusCode)
      ? response.statusCode
      : 0;
    let parsedBody = null;
    try {
      parsedBody = parseJsonResponseBody(response ? response.body : '');
    } catch (error) {
      return {
        success: false,
        error: 'Failed to parse sessions API response: ' + error.message,
        statusCode,
      };
    }

    if (statusCode < 200 || statusCode >= 300) {
      return {
        success: false,
        error: 'Sessions API request failed with HTTP ' + statusCode,
        response: parsedBody,
        statusCode,
        notFound: statusCode === 404,
      };
    }

    return {
      success: true,
      response: parsedBody,
      statusCode,
    };
  }

  getSession(remoteSessionId, options) {
    if (typeof remoteSessionId !== 'string' || !remoteSessionId.trim()) {
      return {
        success: false,
        error: 'Missing remoteSessionId',
      };
    }

    const result = this.requestJson('GET', '/v1/sessions/' + encodeURIComponent(remoteSessionId), undefined, options);
    if (!result.success) {
      return result;
    }

    const normalized = normalizeRemoteSessionRecord(result.response);
    if (!normalized || !normalized.remoteSessionId) {
      return {
        success: false,
        error: 'Sessions API returned an invalid session record',
      };
    }

    return {
      success: true,
      remoteSessionId: normalized.remoteSessionId,
      sessionAccessToken: normalized.sessionAccessToken || this.getAuthToken(),
      session: normalized.raw,
    };
  }

  listSessions(options) {
    const result = this.requestJson('GET', '/v1/sessions', undefined, options);
    if (!result.success) {
      return result;
    }

    const sessions = normalizeSessionListResponse(result.response)
      .map((item) => normalizeRemoteSessionRecord(item))
      .filter(Boolean);

    return {
      success: true,
      sessions,
    };
  }

  createSession(payload, options) {
    const result = this.requestJson('POST', '/v1/sessions', payload || {}, options);
    if (!result.success) {
      return result;
    }

    const normalized = normalizeRemoteSessionRecord(result.response);
    if (!normalized || !normalized.remoteSessionId) {
      return {
        success: false,
        error: 'Sessions API returned an invalid created session',
      };
    }

    return {
      success: true,
      remoteSessionId: normalized.remoteSessionId,
      sessionAccessToken: normalized.sessionAccessToken || this.getAuthToken(),
      session: normalized.raw,
    };
  }

  postEvents(remoteSessionId, events, options) {
    if (typeof remoteSessionId !== 'string' || !remoteSessionId.trim()) {
      return {
        success: false,
        error: 'Missing remoteSessionId',
      };
    }

    return this.requestJson('POST',
      '/v1/sessions/' + encodeURIComponent(remoteSessionId) + '/events',
      { events: Array.isArray(events) ? events : [] }, options);
  }

  ensureSession(context) {
    const {
      cwd = null,
      localSessionId = null,
      model = null,
      organizationUuid = null,
      permissionMode = 'default',
      remoteSessionAccessToken = null,
      remoteSessionId = null,
      title = null,
      userSelectedFolders = [],
    } = context || {};

    const normalizedExisting = normalizeRemoteSessionRecord({
      remoteSessionAccessToken,
      remoteSessionId,
    });
    if (normalizedExisting && normalizedExisting.remoteSessionId && normalizedExisting.sessionAccessToken) {
      return {
        success: true,
        remoteSessionId: normalizedExisting.remoteSessionId,
        sessionAccessToken: normalizedExisting.sessionAccessToken,
        source: 'metadata',
      };
    }

    if (normalizedExisting && normalizedExisting.remoteSessionId) {
      const fetched = this.getSession(normalizedExisting.remoteSessionId, { organizationUuid });
      if (fetched.success && fetched.remoteSessionId) {
        return {
          success: true,
          remoteSessionId: fetched.remoteSessionId,
          sessionAccessToken: fetched.sessionAccessToken || normalizedExisting.sessionAccessToken || this.getAuthToken(),
          session: fetched.session,
          source: 'remote_lookup',
        };
      }
      if (fetched.success === false && !fetched.notFound) {
        this._trace('WARNING: Failed to refresh remote session ' + normalizedExisting.remoteSessionId + ': ' + fetched.error);
      }
    }

    const normalizedCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
    const normalizedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    const normalizedTitle = typeof title === 'string' && title.trim()
      ? title.trim()
      : (
        normalizedCwd
          ? pathBasename(normalizedCwd)
          : (typeof localSessionId === 'string' && localSessionId.trim() ? localSessionId.trim() : 'CoWork Session')
      );
    const created = this.createSession({
      title: normalizedTitle,
      events: [],
      permission_mode: typeof permissionMode === 'string' && permissionMode.trim() ? permissionMode.trim() : 'default',
      session_context: {
        model: normalizedModel,
        outcomes: [],
        sources: [],
      },
      source: 'remote-control',
      workspace_roots: Array.isArray(userSelectedFolders)
        ? userSelectedFolders.filter((entry) => typeof entry === 'string' && entry.trim())
        : [],
    }, { organizationUuid });
    if (!created.success) {
      return created;
    }

    return {
      success: true,
      remoteSessionId: created.remoteSessionId,
      sessionAccessToken: created.sessionAccessToken || this.getAuthToken(),
      session: created.session,
      source: 'created',
    };
  }
}

function pathBasename(targetPath) {
  const normalizedPath = typeof targetPath === 'string' && targetPath.trim() ? targetPath.trim() : '';
  if (!normalizedPath) {
    return 'CoWork Session';
  }
  const lastSegment = normalizedPath.split('/').filter(Boolean).pop();
  return lastSegment || normalizedPath;
}

function createSessionsApi(options) {
  return new SessionsApi(options);
}

module.exports = {
  ANTHROPIC_BETA,
  ANTHROPIC_VERSION,
  CURL_CONNECT_TIMEOUT_SECONDS,
  CURL_MAX_TIME_SECONDS,
  DEFAULT_BASE_URL,
  SessionsApi,
  buildAuthHeaders,
  buildCurlRequestArgs,
  createSessionsApi,
  defaultRequestSync,
  normalizeRemoteSessionRecord,
  normalizeBaseUrl,
  readAuthTokenFromFileDescriptor,
};
