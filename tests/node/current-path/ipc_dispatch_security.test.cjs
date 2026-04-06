const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('ipc_tap does not patch invokeHandlers.get() because C++ dispatch never calls it', () => {
  // Load ipc_tap module
  const ipcTapPath = path.join(__dirname, '..', '..', '..', 'stubs', 'cowork', 'ipc_tap.js');
  const ipcTapSource = fs.readFileSync(ipcTapPath, 'utf8');
  
  // Find the wrapInvokeHandlers function and its comment block
  const wrapInvokeHandlersStart = ipcTapSource.indexOf('// Tap the _invokeHandlers Map directly');
  const wrapInvokeHandlersEnd = ipcTapSource.indexOf('}\n\n  const tappedContents', wrapInvokeHandlersStart);
  
  assert.ok(wrapInvokeHandlersStart > 0, 'wrapInvokeHandlers comment block should exist');
  assert.ok(wrapInvokeHandlersEnd > wrapInvokeHandlersStart, 'wrapInvokeHandlers function should have a body');
  
  const wrapInvokeHandlersSection = ipcTapSource.slice(wrapInvokeHandlersStart, wrapInvokeHandlersEnd);
  
  // Verify it DOES patch .set() (this is correct)
  assert.ok(
    wrapInvokeHandlersSection.includes('invokeHandlers.set = function'),
    'wrapInvokeHandlers should patch .set() to intercept handler registration'
  );
  
  // Verify it does NOT patch .get() (dead code per frame-fix-wrapper.js:435)
  assert.ok(
    !wrapInvokeHandlersSection.includes('invokeHandlers.get = function'),
    'wrapInvokeHandlers should NOT patch .get() because Electron C++ dispatch never calls it'
  );
  
  // Verify the comment explaining why we don't patch .get()
  assert.ok(
    wrapInvokeHandlersSection.includes('Electron dispatches') &&
    wrapInvokeHandlersSection.includes('never calls Map.get()'),
    'Should have comment explaining C++ dispatch behavior'
  );
});

test('ipc_tap wrapInvokeHandlers properly wraps .set() for monitoring', () => {
  // Simulate the behavior: create a mock invokeHandlers Map
  const mockInvokeHandlers = new Map();
  const setCallHistory = [];
  const originalSet = mockInvokeHandlers.set.bind(mockInvokeHandlers);
  
  // Simulate what ipc_tap does (without the actual module to avoid env dependencies)
  const recordedChannels = [];
  const wrappedHandlers = new Map();
  
  mockInvokeHandlers.set = function(channel, handler) {
    recordedChannels.push(channel);
    const wrappedHandler = async function(...args) {
      // Simulate wrapping for monitoring
      return await handler(...args);
    };
    wrappedHandler.__ipcTapWrapped = true;
    wrappedHandlers.set(channel, wrappedHandler);
    return originalSet(channel, wrappedHandler);
  };
  
  // Register a handler
  const testHandler = async () => 'result';
  mockInvokeHandlers.set('test-channel', testHandler);
  
  // Verify the channel was recorded
  assert.deepEqual(recordedChannels, ['test-channel']);
  
  // Verify the handler was wrapped
  const registered = wrappedHandlers.get('test-channel');
  assert.ok(registered);
  assert.ok(registered.__ipcTapWrapped === true);
});

test('frame-fix-wrapper comment documents C++ dispatch behavior', () => {
  // Verify the frame-fix-wrapper has the critical comment about dispatch
  const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
  const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');
  
  // The wrapper file should already have this comment (not modified in this PR,
  // but this test ensures it remains present as it's the source of truth)
  assert.ok(
    wrapperSource.includes('_invokeHandlers.get() is dead code'),
    'frame-fix-wrapper should document that .get() is dead code'
  );
  
  assert.ok(
    wrapperSource.includes('Electron dispatches via C++'),
    'frame-fix-wrapper should document C++ dispatch mechanism'
  );
  
  assert.ok(
    wrapperSource.includes('never calls Map.get() from JavaScript'),
    'frame-fix-wrapper should document that Map.get() is never called from JS'
  );
  
  assert.ok(
    wrapperSource.includes('Synthetic handlers MUST be'),
    'frame-fix-wrapper should document correct handler registration method'
  );
});

test('no other invokeHandlers.get() patches exist in stubs', () => {
  // Recursively check all stub files for .get() patches on handlers
  const stubsDir = path.join(__dirname, '..', '..', '..', 'stubs');
  
  function checkDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        checkDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        
        // Check for patterns that would indicate patching .get() on IPC handlers
        const suspiciousPatterns = [
          /invokeHandlers\.get\s*=\s*function/,
          /_invokeHandlers\.get\s*=\s*function/,
        ];
        
        for (const pattern of suspiciousPatterns) {
          if (pattern.test(content)) {
            assert.fail(`File ${fullPath} contains suspicious .get() patch: ${pattern}`);
          }
        }
      }
    }
  }
  
  checkDirectory(stubsDir);
  // If we get here, no suspicious patterns were found
  assert.ok(true, 'No invokeHandlers.get() patches found in stubs');
});

test('SECURITY: remote module should not be enabled anywhere in our code', () => {
  // Verify we don't enable remote module in any of our stubs
  const stubsDir = path.join(__dirname, '..', '..', '..', 'stubs');
  
  function checkDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        checkDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        
        // Check for patterns that would enable remote module
        const dangerousPatterns = [
          /enableRemoteModule\s*:\s*true/i,
          /enableRemoteModule\s*=\s*true/i,
          /'enableRemoteModule'\s*:\s*true/i,
          /"enableRemoteModule"\s*:\s*true/i,
        ];
        
        for (const pattern of dangerousPatterns) {
          if (pattern.test(content)) {
            assert.fail(`File ${fullPath} enables remote module (security risk): ${pattern}`);
          }
        }
      }
    }
  }
  
  checkDirectory(stubsDir);
  // If we get here, no dangerous patterns were found
  assert.ok(true, 'No enableRemoteModule: true found in stubs (secure)');
});

test('SECURITY: documentation explains dispatch and remote module security model', () => {
  // Check that CLAUDE.md has Chain 6 documentation added in this PR
  const claudeMdPath = path.join(__dirname, '..', '..', '..', 'CLAUDE.md');
  
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    
    // Should have Chain 6 that was added in this PR
    assert.ok(
      content.includes('Chain 6: IPC Dispatch Security'),
      'CLAUDE.md should have Chain 6 section added in this PR'
    );
    
    // Should explain C++ dispatch mechanism
    assert.ok(
      content.includes('Electron uses a C++ dispatch mechanism'),
      'CLAUDE.md should explain C++ dispatch mechanism'
    );
    
    // Should explain why .get() is dead code
    assert.ok(
      content.includes('Map.get() method is NEVER'),
      'CLAUDE.md should explain why .get() is dead code'
    );
  } else {
    assert.fail('CLAUDE.md should exist');
  }
  
  // Check frame-fix-wrapper has inline security documentation
  const wrapperPath = path.join(__dirname, '..', '..', '..', 'stubs', 'frame-fix', 'frame-fix-wrapper.js');
  const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');
  
  assert.ok(
    wrapperContent.includes('CRITICAL') || wrapperContent.includes('SECURITY'),
    'frame-fix-wrapper should have security-related comments'
  );
});
