export interface MetricsSnapshot {
  readonly activeSessions: number;
  readonly totalSessions: number;
  readonly reconnects: number;
  readonly rateLimitedReconnects: number;
}

const state: { activeSessions: number; totalSessions: number; reconnects: number; rateLimitedReconnects: number } = {
  activeSessions: 0,
  totalSessions: 0,
  reconnects: 0,
  rateLimitedReconnects: 0,
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
};
