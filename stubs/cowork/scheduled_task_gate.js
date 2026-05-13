'use strict';

// ============================================================
// Scheduled-task creation gating (Phase 6 — predicate)
// ============================================================
// The asar exposes shouldAutoApprovePermission(scheduledTaskId, ...)
// which auto-approves tools for scheduled tasks based on permissions
// baked in at task creation time. That's fine *only* if scheduled-task
// creation and modification can never happen via the bridge transport
// (only via the renderer's user UI).
//
// Discovery found two namespaces in the bundled index.js:
//   - CCDScheduledTasks_$_*
//   - CoworkScheduledTasks_$_*
// each with the same eight methods. Read-only methods (getAll*, get*FileContent,
// onScheduledTaskEvent) are safe by definition. The mutating methods listed
// below would, if bridge-reachable, let a remote message create a task whose
// approvedPermissions then short-circuit shouldAutoApprovePermission for all
// future runs — bypassing the manual acceptance flow Phase 1 restored.
//
// Bridge-reachability blocker: static grep cannot determine whether the bridge
// transport drives these channels or only the renderer does. Resolution
// requires CLAUDE_COWORK_IPC_TAP=1 against a real Cowork session that creates
// and runs a scheduled task. Per the spec, this module ships the predicate
// (testable) and a refused-handler factory; wiring lands in a follow-up after
// live trace. See PR description.

const MUTATING_SCHEDULED_TASK_SUFFIXES = Object.freeze(new Set([
  // CCDScheduledTasks
  'CCDScheduledTasks_$_createScheduledTask',
  'CCDScheduledTasks_$_updateScheduledTask',
  'CCDScheduledTasks_$_updateScheduledTaskFileContent',
  'CCDScheduledTasks_$_updateScheduledTaskStatus',
  'CCDScheduledTasks_$_removeApprovedPermission',
  // CoworkScheduledTasks
  'CoworkScheduledTasks_$_createScheduledTask',
  'CoworkScheduledTasks_$_updateScheduledTask',
  'CoworkScheduledTasks_$_updateScheduledTaskFileContent',
  'CoworkScheduledTasks_$_updateScheduledTaskStatus',
  'CoworkScheduledTasks_$_removeApprovedPermission',
  'CoworkScheduledTasks_$_clearChromePermissions',
]));

const READ_ONLY_SCHEDULED_TASK_SUFFIXES = Object.freeze(new Set([
  'CCDScheduledTasks_$_getAllScheduledTasks',
  'CCDScheduledTasks_$_getScheduledTaskFileContent',
  'CCDScheduledTasks_$_onScheduledTaskEvent',
  'CoworkScheduledTasks_$_getAllScheduledTasks',
  'CoworkScheduledTasks_$_getScheduledTaskFileContent',
  'CoworkScheduledTasks_$_onScheduledTaskEvent',
  'LocalAgentModeSessions_$_getSessionsForScheduledTask',
  'LocalSessions_$_getSessionsForScheduledTask',
]));

function endsWithAnyOf(channel, suffixSet) {
  if (typeof channel !== 'string') return false;
  for (const suffix of suffixSet) {
    if (channel.endsWith(suffix)) return true;
  }
  return false;
}

function isMutatingScheduledTaskChannel(channel) {
  return endsWithAnyOf(channel, MUTATING_SCHEDULED_TASK_SUFFIXES);
}

function isReadOnlyScheduledTaskChannel(channel) {
  return endsWithAnyOf(channel, READ_ONLY_SCHEDULED_TASK_SUFFIXES);
}

// makeRefusedHandler() returns an IPC-handler-shaped async function that
// always refuses with a structured error. Use this to wrap the bridge-
// reachable mutating channels ONCE that reachability is confirmed.
function makeRefusedHandler({ log = console.warn, reason = 'bridge-reachable scheduled-task mutation refused' } = {}) {
  return async function refusedScheduledTaskHandler() {
    log('[scheduled-task-gate] ' + reason);
    const err = new Error(reason);
    err.code = 'COWORK_SCHEDULED_TASK_REFUSED';
    throw err;
  };
}

module.exports = {
  MUTATING_SCHEDULED_TASK_SUFFIXES,
  READ_ONLY_SCHEDULED_TASK_SUFFIXES,
  isMutatingScheduledTaskChannel,
  isReadOnlyScheduledTaskChannel,
  makeRefusedHandler,
};
