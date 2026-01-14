// Linux stub for @ant/claude-native
// Provides minimal compatibility for Claude Desktop on Linux

const EventEmitter = require('events');

// Keyboard constants (used by the app)
const KeyboardKeys = {
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 8,
  DELETE: 46,
  ARROW_UP: 38,
  ARROW_DOWN: 40,
  ARROW_LEFT: 37,
  ARROW_RIGHT: 39,
};

// Auth request stub - falls back to system browser
class AuthRequest extends EventEmitter {
  constructor() {
    super();
  }

  start(url, callbackUrl) {
    // Open URL in system browser and listen for callback
    const { exec } = require('child_process');
    exec(`xdg-open "${url}"`);

    // The app should handle the OAuth callback via deep link or manual paste
    setTimeout(() => {
      this.emit('error', new Error('Authentication via system browser - paste the callback URL when complete'));
    }, 100);
  }

  cancel() {
    this.emit('cancelled');
  }

  static isAvailable() {
    return false; // Force system browser auth
  }
}

// Window management stubs
function focus_window(handle) {
  // Could implement with xdotool or wmctrl
  console.warn('[claude-native] focus_window not implemented on Linux');
  return false;
}

function get_active_window_handle() {
  // Could implement with xdotool
  return null;
}

// Preferences stubs (Linux uses different config systems)
function read_plist_value(domain, key) {
  return null;
}

function read_cf_pref_value(domain, key) {
  return null;
}

function read_registry_values(request) {
  return null;
}

function write_registry_value(request) {
  return false;
}

function get_app_info_for_file(filePath) {
  // Could implement with xdg-mime
  return null;
}

module.exports = {
  KeyboardKeys,
  AuthRequest,
  focus_window,
  focusWindow: focus_window,
  get_active_window_handle,
  getActiveWindowHandle: get_active_window_handle,
  read_plist_value,
  readPlistValue: read_plist_value,
  read_cf_pref_value,
  readCfPrefValue: read_cf_pref_value,
  read_registry_values,
  readRegistryValues: read_registry_values,
  write_registry_value,
  writeRegistryValue: write_registry_value,
  get_app_info_for_file,
  getAppInfoForFile: get_app_info_for_file,
};
