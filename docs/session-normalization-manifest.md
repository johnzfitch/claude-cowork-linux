# Session Normalization Refactor Manifest

Generated: 2026-03-19

This manifest catalogs all session normalization logic scattered across the claude-cowork-linux codebase. Each `@session-refactor:NORM-NNN` tag marks a definition, duplicate, caller, or target site for consolidation.

## Index by Tag ID

| ID | Type | File | Line (approx) | Description |
|----|------|------|---------------|-------------|
| NORM-001 | DEFINITION | stubs/frame-fix/frame-fix-wrapper.js | 553 | message types to drop from live events (frame-fix-wrapper.js) — includes metadata + rate_limit_event |
| NORM-002 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 10 | message types to drop from live events (local_session_bridge.js) — only rate_limit_event |
| NORM-003 | DEFINITION | stubs/frame-fix/frame-fix-wrapper.js | 607 | check if live event should be dropped based on message type |
| NORM-004 | DEFINITION | stubs/cowork/asar_adapter.js | 4 | message types to drop from transcript reads (asar_adapter.js) |
| NORM-005 | DEFINITION | stubs/cowork/asar_adapter.js | 52 | filter transcript messages, removing ignored types |
| NORM-006 | DEFINITION | stubs/cowork/asar_adapter.js | 360 | normalize IPC results (filter transcripts, repair session records) |
| NORM-007 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 4 | metadata message types to extract and accumulate (not forward as regular messages) |
| NORM-008 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 1137 | check if live event should be dropped (DUPLICATE of NORM-003) |
| NORM-020 | DEFINITION | stubs/cowork/session_store.js | 317 | normalize session record (top-level entry point) |
| NORM-021 | DEFINITION | stubs/cowork/session_store.js | 470 | normalize session record with metadata path context (cwd repair, cliSessionId selection) |
| NORM-022 | ANNOTATION | stubs/cowork/session_store.js | 493 | recover preferred root from audit.jsonl if userSelectedFolders is empty |
| NORM-023 | ANNOTATION | stubs/cowork/session_store.js | 509 | repair session cwd if synthetic/invalid |
| NORM-024 | ANNOTATION | stubs/cowork/session_store.js | 513 | update cliSessionId to match canonical transcript |
| NORM-025 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 259 | repair session metadata (DUPLICATE of NORM-021 but with different return signature) |
| NORM-040 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 942 | normalize SDK message list (filter, extract metadata, merge assistant messages) |
| NORM-041 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 885 | merge consecutive assistant messages by message ID |
| NORM-042 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 593 | merge two assistant messages if they have the same ID |
| NORM-043 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 570 | merge assistant content blocks by ID or fallback index |
| NORM-044 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 518 | merge individual content blocks (text, thinking, tool_use, tool_result) |
| NORM-045 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 775 | build synthetic assistant message from stream_event |
| NORM-046 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 985 | normalize IPC session record (attach metadata, normalize messages) |
| NORM-047 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 1016 | normalize IPC result by channel (getTranscript, getSession, getAll) |
| NORM-048 | DEFINITION | linux-app-extracted/cowork/local_session_ipc_adapter.js | 12 | wrap IPC handler to normalize result on return |
| NORM-060 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 693 | accumulate metadata messages into coworkCompatibilityState |
| NORM-061 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 618 | get or create coworkCompatibilityState for session |
| NORM-062 | ANNOTATION | linux-app-extracted/cowork/local_session_bridge.js | 1008 | attach accumulated metadata state |
| NORM-063 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 1045 | normalize live session event payloads (dispatch, metadata extraction, message merging) |
| NORM-064 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 748 | attach accumulated metadata state to payload |
| NORM-080 | DEFINITION | stubs/cowork/session_store.js | 594 | normalize serialized metadata (JSON string → normalized JSON string) |
| NORM-081 | DEFINITION | stubs/cowork/session_store.js | 614 | normalize write value (handles string, Buffer, or passthrough) |
| NORM-082 | DEFINITION | stubs/cowork/session_store.js | 630 | install fs.writeFile* patches to auto-repair session metadata on write |
| NORM-083 | ANNOTATION | stubs/cowork/session_store.js | 659 | repair all existing session metadata files on startup |
| NORM-084 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 292 | normalize serialized metadata (DUPLICATE of NORM-080 with logging) |
| NORM-085 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 314 | normalize write value (DUPLICATE of NORM-081) |
| NORM-086 | DEFINITION | linux-app-extracted/cowork/local_session_bridge.js | 329 | install fs.writeFile* patches (DUPLICATE of NORM-082 with extra reentrancy guard) |
| NORM-087 | ANNOTATION | linux-app-extracted/cowork/local_session_bridge.js | 372 | repair all existing session metadata files on startup |
| NORM-100 | TARGET | stubs/cowork/session_orchestrator.js | 1070 | consolidated message type filtering will land here |
| NORM-101 | TARGET | stubs/cowork/session_orchestrator.js | 1074 | consolidated session record normalization will land here |
| NORM-102 | TARGET | stubs/cowork/session_orchestrator.js | 1078 | consolidated SDK message transformation will land here |
| NORM-103 | TARGET | stubs/cowork/session_orchestrator.js | 1082 | consolidated live event dispatch normalization will land here |
| NORM-104 | TARGET | stubs/cowork/session_orchestrator.js | 1086 | consolidated metadata persistence will land here |

## Duplicates Report

| NORM-NNN | Duplicates | Notes |
|----------|------------|-------|
| NORM-001 | NORM-004 | Same set values, different use case (live events vs transcripts) |
| NORM-002 | NORM-001 (partial) | Subset of NORM-001 (only rate_limit_event) |
| NORM-003 | NORM-008 | Same logic, different constant reference |
| NORM-021 | NORM-025 | Same logic, different return signature |
| NORM-080 | NORM-084 | Same logic, NORM-084 adds logging |
| NORM-081 | NORM-085 | Exact duplicate |
| NORM-082 | NORM-086 | NORM-086 adds reentrancy guard |

## Consolidation Plan by Concern

### NORM-001 to NORM-019: Message Type Filtering

**Current state:**
- NORM-001: frame-fix-wrapper.js (queue-operation, progress, last-prompt, rate_limit_event)
- NORM-002: local_session_bridge.js (rate_limit_event only)
- NORM-003: frame-fix-wrapper.js getIgnoredLiveMessageType
- NORM-004: asar_adapter.js (same as NORM-001)
- NORM-005: asar_adapter.js filterTranscriptMessages
- NORM-007: local_session_bridge.js HANDLED_LIVE_METADATA_MESSAGE_TYPES
- NORM-008: local_session_bridge.js getIgnoredLiveMessageType (duplicate of NORM-003)

**Consolidation target:** NORM-100
**Proposed signature:** `filterMessagesByType(messages, filterConfig)`
**Unification strategy:**
1. Create single source-of-truth constant set for each filtering category:
   - `TRANSCRIPT_IGNORED_TYPES` (current NORM-004)
   - `LIVE_EVENT_IGNORED_TYPES` (current NORM-001)
   - `METADATA_EXTRACTED_TYPES` (current NORM-007)
2. Replace all `getIgnoredLiveMessageType` calls with single implementation
3. Consolidate `filterTranscriptMessages` into orchestrator

**Call sites to rewire:**
- frame-fix-wrapper.js:832 (NORM-003 caller)
- asar_adapter.js:61, 65 (NORM-004 callers)
- asar_adapter.js:367 (NORM-005 caller)
- local_session_bridge.js:957, 963, 968, 974 (NORM-007 callers)
- local_session_bridge.js:1060, 1068, 1087 (NORM-007 callers)

### NORM-020 to NORM-039: Session Record Normalization

**Current state:**
- NORM-020: session_store.js normalizeSessionRecord (entry point)
- NORM-021: session_store.js normalizeSessionRecordForMetadataPath (implementation)
- NORM-022: audit recovery logic
- NORM-023: cwd repair logic
- NORM-024: cliSessionId selection logic
- NORM-025: local_session_bridge.js repairLocalSessionMetadataData (duplicate of NORM-021)

**Consolidation target:** NORM-101
**Proposed signature:** `normalizeSessionRecord(sessionData, context)`
**Unification strategy:**
1. Merge NORM-021 and NORM-025 into single implementation
2. Return both normalized value and change metadata (for logging)
3. Move to orchestrator as public method

**Call sites to rewire:**
- asar_adapter.js:370, 376 (NORM-020 callers)
- session_store.js:347, 372, 573, 601 (NORM-021 callers)
- local_session_bridge.js:299 (NORM-025 caller)

### NORM-040 to NORM-059: SDK Message Transformation

**Current state:**
- NORM-040: normalizeSdkMessageList (entry point)
- NORM-041: mergeConsecutiveAssistantMessages
- NORM-042: mergeAssistantSdkMessages
- NORM-043: mergeAssistantContent
- NORM-044: mergeAssistantContentBlock
- NORM-045: buildSyntheticAssistantPayloadFromStreamEvent

**Consolidation target:** NORM-102
**Proposed signature:** `transformSdkMessages(messages, sessionId)`
**Unification strategy:**
1. Move entire message transformation pipeline to orchestrator
2. Keep as composable internal methods
3. Expose single public entry point

**Call sites to rewire:**
- local_session_bridge.js:1001, 1005, 1026, 1029 (NORM-040 callers)
- local_session_bridge.js:982, 1079 (NORM-041 callers)
- local_session_bridge.js:613, 893, 1105, 1123 (NORM-042 callers)
- local_session_bridge.js:587 (NORM-043 caller)
- local_session_bridge.js:1099 (NORM-045 caller)

### NORM-060 to NORM-079: Live Event Dispatch

**Current state:**
- NORM-060: applyLiveSessionMetadataMessage (accumulate metadata)
- NORM-061: getOrCreateLiveSessionCompatibilityState
- NORM-062: attach metadata annotation
- NORM-063: normalizeLiveSessionPayloads (main dispatcher)
- NORM-064: attachLiveSessionCompatibilityState

**Consolidation target:** NORM-103
**Proposed signature:** `normalizeLiveEvent(channel, payload, sessionId)`
**Unification strategy:**
1. Move compatibility state management to orchestrator
2. Integrate with message filtering (NORM-100)
3. Integrate with message transformation (NORM-102)

**Call sites to rewire:**
- local_session_bridge.js:959, 970, 1061, 1069, 1088 (NORM-060 callers)
- local_session_bridge.js:1077, 1084, 1095, 1101, 1109, 1110, 1118, 1126, 1134 (NORM-064 callers)

### NORM-080 to NORM-099: Metadata Persistence

**Current state:**
- NORM-080: session_store.js normalizeSerializedMetadata
- NORM-081: session_store.js normalizeWriteValue
- NORM-082: session_store.js installMetadataPersistenceGuard
- NORM-083: repair on startup annotation
- NORM-084: local_session_bridge.js normalizeLocalSessionMetadataSerialized (duplicate)
- NORM-085: local_session_bridge.js normalizeLocalSessionMetadataWriteValue (duplicate)
- NORM-086: local_session_bridge.js installMetadataPersistenceGuard (duplicate)
- NORM-087: repair on startup annotation

**Consolidation target:** NORM-104
**Proposed signature:** `installMetadataPersistence(config)`
**Unification strategy:**
1. Remove duplicate in local_session_bridge.js
2. Keep single implementation in session_store.js
3. Orchestrator calls session_store method

**Call sites to rewire:**
- session_store.js:616, 621, 667 (NORM-080 callers)
- session_store.js:643, 648, 654 (NORM-081 callers)
- frame-fix-wrapper.js:356 (NORM-082 caller)
- local_session_bridge.js:380 (NORM-084 caller)
- local_session_bridge.js:356, 361, 367 (NORM-085 callers)

## Verification

Run these grep commands to validate completeness:

```bash
# Count all tags
grep -r '@session-refactor:NORM-' /home/zack/dev/claude-cowork-linux/stubs/ /home/zack/dev/claude-cowork-linux/linux-app-extracted/cowork/ | wc -l

# List all DEFINITION tags
grep -r '@session-refactor:NORM-.*DEFINITION' /home/zack/dev/claude-cowork-linux/stubs/ /home/zack/dev/claude-cowork-linux/linux-app-extracted/cowork/ | sort

# List all CALLER tags
grep -r '@session-refactor:NORM-.*CALLER' /home/zack/dev/claude-cowork-linux/stubs/ /home/zack/dev/claude-cowork-linux/linux-app-extracted/cowork/ | sort

# List all TARGET tags
grep -r '@session-refactor:NORM-.*TARGET' /home/zack/dev/claude-cowork-linux/stubs/ /home/zack/dev/claude-cowork-linux/linux-app-extracted/cowork/ | sort

# Verify no test files were annotated
grep -r '@session-refactor:NORM-' /home/zack/dev/claude-cowork-linux/tests/ 2>/dev/null || echo "No test files annotated (correct)"
```

## Next Steps

1. Review this manifest for completeness
2. Create migration plan with ordering (dependencies)
3. Implement NORM-100 (message filtering) first (fewest dependencies)
4. Implement NORM-101 (session normalization)
5. Implement NORM-102 (SDK transformation)
6. Implement NORM-103 (live event dispatch)
7. Implement NORM-104 (metadata persistence)
8. Update all call sites to use orchestrator methods
9. Remove duplicates from local_session_bridge.js
10. Run tests to verify consolidation

## Notes

- All annotations are comment-only, zero logic changes
- Duplicates marked with cross-references
- Call sites traced for rewiring during consolidation
- Target insertion points marked in session_orchestrator.js
- Manifest is grep-verifiable for CI validation
