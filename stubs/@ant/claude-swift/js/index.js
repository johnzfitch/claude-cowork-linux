/**
 * Linux stub for @ant/claude-swift
 *
 * This module replaces the native Swift addon that uses Apple's Virtualization
 * Framework on macOS. On Linux, we don't need a VM - we run the Claude Code
 * binary directly on the host system.
 *
 * Architecture:
 *   Claude Desktop (Electron) -> This Stub -> child_process.spawn() -> Claude Binary
 *
 * Key insight from reverse engineering:
 *   - The app imports this module and calls Si() which returns `module.default.vm`
 *   - Therefore, all VM methods must be on `this.vm`, not on the class itself
 *   - The app calls vm.setEventCallbacks() to register stdout/stderr/exit handlers
 *   - Then vm.spawn() to launch the Claude Code binary
 *
 * Path translations performed:
 *   - /usr/local/bin/claude -> ~/.config/Claude/claude-code-vm/2.1.5/claude
 *   - /sessions/... -> ~/.config/Claude/cowork-sessions/...
 *
 * Based on reverse engineering of swift_addon.node via pyghidra-lite
 */
console.log('[claude-swift-stub] LOADING MODULE - this confirms our stub is being used');
const EventEmitter = require("events");
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require("child_process");
const fs = require("fs");

// File-based trace log that can't be filtered
const TRACE_FILE = "/tmp/claude-swift-trace.log";
function trace(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log('[TRACE] ' + msg);
  try { fs.appendFileSync(TRACE_FILE, line); } catch(e) {}
}
trace("=== MODULE LOADING ===");
const path = require("path");
const os = require("os");

class SwiftAddonStub extends EventEmitter {
  constructor() {
    super();
    trace('Constructor START');
    console.log('[claude-swift-stub] Constructor called');
    this._eventListener = null;
    this._guestConnected = false;
    this._processes = new Map();
    this._processIdCounter = 0;

    // Event callbacks for VM processes
    this._onStdout = null;
    this._onStderr = null;
    this._onExit = null;
    this._onError = null;
    this._onNetworkStatus = null;

    // Events system - native.events.setListener()
    this.events = {
      setListener: (callback) => {
        this._eventListener = callback;
        console.log('[claude-swift] Event listener registered');
      }
    };

    // Quick Access / Quick Entry UI
    this.quickAccess = {
      show: () => {
        console.log('[claude-swift] quickAccess.show()');
        this._emit('quickAccessShown');
      },
      hide: () => {
        console.log('[claude-swift] quickAccess.hide()');
        this._emit('quickAccessHidden');
      },
      isVisible: () => false,
      submit: (data) => {
        console.log('[claude-swift] quickAccess.submit()', data);
      }
    };

    // Notifications
    this.notifications = {
      requestAuth: () => {
        console.log('[claude-swift] notifications.requestAuth()');
        return Promise.resolve(true);
      },
      getAuthStatus: () => {
        return 'authorized';
      },
      show: (options) => {
        console.log('[claude-swift] notifications.show()', options && options.title);
        const { execSync } = require('child_process');
        try {
          const title = (options && options.title) || 'Claude';
          const body = (options && options.body) || '';
          execSync('notify-send "' + title + '" "' + body + '" 2>/dev/null');
        } catch (e) {}
        return Promise.resolve({ id: Date.now().toString() });
      },
      close: (id) => {
        console.log('[claude-swift] notifications.close()', id);
      }
    };

    // Desktop integration
    this.desktop = {
      captureScreenshot: (args) => {
        console.log('[claude-swift] desktop.captureScreenshot()', args);
        return Promise.resolve(null);
      },
      captureWindowScreenshot: (windowId) => {
        console.log('[claude-swift] desktop.captureWindowScreenshot()', windowId);
        return Promise.resolve(null);
      },
      getSessionId: () => {
        return 'linux-session-' + Date.now();
      }
    };

    // API object (general purpose)
    this.api = {};

    // Midnight Owl (scheduling/time-based features)
    this.midnightOwl = {
      isEnabled: () => false,
      enable: () => {},
      disable: () => {},
    };

    // VM Management (nested object)
    // CRITICAL: The app accesses methods via module.default.vm, so all methods must be here
    // Create reference to parent for arrow functions
    const self = this;

    /**
     * VM object - This is the main interface the app uses
     * The app calls Si() which returns module.default.vm
     */
    this.vm = {
      isSupported: () => true,
      isGuestConnected: () => self._guestConnected,
      getRunningStatus: () => ({
        running: self._guestConnected,
        connected: self._guestConnected
      }),

      // THIS IS THE KEY METHOD - called via Si() which returns this.vm
      setEventCallbacks: (onStdout, onStderr, onExit, onError, onNetworkStatus) => {
        trace('vm.setEventCallbacks() CALLED');
        console.log('[claude-swift] vm.setEventCallbacks() called - REGISTERING CALLBACKS');
        self._onStdout = onStdout;
        self._onStderr = onStderr;
        self._onExit = onExit;
        self._onError = onError;
        self._onNetworkStatus = onNetworkStatus;
        if (self._onNetworkStatus) {
          self._onNetworkStatus('connected');
        }
      },

      startVM: async (bundlePath, memoryGB) => {
        trace('vm.startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
        console.log('[claude-swift] vm.startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
        self._guestConnected = true;
        self._emit('guestConnectionChanged', { connected: true });
        return { success: true };
      },

      installSdk: async (subpath, version) => {
        console.log('[claude-swift] vm.installSdk() subpath=' + subpath + ' version=' + version);
        return { success: true };
      },

      /**
       * Spawn a process - This is called to launch the Claude Code binary
       * @param {string} id - Unique process ID for tracking
       * @param {string} processName - Display name for the process
       * @param {string} command - Command to run (VM path, will be translated)
       * @param {string[]} args - Arguments (may contain VM paths)
       * @param {object} options - Spawn options
       * @param {object} envVars - Environment variables to set
       * @param {array} additionalMounts - Ignored (VM-specific)
       * @param {boolean} isResume - Whether this is resuming an existing session
       * @param {array} allowedDomains - Ignored (VM-specific)
       * @param {string} sharedCwdPath - Working directory
       */
      spawn: (id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) => {
        trace('vm.spawn() id=' + id + ' cmd=' + command + ' args=' + JSON.stringify(args));

        // Translate VM paths to host paths (the binary expects VM paths)
        let hostCommand = command;
        if (command === '/usr/local/bin/claude') {
          hostCommand = path.join(os.homedir(), '.config/Claude/claude-code-vm/2.1.5/claude');
          trace('Translated command: ' + command + ' -> ' + hostCommand);
        }

        // Translate VM paths in args (e.g., /sessions/... -> ~/.config/Claude/sessions/...)
        const sessionsDir = path.join(os.homedir(), '.config/Claude/cowork-sessions');
        let hostArgs = (args || []).map(arg => {
          if (typeof arg === 'string' && arg.startsWith('/sessions/')) {
            const translated = arg.replace('/sessions/', sessionsDir + '/');
            trace('Translated arg: ' + arg + ' -> ' + translated);
            return translated;
          }
          return arg;
        });

        // Ensure sessions directory exists
        try {
          if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
            trace('Created sessions dir: ' + sessionsDir);
          }
        } catch (e) {
          trace('Failed to create sessions dir: ' + e.message);
        }

        console.log('[claude-swift] vm.spawn() id=' + id + ' cmd=' + hostCommand);
        return self.spawn(id, processName, hostCommand, hostArgs, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath);
      },

      kill: (id, signal) => {
        console.log('[claude-swift] vm.kill(' + id + ', ' + signal + ')');
        return Promise.resolve(self.killProcess(id));
      },

      writeStdin: (id, data) => {
        console.log('[claude-swift] vm.writeStdin(' + id + ')');
        return Promise.resolve(self.writeToProcess(id, data));
      },

      start: () => {
        console.log('[claude-swift] vm.start()');
        self._guestConnected = true;
        self._emit('guestConnectionChanged', { connected: true });
        self._emit('guestReady');
        return Promise.resolve({ success: true });
      },

      stop: () => {
        console.log('[claude-swift] vm.stop()');
        self._guestConnected = false;
        self._emit('guestConnectionChanged', { connected: false });
        return Promise.resolve({ success: true });
      },

      sendCommand: (cmd) => {
        console.log('[claude-swift] vm.sendCommand()', cmd);
        return Promise.resolve({});
      }
    };

    trace('Constructor COMPLETE. vm.setEventCallbacks=' + typeof this.vm.setEventCallbacks);
    console.log('[claude-swift-stub] Constructor complete. vm.setEventCallbacks type:', typeof this.vm.setEventCallbacks);
  }

  // TOP-LEVEL METHODS
  setEventCallbacks(onStdout, onStderr, onExit, onError, onNetworkStatus) {
    console.log('[claude-swift] setEventCallbacks() called - REGISTERING CALLBACKS');
    this._onStdout = onStdout;
    this._onStderr = onStderr;
    this._onExit = onExit;
    this._onError = onError;
    this._onNetworkStatus = onNetworkStatus;
    if (this._onNetworkStatus) {
      this._onNetworkStatus('connected');
    }
  }

  // VM lifecycle methods - called directly on addon instance
  async startVM(bundlePath, memoryGB) {
    console.log('[claude-swift] startVM() bundlePath=' + bundlePath + ' memoryGB=' + memoryGB);
    this._guestConnected = true;
    this._emit('guestConnectionChanged', { connected: true });
    return { success: true };
  }

  async installSdk(subpath, version) {
    console.log('[claude-swift] installSdk() subpath=' + subpath + ' version=' + version);
    return { success: true };
  }

  // Method aliases for API compatibility
  kill(id, signal) {
    console.log('[claude-swift] kill(' + id + ', ' + signal + ')');
    return this.killProcess(id);
  }

  writeStdin(id, data) {
    return this.writeToProcess(id, data);
  }

  spawn(id, processName, command, args, options, envVars, additionalMounts, isResume, allowedDomains, sharedCwdPath) {
    console.log('[claude-swift] spawn() id=' + id + ' cmd=' + command + ' args=' + JSON.stringify(args));
    try {
      const env = Object.assign({}, process.env);
      if (envVars) Object.assign(env, envVars);
      const cwd = sharedCwdPath || (options && options.cwd) || process.cwd();
      const proc = nodeSpawn(command, args || [], Object.assign({ cwd: cwd, env: env, stdio: ['pipe', 'pipe', 'pipe'] }, options || {}));
      this._processes.set(id, proc);

      const self = this;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      if (proc.stdout) {
        proc.stdout.on('data', function(data) {
          stdoutBuffer += data.toString();
          // Split on newlines and send complete lines
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop(); // Keep incomplete line in buffer
          for (const line of lines) {
            if (line.trim() && self._onStdout) {
              trace('stdout line: ' + line.substring(0, 100) + '...');
              self._onStdout(id, line + '\n');
            }
          }
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', function(data) {
          stderrBuffer += data.toString();
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop();
          for (const line of lines) {
            if (line.trim() && self._onStderr) {
              trace('stderr line: ' + line.substring(0, 100) + '...');
              self._onStderr(id, line + '\n');
            }
          }
        });
      }
      proc.on('exit', function(code, signal) {
        // Flush remaining buffers
        if (stdoutBuffer.trim() && self._onStdout) {
          self._onStdout(id, stdoutBuffer);
        }
        if (stderrBuffer.trim() && self._onStderr) {
          self._onStderr(id, stderrBuffer);
        }
        console.log('[claude-swift] Process ' + id + ' exited: code=' + code + ' signal=' + signal);
        trace('Process ' + id + ' exited: code=' + code);
        if (self._onExit) self._onExit(id, code || 0, signal || '');
        self._processes.delete(id);
      });
      proc.on('error', function(err) {
        console.error('[claude-swift] Process ' + id + ' error:', err);
        if (self._onError) self._onError(id, err.message, err.stack);
      });

      return { success: true, pid: proc.pid };
    } catch (err) {
      console.error('[claude-swift] spawn error:', err);
      if (this._onError) this._onError(id, err.message, err.stack);
      throw err;
    }
  }

  spawnSync(command, args, options) {
    console.log('[claude-swift] spawnSync() cmd=' + command);
    try {
      const result = nodeSpawnSync(command, args || [], Object.assign({ encoding: 'utf-8' }, options || {}));
      return { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal, error: result.error };
    } catch (err) {
      console.error('[claude-swift] spawnSync error:', err);
      return { error: err, status: 1 };
    }
  }

  stopVM() {
    console.log('[claude-swift] stopVM()');
    for (const entry of this._processes) {
      try { entry[1].kill('SIGTERM'); } catch (e) {}
    }
    this._processes.clear();
    this._guestConnected = false;
    this._emit('guestConnectionChanged', { connected: false });
  }

  killProcess(id) {
    console.log('[claude-swift] killProcess(' + id + ')');
    const proc = this._processes.get(id);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch (e) {}
      this._processes.delete(id);
    }
  }

  cancelProcess(id) {
    return this.killProcess(id);
  }

  writeToProcess(id, data) {
    console.log('[claude-swift] writeToProcess(' + id + ')');
    const proc = this._processes.get(id);
    if (proc && proc.stdin) proc.stdin.write(data);
  }

  _emit(eventName, payload) {
    if (this._eventListener) this._eventListener(eventName, payload);
    this.emit(eventName, payload);
  }

  isGuestConnected() {
    return this._guestConnected;
  }

  getRunningStatus() {
    return { running: this._guestConnected, connected: this._guestConnected };
  }
}

const instance = new SwiftAddonStub();
trace('Instance created. vm=' + typeof instance.vm + ' vm.setEventCallbacks=' + typeof instance.vm.setEventCallbacks);
console.log('[claude-swift-stub] Exporting instance. Instance type:', typeof instance, 'setEventCallbacks:', typeof instance.setEventCallbacks);

// Export for both CommonJS and ESM
module.exports = instance;
module.exports.default = instance;
trace('Module exports set. default.vm.setEventCallbacks=' + typeof module.exports.default.vm.setEventCallbacks);
