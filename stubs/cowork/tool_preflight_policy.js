'use strict';

// ============================================================
// Tool preflight path policy (Phase 5 — predicate)
// ============================================================
// When the auto-permissions toggle is on (and within the Phase 2 TTL
// cap), this predicate decides whether a given tool invocation is
// eligible for auto-approval. Anything that fails the predicate must
// fall through to the asar's manual prompt.
//
// The complete predicate (rails, not barriers):
//
//   auto-approve eligible :=
//       tool ∈ READ_SET
//       && every path arg, realpath-resolved, is ⊆ realpath(cwd)
//       && auto-mode timer active   (checked by caller, not here)
//
// READ_SET: a fixed allowlist of tools whose effects are fully
// determined by their structured arguments and which have no exec /
// write / network affordances. Anything else — bash, exec, write,
// any tool with a shell-evaluated string argument — prompts every
// time, even with auto-mode on.
//
// Path containment: realpath(arg) must equal realpath(cwd) or be a
// sep-aware subpath. Symlink escapes are caught by realpath. No
// ambient-folder rule, no depth rule, no dotfile carve-out, no
// project-marker exceptions: cwd is the consent boundary the user
// picked. If `.env` is in cwd, the user chose to make it readable
// when the timer is on — pick a different cwd to change that.
//
// Wiring blocker (Phase 5 discovery): the actual IPC channel that
// surfaces a permission preflight on the main side has not been
// captured by the IPC tap in this development environment. Until
// the channel is identified via `CLAUDE_COWORK_IPC_TAP=1` against
// a live Cowork session that triggers a preflight, this module is
// pure-predicate only — the predicate is correct and tested, but
// not yet wired into frame-fix-wrapper.js. See PR description.

const path = require('path');
const fs = require('fs');

const READ_SET = Object.freeze(new Set([
  'read_file',
  'list_dir',
  'grep',
  'head',
  'tail',
  // Add more here only after auditing that the tool has no flag-driven
  // exec / write / network behavior. Notably NOT included:
  //   - find: has -exec
  //   - bash / sh / exec / run_command: shell evaluation
  //   - any tool that takes a shell-evaluated string argument
]));

function resolveRealpath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  try {
    return path.resolve(fs.realpathSync(p));
  } catch (_) {
    return path.resolve(p);
  }
}

function isContainedIn(targetReal, baseReal) {
  if (typeof targetReal !== 'string' || typeof baseReal !== 'string') return false;
  if (targetReal === baseReal) return true;
  return targetReal.startsWith(baseReal + path.sep);
}

// shouldAutoApproveToolPreflight({ tool, paths, cwd }) -> boolean
//
// Returns true iff:
//   - tool is in READ_SET
//   - paths is a non-null array (may be empty for tools that take no path)
//   - EVERY path in paths, after realpath resolution, is contained in cwd
//
// The caller is responsible for the "auto-mode timer active" check —
// that lives in frame-fix-wrapper.js next to the cap, not in this pure
// predicate. The caller is also responsible for invoking the asar's
// manual-prompt path when this returns false.
function shouldAutoApproveToolPreflight({ tool, paths, cwd } = {}) {
  if (typeof tool !== 'string' || !READ_SET.has(tool)) return false;
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  if (!Array.isArray(paths)) return false;
  const cwdReal = resolveRealpath(cwd);
  if (!cwdReal) return false;
  for (const p of paths) {
    const real = resolveRealpath(p);
    if (!real) return false;
    if (!isContainedIn(real, cwdReal)) return false;
  }
  return true;
}

module.exports = {
  shouldAutoApproveToolPreflight,
  READ_SET,
  resolveRealpath,
  isContainedIn,
};
