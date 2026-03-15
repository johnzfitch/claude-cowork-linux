const {
  chooseSessionTranscriptCandidate,
  sanitizeTranscriptProjectKey,
} = require('./transcript_store.js');

const REMOTE_CONVERSATION_MISSING_PATTERN = /No conversation found with session ID:/i;

function getPreferredSessionRoot(sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || !Array.isArray(sessionData.userSelectedFolders)) {
    return null;
  }

  for (const folderPath of sessionData.userSelectedFolders) {
    if (typeof folderPath === 'string' && folderPath.trim()) {
      return folderPath;
    }
  }

  return null;
}

function getPreferredProjectKey(sessionData) {
  return sanitizeTranscriptProjectKey(getPreferredSessionRoot(sessionData));
}

function cloneSessionData(sessionData) {
  if (!sessionData || typeof sessionData !== 'object' || Array.isArray(sessionData)) {
    return {};
  }
  return { ...sessionData };
}

function planSessionResume(options) {
  const {
    sessionData,
    sessionDirectory,
  } = options || {};

  const normalizedSessionData = cloneSessionData(sessionData);
  const preferredProjectKey = getPreferredProjectKey(normalizedSessionData);
  const transcriptCandidate = chooseSessionTranscriptCandidate({
    sessionDirectory,
    preferredProjectKey,
    cliSessionId: normalizedSessionData.cliSessionId,
  });

  if (!transcriptCandidate || !transcriptCandidate.resumable) {
    return {
      preferredProjectKey,
      transcriptCandidate,
      sessionData: normalizedSessionData,
      shouldResume: false,
      resumeCliSessionId: null,
      reason: transcriptCandidate ? 'transcript_not_resumable' : 'no_transcript_candidate',
    };
  }

  const nextSessionData = { ...normalizedSessionData };
  if (transcriptCandidate.cliSessionId && transcriptCandidate.cliSessionId !== nextSessionData.cliSessionId) {
    nextSessionData.cliSessionId = transcriptCandidate.cliSessionId;
  }

  return {
    preferredProjectKey,
    transcriptCandidate,
    sessionData: nextSessionData,
    shouldResume: true,
    resumeCliSessionId: transcriptCandidate.cliSessionId,
    reason: transcriptCandidate.cliSessionId === normalizedSessionData.cliSessionId
      ? 'resume_current_cli_session'
      : 'resume_best_transcript_candidate',
  };
}

function isRemoteConversationMissingError(errorMessage) {
  return typeof errorMessage === 'string' && REMOTE_CONVERSATION_MISSING_PATTERN.test(errorMessage);
}

function handleResumeFailure(options) {
  const {
    sessionData,
    sessionDirectory,
    errorMessage,
  } = options || {};

  const plannedResume = planSessionResume({ sessionData, sessionDirectory });
  if (!isRemoteConversationMissingError(errorMessage)) {
    return {
      ...plannedResume,
      continueLocally: false,
      clearCliSessionId: false,
      reason: 'non_resume_error',
      errorMessage,
    };
  }

  const nextSessionData = {
    ...plannedResume.sessionData,
    cliSessionId: null,
    error: errorMessage,
  };

  return {
    ...plannedResume,
    sessionData: nextSessionData,
    shouldResume: false,
    resumeCliSessionId: null,
    continueLocally: true,
    clearCliSessionId: true,
    reason: 'remote_conversation_missing',
    errorMessage,
  };
}

function handleFlatlineResumeFailure(options) {
  const {
    sessionData,
    sessionDirectory,
  } = options || {};

  const plannedResume = planSessionResume({ sessionData, sessionDirectory });
  const nextSessionData = {
    ...plannedResume.sessionData,
    cliSessionId: null,
    error: 'Resume turn exited without a first assistant response',
  };

  return {
    ...plannedResume,
    sessionData: nextSessionData,
    shouldResume: false,
    resumeCliSessionId: null,
    continueLocally: true,
    clearCliSessionId: true,
    retryFresh: true,
    reason: 'resume_flatline_no_first_response',
  };
}

module.exports = {
  ResumeCoordinator: {
    handleFlatlineResumeFailure,
    getPreferredProjectKey,
    getPreferredSessionRoot,
    handleResumeFailure,
    isRemoteConversationMissingError,
    planSessionResume,
  },
  handleFlatlineResumeFailure,
  getPreferredProjectKey,
  getPreferredSessionRoot,
  handleResumeFailure,
  isRemoteConversationMissingError,
  planSessionResume,
};
