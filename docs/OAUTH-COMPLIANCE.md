# OAuth Compliance & Token Handling — Addendum

> **Applicable to**: Claude Cowork for Linux (unofficial compatibility layer), v5.3.0
> **Last updated**: 2026-10-10
> **Goal**: Full OAuth handling stays in unmodified Anthropic applications (Claude Desktop + Claude Code)

---

## Executive Summary

This project is a Linux compatibility layer for Claude Desktop's Cowork feature. It stubs macOS-native modules so Claude Desktop's Electron app can run on Linux. **This layer does not implement an OAuth flow, does not parse OAuth callbacks, and does not write any token to a file of its own.** One log line records the `claude://` callback URL as received (§5).

What it does do with credentials, each covered in detail below:

- It passes `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Desktop supplies in the env vars of each Cowork spawn, through to the Claude Code CLI (§2).
- It registers the `claude://` URL scheme with the desktop and forwards callback URLs, unparsed, to Claude Desktop's own handler (§5).
- It keeps a copy of `CLAUDE_CODE_OAUTH_TOKEN` in memory inside a Sessions API client. No code path in the current tree sends a request with it (§3).

| Component | Handles Auth? | Source |
|-----------|--------------|--------|
| Claude Desktop (Electron app) | **Yes** — runs the OAuth flow with Anthropic's servers and handles the `claude://` callback | Anthropic code, patched only as listed in [What IS Modified](#what-is-modified-vs-unmodified) |
| Claude Code CLI | **Yes** — authenticates with the `CLAUDE_CODE_OAUTH_TOKEN` it receives at spawn | Unmodified Anthropic binary |
| This compatibility layer (stubs, launchers) | **No** — satisfies IPC contracts, filters spawn env, forwards the callback URL | This repository |

---

## February 2026 Anthropic Policy Update

On **February 19, 2026**, Anthropic clarified their "Authentication and credential use" policy:

> *"OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for
> Claude Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max
> accounts in any other product, tool, or service — including the Agent SDK — is not
> permitted and constitutes a violation of the Consumer Terms of Service."*

### How This Project Relates to That Policy

This compatibility layer does **not** obtain OAuth tokens of its own, and does not use them
to call Anthropic's API. Its role is to bridge two Anthropic applications — Claude Desktop
and Claude Code CLI — so they work together on Linux.

The OAuth token that reaches Claude Code CLI is:
- **Supplied by** Claude Desktop, in the `envVars` argument of its `vm.spawn()` call
- **Named** `CLAUDE_CODE_OAUTH_TOKEN`, the variable the Claude Code CLI reads for authentication
- **Consumed by** the official Claude Code CLI binary
- **Not sent by** this compatibility layer to any server (see §3 for the one client that could, and why it does not)

The policy targets tools that independently exploit OAuth tokens to access the API outside
of Claude Code or Claude.ai. This project enables the official Claude Desktop app to spawn
the official Claude Code CLI on Linux. On macOS the same CLI runs inside a VM; here it runs
directly on the host.

**Caveat**: Anthropic's Linux support posture is not formally documented. Users relying on
this compatibility layer should monitor Anthropic's policies and accept that this falls
outside Anthropic's officially supported configurations.

---

## Detailed Code Audit

### 1. `addApprovedOauthToken` — Token Deliberately Discarded

**File**: `stubs/@ant/claude-swift/js/index.js` (method on the `vm` object)

**What the official macOS version does** (per the stub's reverse-engineering notes): stores the OAuth token inside the sandboxed VM so Claude Code can use the consumer plan's credentials.

**What our stub does**: Accepts the IPC call (required by the contract), immediately returns `{ success: true }`, and **never reads, stores, or forwards the token**.

```javascript
addApprovedOauthToken: async (_token) => {
  trace('vm.addApprovedOauthToken() called — token intentionally discarded (OAuth compliance)');
  return { success: true };
},
```

**How this meets expectations**:
- The `_token` parameter is never read; it is not assigned, written to disk, or passed to any function
- The trace line records that the call happened, not the token value
- The CLI's credential arrives by a separate route: `CLAUDE_CODE_OAUTH_TOKEN` in the spawn env vars (§2)

---

### 2. `filterEnv` — Allowlist for the CLI's Environment

**File**: `stubs/cowork/env_filter.js` (`ENV_ALLOWLIST`, `ADDITIONAL_ENV_ALLOWLIST`, `ADDITIONAL_ENV_PREFIX_ALLOWLIST`, `filterEnv`)

**Call path**: `vm.spawn()` in `stubs/@ant/claude-swift/js/index.js` →
`SessionOrchestrator.buildSpawnOptions()` (`stubs/cowork/session_orchestrator.js`) →
`ProcessManager.buildSpawnOptions()` → `EnvironmentBuilder.build()` (`stubs/cowork/process_manager.js`) →
`filterEnv(process.env, <translated envVars>)`. The swift stub's `filterEnv` is a thin wrapper
that passes its `trace` function in.

**Risk**: Claude Desktop passes `envVars` when spawning the CLI, and the Electron process has
its own environment. Forwarding either wholesale would hand the CLI whatever they contain.

**Implementation**: two allowlists, one per source. Nothing is forwarded unless it is listed.

```javascript
// Keys copied from the Electron process's own environment (process.env)
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'NODE_ENV', 'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

// Keys accepted from Claude Desktop's spawn envVars
const ADDITIONAL_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS', 'VERTEX_PROJECT', 'VERTEX_REGION',
]);

// ...plus any envVars key with one of these prefixes
const ADDITIONAL_ENV_PREFIX_ALLOWLIST = ['CLAUDE_', 'ANTHROPIC_'];
```

**What this means in practice**:
- `CLAUDE_CODE_OAUTH_TOKEN` **is forwarded** to the Claude Code CLI subprocess when Claude
  Desktop supplies it in `envVars`. This is intentional and required: it is how Claude
  Desktop authenticates the CLI. It is **not** copied from the Electron process's own
  environment, because it is not in `ENV_ALLOWLIST`.
- `ANTHROPIC_API_KEY` is forwarded from either source. The Bedrock, Vertex, AWS and Google
  credential keys in `ADDITIONAL_ENV_ALLOWLIST` are forwarded when Claude Desktop supplies them.
- Any `envVars` key that is neither listed nor `CLAUDE_`/`ANTHROPIC_`-prefixed is dropped,
  and the drop is traced as `filtered additionalEnv key: <KEY>` (the key name only).
- `options.env` passed to `spawn()` is ignored, with a trace warning, so it cannot
  override the filtered environment.

**What this does NOT do** (changed from earlier versions of this document): there is no
longer a credential-name blocklist. The `BLOCKED_ENV_KEY_PATTERN` regex and
`CREDENTIAL_EXEMPT_KEYS` set described previously no longer exist anywhere in the tree.
Because of the `ANTHROPIC_` prefix rule, an `ANTHROPIC_AUTH_TOKEN` supplied by Claude Desktop
in `envVars` **would be forwarded**; the same applies to any other `CLAUDE_*` or
`ANTHROPIC_*` key. `ANTHROPIC_AUTH_TOKEN` in the Electron process's own environment is not
forwarded. [docs/FAQ.md](FAQ.md#login-and-auth) ("OAuth 401 errors") says
`ANTHROPIC_AUTH_TOKEN` must not be injected because it bypasses OAuth handling and causes
401 errors; this layer never sets it, but `filterEnv` does not stop Claude Desktop from
passing it.

**Scope**: `filterEnv` applies to processes started through the VM stub's `spawn()` (Cowork
sessions). Commands that Claude Desktop launches through its macOS `disclaimer` wrapper are
intercepted in `stubs/frame-fix/frame-fix-wrapper.js` only to rewrite the command path
(`resolveDisclaimerCommand` in `stubs/cowork/exec_capability_registry.js`); they keep the
environment Claude Desktop gave them.

---

### 3. Sessions API Client — Holds the Token, Sends Nothing Today

**File**: `stubs/cowork/sessions_api.js` (constructed in `stubs/@ant/claude-swift/js/index.js`)

The VM stub creates a `SessionsApi` client with an auth token taken from
`CLAUDE_COWORK_SESSIONS_API_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in the Electron
process's environment, or read from the file descriptor named by
`CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` (FDs 3 to 9 only). On every Cowork spawn,
`SessionOrchestrator` copies the spawn's `CLAUDE_CODE_OAUTH_TOKEN` into this client with
`updateAuthToken()` and traces `Injected spawn-time OAuth token into sessions API` (no value).

The client can issue `GET`/`POST` requests to `/v1/sessions` endpoints on
`https://api.anthropic.com` (or `CLAUDE_COWORK_SESSIONS_API_BASE_URL`) by running `curl`,
with the token in an `Authorization: Bearer` header (or a `sessionKey` cookie for
`sk-ant-sid*` values) and `anthropic-beta: oauth-2025-04-20,ccr-byoc-2025-07-29`.

**Current state**: none of its request methods has a caller in shipped code.
`getSession`, `listSessions`, `createSession` and `ensureSession` are not called anywhere
outside `sessions_api.js`. `postEvents` is called only by
`SessionOrchestrator.dualWriteEvent()`, which is called only from tests. So the token is held
in memory and never sent by this layer.

**If it is ever wired up**: that would be this layer calling Anthropic's API with the user's
OAuth token, which the policy above does not permit; and because `curl` receives the header
as a command-line argument, the token would be visible in the process list for the duration
of each request.

---

### 4. `AuthRequest` — Browser-Only, No Callback Handling

**File**: `stubs/@ant/claude-native/index.js` (class `AuthRequest`, exported)

**What it does**:
- `start(url)` → checks the URL's origin against `ALLOWED_AUTH_ORIGINS`, then opens it in the system browser with `execFile('xdg-open', [url])`
- About 100 ms later it emits an `error` event (`Authentication via system browser - callback handled by renderer`), telling Claude Desktop that no native auth session will complete
- `isAvailable()` → returns `false`
- `cancel()` → emits `cancelled`

**What it does NOT do**:
- Capture the callback URL or token
- Register any HTTP listener, deep-link handler or protocol handler
- Communicate with any server
- Store any authentication state

`isAvailable() → false` tells Claude Desktop that no native auth window exists, so it handles the OAuth flow, including the callback, through its own logic.

Origin validation inside `start()`:

```javascript
const ALLOWED_AUTH_ORIGINS = [
  'https://claude.ai', 'https://auth.anthropic.com',
  'https://accounts.anthropic.com', 'https://console.anthropic.com',
];
```

A malformed URL emits `Malformed auth URL`; any other origin is logged as
`Blocked non-Anthropic auth URL` and emits an error without opening anything.

**How this meets expectations**:
- Our code is functionally equivalent to the user clicking a link in their browser
- Only these four Anthropic origins can be opened through this handler
- Uses `execFile` (not `exec`), so the URL is never interpreted by a shell
- This stub is purely a browser-opener; it never sees the callback

---

### 5. `claude://` Callback Forwarding

`AuthRequest` registers nothing, but the installers do, so that the browser's OAuth redirect
reaches the app:

| Where | What it registers |
|-------|-------------------|
| `install.sh` | `~/.local/share/applications/claude.desktop` with `MimeType=x-scheme-handler/claude;` and `Exec=$HOME/.local/bin/claude-desktop %U`, then `xdg-mime default claude.desktop x-scheme-handler/claude` |
| `launch.sh` | If no handler is set, makes the first `claude*.desktop` that declares the scheme the default |
| `PKGBUILD` | `claude-cowork.desktop` with the same `MimeType`; the `claude-cowork` launcher sets it as default if none is set |
| `nix/package.nix` | `mimeTypes = [ "x-scheme-handler/claude" ]` on the desktop item |
| `install.sh --wsl-xdg-open` (WSL2, opt-in) | `~/.local/bin/xdg-open` wrapper that sends `claude://` URLs to `claude-desktop` and `http(s)` URLs to a Linux browser |

`frame-fix-wrapper.js` also turns Electron's `app.setAsDefaultProtocolClient()` and
`removeAsDefaultProtocolClient()` into no-ops on Linux, so the app cannot overwrite the
registration above.

**Callback path**: the generated `claude-desktop` launcher matches `claude://*` and runs
`protocol-forwarder.js` under Electron (falling back to `launch.sh` if it cannot find the
forwarder or Electron). The forwarder rejects the URL unless it parses with the `claude:`
scheme, is at most 2048 characters, and uses only URI characters. It then takes the
single-instance lock: if Claude Desktop is already running, the running app receives a
`second-instance` event; if not, the forwarder launches `launch.sh` with the URL. The
`second-instance` handler in `frame-fix-wrapper.js` repeats the shape check and re-emits the
URL unchanged as Electron's `open-url` event, which Claude Desktop's own handler processes.
The AUR `claude-cowork` launcher passes the URL straight to Electron; when Claude Desktop is
already running, that also ends in the same `second-instance` handler.

This layer does not extract a code or token from the URL, or keep it. It logs the URL only
in redacted form: `protocol-forwarder.js` (its `started, argv: ...` and `launching: ...` lines)
and the `second-instance` handler (`forwarding URL via open-url: ...`) pass it through
`redactUrl` from `credential_classifier.js`, which keeps the scheme, host, path and parameter
names and replaces every query and fragment value, e.g.
`claude://claude.ai/login/callback?code=[REDACTED]&state=[REDACTED]`. If the forwarder cannot
load the classifier, it logs `[claude:// URL withheld]` instead. In v5.3.0 and earlier both lines wrote
the full callback URL, authorization code included, to `startup.log`.
`tests/node/current-path/protocol_forwarder_logging.test.cjs` runs the real forwarder and checks
that neither the code nor the state reaches the log.

---

### 6. Credential Classifier — Shared Redaction Layer

**File**: `stubs/cowork/credential_classifier.js`

Provides the pattern-based credential detection that the log paths use:
- `isLikelyCredentialValue`: a known token prefix (`sk-ant-sid`, `sk-ant-`, `clt-`, `eyJ`, `ghp_`, `ghs_`, `gho_`, `xoxb-`, `xoxp-`, `AKIA`, `sk-proj-`) on a value of 16+ characters, or Shannon entropy of at least 3.5 on a value of 20+ characters
- `isLikelyCredentialKey`: a key name matching `token|secret|key|credential|auth|password|cookie` (case-insensitive), except `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`, `NODE_ENV`
- `classifyEnvEntry`: `credential`, `suspect` (credential-like key with a value longer than 8 characters) or `safe`
- `redactCredentials`: the five replacement passes described in §7
- `redactHomeDir`: replaces the home directory prefix with `~` in log text
- `redactUrl`: display form of a URL with every query and fragment value replaced (§5)

Consumers: `redactForLogs` in the VM stub; `trace()` in `stubs/@ant/claude-native/index.js`;
the IPC tap (`stubs/cowork/ipc_tap.js`); `classifyEnvEntry` for the env-path translation trace
lines in `stubs/cowork/process_manager.js`; `redactHomeDir` in `frame-fix-wrapper.js` and
`session_store.js`; `redactUrl` in `frame-fix-wrapper.js` and `protocol-forwarder.js`. `filterEnv` does **not** use it: forwarding decisions are made by the
allowlists in §2, not by classification.

---

### 7. `redactForLogs` — Defense-in-Depth Log Sanitization

**File**: `stubs/@ant/claude-swift/js/index.js` (`redactForLogs`, a wrapper over `redactCredentials`)

Every line passed to the VM stub's `trace()` goes through `redactForLogs` before it is printed
or appended to `claude-swift-trace.log`. That includes CLI stdin/stdout when
`CLAUDE_COWORK_TRACE_IO=1`. The passes, in order:

| Pattern | Example | Result |
|---------|---------|--------|
| `KEY=value` (upper-case key), value classified non-safe | `ANTHROPIC_API_KEY=sk-ant-...`, `CLAUDE_CODE_OAUTH_TOKEN=...` | `KEY=[REDACTED]` |
| `"key": "value"`, value classified non-safe | `"access_token": "..."`, `"refresh_token": "..."`, `"api_key": "..."` | `"key": "[REDACTED]"` |
| `Authorization: Bearer <token>` / `Authorization: Basic <token>` | HTTP headers | `Authorization: Bearer [REDACTED]` |
| `Cookie: <value>` (any case) | Session cookies | `Cookie: [REDACTED]` |
| Bare run of 32+ `[A-Za-z0-9_-]` characters that looks like a credential | Tokens in free text | `[REDACTED]` |
| `?`/`&`/`#` followed by a credential-named parameter (`code`, `state`, `token`, `access_token`, `refresh_token`, `id_token`, `code_verifier`, `client_secret`, `session`, `key`, `secret`, `password`, `signature`, …) | `claude://…/callback?code=AbCd&state=xyz` | `?code=[REDACTED]&state=[REDACTED]` |

**How this meets expectations**:
- A subprocess that prints a token in one of these shapes has it stripped before the trace line is written
- `claude-swift-trace.log` is created with mode `0o600`, in a log directory created `0o700` (`launch.sh` also runs `chmod 700` on it)

**Limits**:
- The redaction covers `trace()` in the VM stub, `trace()` in the native stub (written only when `CLAUDE_NATIVE_TRACE` is set) and the IPC tap. Plain `console.log` output from the stubs and Electron, which the launchers append to `startup.log`, is not redacted in general; the `claude://` callback URL is the exception, logged through `redactUrl` (§5).
- `startup.log` is created by shell redirection, so its file mode follows your umask; it is protected by the `0700` directory.
- Detection is heuristic. A value that is short, low-entropy and not in a recognised shape can pass through.

---

### 8. Other Ways This Layer Touches Authenticated Traffic

These do not handle credentials directly, but an audit should know about them:

- **Platform identity.** `frame-fix-wrapper.js` makes `process.platform` / `os.platform()` report `darwin` and `process.arch` / `os.arch()` report `arm64` to Claude Desktop's code, and sets `app.userAgentFallback` to a macOS (`Macintosh; Intel Mac OS X 10_15_7`) user agent. Requests Claude Desktop makes, including the sign-in flow, identify as macOS.
- **Bridge event forwarding.** `frame-fix-wrapper.js` patches the `forwardEvent` method of Claude Desktop's sessions-bridge object so `result` and `stream_event` messages, which the original drops, are written to that bridge's existing transport. On macOS, according to the comment on the patch, a proxy in the VM forwards them. The request is made by Claude Desktop's transport with Claude Desktop's credentials; this layer never sees them.
- **Asset dumper (`--devtools` only).** With `CLAUDE_DEVTOOLS=1`, `frame-fix-wrapper.js` re-fetches each `.js`, `.css`, `.json` and `.html` response from `claude.ai` and `*.anthropic.com` through the window's session and saves it under `webapp-assets/` in the log directory.

---

## Summary: OAuth Token Handling

| Action | Status | Enforcement |
|--------|--------|-------------|
| Write OAuth tokens to disk | **Never** | `addApprovedOauthToken` discards its argument; no stub writes a token to a file |
| Hold `CLAUDE_CODE_OAUTH_TOKEN` in memory | **Yes** | Sessions API client (§3), refreshed on each spawn |
| Forward `CLAUDE_CODE_OAUTH_TOKEN` to Claude Code CLI | **Yes — intentional** | `ADDITIONAL_ENV_ALLOWLIST`; only from Claude Desktop's spawn `envVars`, never from the Electron process environment |
| Forward other `envVars` keys | **Only if allowlisted** | `filterEnv`: exact list plus `CLAUDE_`/`ANTHROPIC_` prefixes; this admits `ANTHROPIC_AUTH_TOKEN` if Claude Desktop supplies it |
| Forward Electron's own environment | **Only `ENV_ALLOWLIST` keys** | Includes `ANTHROPIC_API_KEY`; excludes `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN` |
| Register the `claude://` scheme | **Yes** | Installers and launchers (§5) |
| Parse or extract data from OAuth callbacks | **Never** | The URL is shape-checked and re-emitted unchanged as `open-url`; `AuthRequest.isAvailable()` returns `false` |
| Log token values | **Not in redacted trace logs** | `redactForLogs` on `trace()` lines; the `claude://` callback URL is logged only through `redactUrl` (§5, §7) |
| Open non-Anthropic auth URLs | **Never** | `ALLOWED_AUTH_ORIGINS` checked in `AuthRequest.start()` |
| Use OAuth tokens to call Anthropic's API | **No call path today** | The Sessions API client can, but none of its request methods has a non-test caller (§3) |

---

## What IS Modified vs. Unmodified

| Component | Modified? | Purpose |
|-----------|-----------|---------|
| `stubs/@ant/claude-swift/js/index.js` | **Our code** | VM emulation for Linux (process spawn, path translation) |
| `stubs/@ant/claude-native/index.js`, `safe_fs.js` | **Our code** | Platform shims (notifications, keyboard, `AuthRequest`, safe-fs) |
| `stubs/cowork/*.js` (29 modules) and `cowork-plugin-shim.sh` | **Our code** | Session orchestration, IPC overrides, env filtering, credential classification, exec allowlisting |
| `stubs/frame-fix/*.js` | **Our code** | Electron entry wrapper: platform spoofing, window fixes, spawn interception, `claude://` forwarding |
| Main-process bundle (`linux-app-extracted/.vite/build/index.js` and its `index*.chunk-*.js` files) | **Anthropic's code, patched** | `patch-index.sh`: 11 sed passes (macOS titlebar options ×2, file:// preload origin check, `--effort xhigh`→`max`, Handoff API ×2, resourcesPath lookups, MCP node-host paths, unguarded `app.asar` joins, Claude-in-Chrome bridge transport ×2). `enable-cowork.py` (run by `install.sh` and `PKGBUILD`): Cowork platform gate → supported, `getHostPlatform()` throw → `darwin-x64`, file:// exemption added at each IPC origin-validation guard (other origins still validated), return-style "Unsupported platform" gates → supported, the automount-root check forced to its non-darwin regex so `/home` is not treated as an automount root |
| `linux-app-extracted/.vite/build/mainView.js` (preload) | **Anthropic's code, patched** | One pass in `patch-index.sh`: accept `file:` protocol in the preload's origin check |
| Web app loaded in the window | **Not modified** | `frame-fix-wrapper.js` injects CSS (window drag regions), a script that relabels "Claude for Mac" text, and SPA navigation scripts for space links; none touch auth |
| Claude Code binary | **Unmodified** | Handles its own authentication |

---

## Verification

To verify these claims, audit the following specific locations:

```bash
# 1. addApprovedOauthToken is a no-op (_token never used)
grep -n -A3 'addApprovedOauthToken: async' stubs/@ant/claude-swift/js/index.js

# 2. The env allowlists, and that spawn() routes through them
cat stubs/cowork/env_filter.js
grep -n 'filterEnv' stubs/cowork/process_manager.js stubs/@ant/claude-swift/js/index.js

# 3. Sessions API client: where the token goes in, and who calls the request methods
grep -n 'updateAuthToken\|authToken:' stubs/cowork/session_orchestrator.js stubs/@ant/claude-swift/js/index.js
grep -rn 'postEvents\|createSession(\|getSession(\|listSessions\|ensureSession\|dualWriteEvent' stubs/

# 4. AuthRequest is browser-only: isAvailable -> false, ALLOWED_AUTH_ORIGINS enforced
grep -n 'isAvailable\|ALLOWED_AUTH_ORIGINS\|execFile' stubs/@ant/claude-native/index.js

# 5. claude:// registration and forwarding
grep -n 'x-scheme-handler/claude' install.sh launch.sh PKGBUILD nix/package.nix
grep -n 'open-url\|setAsDefaultProtocolClient' stubs/frame-fix/frame-fix-wrapper.js

# 6. Log redaction and its consumers
grep -rn 'redactCredentials\|redactForLogs\|classifyEnvEntry' stubs/
```
