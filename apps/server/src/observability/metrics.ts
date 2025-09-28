export interface MetricsSnapshot {
  readonly activeSessions: number;
  readonly totalSessions: number;
  readonly reconnects: number;
  readonly rateLimitedReconnects: number;
  readonly emptyTurnCommits: number;
  readonly forcedCloseDrops: number;
  readonly lengthMismatches: number;
  readonly pendingAtClose: number;
}

const state: {
  activeSessions: number;
  totalSessions: number;
  reconnects: number;
  rateLimitedReconnects: number;
  emptyTurnCommits: number;
  forcedCloseDrops: number;
  lengthMismatches: number;
  pendingAtClose: number;
} = {
  activeSessions: 0,
  totalSessions: 0,
  reconnects: 0,
  rateLimitedReconnects: 0,
  emptyTurnCommits: 0,
  forcedCloseDrops: 0,
  lengthMismatches: 0,
  pendingAtClose: 0,
};

export const metrics = {
  snapshot(): MetricsSnapshot {
    return { ...state };
  },
  sessionStarted(): void {
    state.activeSessions += 1;
    state.totalSessions += 1;
  },
  sessionEnded(): void {
    state.activeSessions = Math.max(state.activeSessions - 1, 0);
  },
  reconnectRecorded(): void {
    state.reconnects += 1;
  },
  rateLimitedReconnect(): void {
    state.rateLimitedReconnects += 1;
  },
  emptyTurnCommitted(): void {
    state.emptyTurnCommits += 1;
  },
  forcedCloseDropped(): void {
    state.forcedCloseDrops += 1;
  },
  lengthMismatchDetected(): void {
    state.lengthMismatches += 1;
  },
  pendingAtCloseObserved(): void {
    state.pendingAtClose += 1;
  },
};
