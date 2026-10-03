import type { Target } from "@anynotate/protocol";

// A target with no session, pane or folder is the inbox: hooks never deliver it and any agent may read it, so its
// agent is only a placeholder the protocol requires and is never shown.
export const inboxOnly = (t: Target) => !t.sessionId && !t.pane && !t.cwd;

export const describeTarget = (t: Target) => (inboxOnly(t) ? "inbox (any agent)" : `${t.agent} @ ${t.cwd ?? t.pane ?? t.sessionId}`);
