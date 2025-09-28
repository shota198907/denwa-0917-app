export interface MetricsSnapshot {
  readonly activeSessions: number;
  readonly totalSessions: number;
  readonly reconnects: number;
  readonly rateLimitedReconnects: number;
  readonly emptyTurnCommits: number;
  readonly forcedCloseDrops: number;
  readonly lengthMismatches: number;
  readonly pendingAtClose: number;
  readonly audioExtractionAttempts: number;
  readonly audioExtractionSuccesses: number;
  readonly audioExtractionFailures: number;
  readonly segmentFallbackCount: number;
  readonly zeroAudioSegments: number;
  readonly realtimeOutputDetections: number;
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
  audioExtractionAttempts: number;
  audioExtractionSuccesses: number;
  audioExtractionFailures: number;
  segmentFallbackCount: number;
  zeroAudioSegments: number;
  realtimeOutputDetections: number;
} = {
  activeSessions: 0,
  totalSessions: 0,
  reconnects: 0,
  rateLimitedReconnects: 0,
  emptyTurnCommits: 0,
  forcedCloseDrops: 0,
  lengthMismatches: 0,
  pendingAtClose: 0,
  audioExtractionAttempts: 0,
  audioExtractionSuccesses: 0,
  audioExtractionFailures: 0,
  segmentFallbackCount: 0,
  zeroAudioSegments: 0,
  realtimeOutputDetections: 0,
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
  audioExtractionAttempted(): void {
    state.audioExtractionAttempts += 1;
  },
  audioExtractionSucceeded(): void {
    state.audioExtractionSuccesses += 1;
  },
  audioExtractionFailed(): void {
    state.audioExtractionFailures += 1;
  },
  segmentFallbackDetected(): void {
    state.segmentFallbackCount += 1;
  },
  zeroAudioSegmentDetected(): void {
    state.zeroAudioSegments += 1;
  },
  realtimeOutputDetected(): void {
    state.realtimeOutputDetections += 1;
  },
};
