const { execFileSync } = require('child_process');
const fs = require('fs');

// ============================================================================
// API CONSTANTS
// ============================================================================
// Anthropic API configuration for Claude Code sessions

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20,ccr-byoc-2025-07-29';
const CURL_CONNECT_TIMEOUT_SECONDS = 2;
const CURL_MAX_TIME_SECONDS = 5;

// ============================================================================
// HTTP/RESPONSE NORMALIZATION HELPERS
// ============================================================================
// These functions normalize API responses to a consistent format, handling
// variations in response structure across different API versions.

function normalizeBaseUrl(baseUrl) {
  // Strip trailing slashes from base URL for consistent path joining
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return null;
  }
  return baseUrl.replace(/\/+$/g, '');
}

function normalizeRemoteSessionRecord(value) {
  // Extract session ID and access token from various API response formats.
  // Handles nested structures (e.g., {data: {id: ...}}) and different
  // field name variations (session_id vs sessionId vs id, etc.).
  const candidateValues = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    candidateValues.push(value);
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
      candidateValues.unshift(value.data);
    }
  }

  for (const candidateValue of candidateValues) {
    // Try multiple field names for session ID
    const remoteSessionId = [
      candidateValue.remoteSessionId,
      candidateValue.sessionId,
      candidateValue.session_id,
      candidateValue.id,
    ].find((candidate) => typeof candidate === 'string' && candidate.trim()) || null;
    
    // Try multiple field names for access token
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
  // Parse JSON response body with empty string handling
  if (typeof responseBody !== 'string' || !responseBody.trim()) {
    return null;
  }
  return JSON.parse(responseBody);
}

function buildCurlRequestArgs(request) {
  // Build curl command-line arguments for HTTP request.
  // Sets timeouts, HTTP method, headers, and request body.
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

  // Add custom headers
  for (const [headerName, headerValue] of Object.entries(request.headers || {})) {
    if (typeof headerValue !== 'string' || !headerValue.length) {
      continue;
    }
    args.push('-H', headerName + ': ' + headerValue);
  }

  // Add request body if present
  if (request.body !== null && request.body !== undefined) {
    args.push('-H', 'Content-Type: application/json');
    args.push('--data-binary', request.body);
  }

  // Add status code to output for parsing
  args.push('-w', '\n%{http_code}');
  args.push(request.url);
  return args;
}

function defaultRequestSync(request) {
  // Execute HTTP request using curl and parse response.
  // Curl output format: <body>\n<status_code>
  const stdout = execFileSync('curl', buildCurlRequestArgs(request), {
    encoding: 'utf8',
    timeout: (CURL_MAX_TIME_SECONDS + 2) * 1000,
  });
  
  // Split response body and status code
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

// ============================================================================
// AUTH-TOKEN/HEADER SAFETY HELPERS
// ============================================================================
// These functions handle authentication tokens with security in mind:
//   - Read tokens from file descriptors (safer than env vars)
//   - Validate tokens for CRLF injection attempts
//   - Build proper auth headers (Cookie vs Bearer) based on token type

function readAuthTokenFromFileDescriptor(authFileDescriptor, readTextFileSync) {
  // Securely read auth token from file descriptor (FD 3-9).
  // File descriptors are safer than environment variables because they:
  //   1. Don't appear in process listings
  //   2. Can't be inherited by child processes accidentally
  //   3. Are cleaned up automatically on process exit
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
  // Build authentication headers with CRLF injection protection.
  // Returns empty object if token is invalid or contains control characters.
  //
  // Token types:
  //   - sk-ant-sid* -> sessionKey cookie (legacy session tokens)
  //   - sk-ant-* -> Bearer token (API keys)
  if (typeof authToken !== 'string' || !authToken.trim()) {
    console.warn('[sessions-api] buildAuthHeaders: token missing or empty (type=' + typeof authToken + ')');
    return {};
  }

  const normalizedToken = authToken.trim();

  // Security: Reject tokens with CRLF characters to prevent header injection
  if (/[\r\n\0]/.test(normalizedToken)) {
    console.warn('[sessions-api] buildAuthHeaders: token contains control characters, rejecting');
    return {};
  }

  // Choose auth method based on token prefix
  const headers = normalizedToken.startsWith('sk-ant-sid')
    ? { Cookie: 'sessionKey=' + normalizedToken }
    : { Authorization: 'Bearer ' + normalizedToken };

  // Add required Anthropic API headers
  headers['anthropic-version'] = ANTHROPIC_VERSION;
  headers['anthropic-beta'] = ANTHROPIC_BETA;
  if (typeof organizationUuid === 'string' && organizationUuid.trim()) {
    headers['x-organization-uuid'] = organizationUuid.trim();
  }
  return headers;
}

function hasUsableAuthHeaders(headers) {
  return !!(
    headers &&
    typeof headers === 'object' &&
    (
      (typeof headers.Authorization === 'string' && headers.Authorization.trim()) ||
      (typeof headers.Cookie === 'string' && headers.Cookie.trim())
    )
  );
}

function normalizeSessionListResponse(responseBody) {
  // Extract session array from various API response formats.
  // Handles both direct arrays and nested structures ({data: [...]} or {sessions: [...]})
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

// ============================================================================
// SESSIONS API CLIENT
// ============================================================================
// SessionsApi provides a boundary between the orchestrator and the remote
// Claude Code sessions API. It handles:
//   - Authentication (token management, file descriptors)
//   - HTTP requests (via curl wrapper)
//   - Session lifecycle (create, get, list, post events)
//   - Response normalization and error handling

class SessionsApi {
  constructor(options) {
    // Initialize Sessions API client with authentication and base URL.
    // Auth can be provided via token string or file descriptor for security.
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
    // Get authentication token from either:
    //   1. In-memory token (set via constructor or updateAuthToken)
    //   2. File descriptor (more secure, read on-demand)
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
    // Check if client has both base URL and auth token configured
    if (typeof this._baseUrl !== 'string' || this._baseUrl.length === 0) {
      return false;
    }
    return hasUsableAuthHeaders(buildAuthHeaders(this.getAuthToken(), this._organizationUuid));
  }

  updateAuthToken(authToken) {
    // Update authentication token at runtime (e.g., after refresh)
    if (typeof authToken === 'string' && authToken.trim()) {
      this._authToken = authToken.trim();
    } else {
      this._trace('WARNING: updateAuthToken called with invalid value (type=' + typeof authToken + ')');
    }
  }

  requestJson(method, pathname, payload, options) {
    // Execute authenticated JSON API request and parse response.
    // Returns normalized result with success flag, response body, and status code.
    if (typeof this._baseUrl !== 'string' || this._baseUrl.length === 0) {
      return {
        success: false,
        error: 'Sessions API is not configured',
        skipped: true,
      };
    }

    const authToken = this.getAuthToken();
    if (typeof authToken !== 'string' || authToken.length === 0) {
      return {
        success: false,
        error: 'Sessions API is not configured',
        skipped: true,
      };
    }

    // Build request with authentication headers
    const requestOptions = options && typeof options === 'object' ? options : {};
    const organizationUuid = typeof requestOptions.organizationUuid === 'string' && requestOptions.organizationUuid.trim()
      ? requestOptions.organizationUuid.trim()
      : this._organizationUuid;
    const requestHeaders = buildAuthHeaders(authToken, organizationUuid);
    if (!hasUsableAuthHeaders(requestHeaders)) {
      return {
        success: false,
        error: 'Sessions API auth token is invalid',
        skipped: true,
      };
    }
    const request = {
      method,
      url: this._baseUrl + pathname,
      headers: requestHeaders,
      body: payload === undefined ? null : JSON.stringify(payload),
    };

    // Execute request via curl
    let response;
    try {
      response = this._requestSync(request);
    } catch (error) {
      return {
        success: false,
        error: method + ' ' + pathname + ': ' + error.message,
      };
    }

    // Extract status code
    const statusCode = response && Number.isFinite(response.statusCode)
      ? response.statusCode
      : 0;
      
    // Parse JSON response body
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

    // Check HTTP status
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
    // Fetch session details from remote API by session ID
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
    // List all sessions accessible with current auth token
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
    // Create new remote session with specified configuration
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
    // Post events to existing remote session
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
    // Ensure a remote session exists, either by:
    //   1. Using existing session ID + token from metadata
    //   2. Fetching existing session from API
    //   3. Creating new session if none exists
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

    // Try to use existing session credentials from metadata
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

    // Try to fetch existing session from API
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

    // Create new session
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

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function pathBasename(targetPath) {
  // Extract basename from path for default session titles
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
  CURL_CONNECT_TIMEOUT_SECONDS,
  CURL_MAX_TIME_SECONDS,
  buildAuthHeaders,
  buildCurlRequestArgs,
  createSessionsApi,
  readAuthTokenFromFileDescriptor,
};
