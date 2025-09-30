import { AUDIO_ONLY_LABEL, guardCaption, extractCaption } from "./caption-helpers";
import { TranscriptSnapshot, TranscriptStore } from "./transcript-store";

export interface LiveSessionCallbacks {
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (details: string) => void;
  onLog?: (message: string) => void;
  onCaption?: (caption: string) => void;
  onTranscript?: (snapshot: TranscriptSnapshot) => void;
  onModelText?: (text: string, isComplete: boolean, turnId?: number) => void;
}

interface LiveAudioSessionOptions {
  featureFlags?: Partial<LiveAudioSessionFeatureFlags>;
}

interface LiveAudioSessionFeatureFlags {
  ttsPrefixDedupeEnabled: boolean;
  ttsTextDebounceMs: number;
  ttsExclusivePlaybackEnabled: boolean;
  playerFlushBargeInOnly: boolean;
  playerFlushOnStartMicLegacy: boolean;
  playerInitialQueueMs: number;
  playerStartLeadMs: number;
  playerTrimGraceMs: number;
  playerSentencePauseMs: number;
  playerArmSupersedeQuietMs: number;
  playerCommitGuardMs: number;
  playerSupersedePrefixEnabled: boolean;
}

const DEFAULT_FEATURE_FLAGS: LiveAudioSessionFeatureFlags = {
  ttsPrefixDedupeEnabled: false,
  ttsTextDebounceMs: 600,
  ttsExclusivePlaybackEnabled: false,
  playerFlushBargeInOnly: true,
  playerFlushOnStartMicLegacy: false,
  playerInitialQueueMs: 1600,
  playerStartLeadMs: 150,
  playerTrimGraceMs: 450,
  playerSentencePauseMs: 250,
  playerArmSupersedeQuietMs: 600,
  playerCommitGuardMs: 350,
  playerSupersedePrefixEnabled: false,
};

declare global {
  interface Window {
    __denwaFeatureFlags?: Partial<LiveAudioSessionFeatureFlags>;
  }
}

const AUDIO_MIME = "audio/pcm;rate=16000";
const TEXT_PREVIEW_LENGTH = 200;
const FLUSH_GUARD_MS = 200;
const SOFT_SUPERSEDE_THRESHOLD_MS = 120;
const TERMINAL_PUNCTUATION = /[。．.？！?!…]$/;
const TERMINAL_CHARACTERS = ["。", "．", ".", "？", "?", "！", "!", "…"] as const;
const SENTENCE_TERMINATOR_SET = new Set(TERMINAL_CHARACTERS);
const MIN_PUNCTUATED_SENTENCE_LENGTH = 3;
const MIN_UNPUNCTUATED_SENTENCE_LENGTH = 6;
const METRIC_ALERT_SAMPLE_MIN = 200;
const SHORT_TEXT_ALERT_RATE = 0.05;
const AUDIO_FALLBACK_ALERT_RATE = 0.01;
const FINAL_TIMEOUT_ALERT_RATE = 0.05;
const TEXT_MISSING_ALERT_RATE = 0.05;
const CONTROL_MAX_BYTES = 256;
const CONTROL_DETECTION_ENABLED = false; // 診断用: バイナリは必ず音声として扱う
const LOCAL_STORAGE_FLAG_KEY = "__denwaFeatureFlags";
const MIN_INITIAL_QUEUE_MS = 50;
const MAX_INITIAL_QUEUE_MS = 1500;
const MIN_START_LEAD_MS = 0;
const MAX_START_LEAD_MS = 600;
const MIN_TRIM_GRACE_MS = 0;
const MAX_TRIM_GRACE_MS = 1000;
const MIN_SENTENCE_PAUSE_MS = 0;
const MAX_SENTENCE_PAUSE_MS = 200;
const MIN_ARM_SUPERSEDE_QUIET_MS = 0;
const MAX_ARM_SUPERSEDE_QUIET_MS = 1200;
const MIN_COMMIT_GUARD_MS = 0;
const MAX_COMMIT_GUARD_MS = 1000;
const PLAYER_DEFAULT_INITIAL_QUEUE_MS = 1600;
const PLAYER_DEFAULT_START_LEAD_MS = 150;
const PLAYER_DEFAULT_TRIM_GRACE_MS = 450;
const PLAYER_DEFAULT_SENTENCE_PAUSE_MS = 250;
const PLAYER_DEFAULT_ARM_SUPERSEDE_QUIET_MS = 600;
const PLAYER_DEFAULT_COMMIT_GUARD_MS = 350;
const AUDIO_FALLBACK_DELAY_MS = 900;
const FINAL_COMMIT_DELAY_MS = 1300;
const STREAMING_STALE_THRESHOLD_MS = 2000; // バイナリ音声が止まってからこの時間を超えたら再デコードを許可
const BINARY_RECV_SUMMARY_INTERVAL_MS = 1200;
const BINARY_RECV_SUMMARY_CHUNK_LIMIT = 24;
const CAPTION_PLACEHOLDER = "字幕準備中…";
const SHORT_TEXT_WHITELIST = new Set([
  "はい。",
  "はい",
  "了解です。",
  "了解です",
  "了解しました。",
  "了解しました",
  "わかりました。",
  "わかりました",
  "大丈夫です。",
  "大丈夫です",
]);

interface SegmentCommitEventPayload {
  readonly event: "SEGMENT_COMMIT";
  readonly segmentId: string;
  readonly turnId: number;
  readonly index: number;
  readonly text: string;
  readonly audio: string;
  readonly durationMs: number;
  readonly audioBytes: number;
  readonly nominalDurationMs?: number;
  readonly audioSamples?: number;
}

interface TurnCommitEventPayload {
  readonly event: "TURN_COMMIT";
  readonly turnId: number;
  readonly finalText: string;
  readonly segmentCount: number;
}

interface SegmentDiagnosticsEventPayload {
  readonly event: "SEGMENT_DIAGNOSTICS";
  readonly sessionId?: string;
  readonly turnId: number;
  readonly transcriptLength: number;
  readonly partialLength: number;
  readonly pendingTextCount: number;
  readonly pendingTextLength: number;
  readonly pendingAudioBytes: number;
  readonly audioChunkCount: number;
  readonly audioChunkBytes: number;
  readonly audioChunkMin?: number;
  readonly audioChunkMax?: number;
  readonly zeroAudioSegments: number;
}

interface ModelTextEventPayload {
  readonly event: "MODEL_TEXT";
  readonly text: string;
  readonly turnId?: number;
  readonly isComplete: boolean;
}

type BinaryReceptionOrigin = "ws" | "blob" | "segment_fallback";
type BinaryReceptionSummaryReason = "interval" | "chunk" | "turn" | "reset" | "fallback";

interface BinaryReceptionSummary {
  chunkCount: number;
  totalBytes: number;
  minBytes: number;
  maxBytes: number;
  firstChunkAt: number;
  lastChunkAt: number;
  lastFlushAt: number;
  originCounts: Record<BinaryReceptionOrigin, number>;
  originBytes: Record<BinaryReceptionOrigin, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

/**
 * SEGMENT_COMMIT形式のイベントであるか簡易検査する。
 */
const isSegmentCommitEvent = (value: unknown): value is SegmentCommitEventPayload => {
  if (!isRecord(value)) return false;
  return (
    value.event === "SEGMENT_COMMIT" &&
    typeof value.segmentId === "string" &&
    typeof value.turnId === "number" &&
    typeof value.index === "number" &&
    typeof value.text === "string" &&
    typeof value.audio === "string"
  );
};

const isSegmentDiagnosticsEvent = (value: unknown): value is SegmentDiagnosticsEventPayload => {
  if (!isRecord(value)) return false;
  return (
    value.event === "SEGMENT_DIAGNOSTICS" &&
    typeof value.turnId === "number" &&
    typeof value.transcriptLength === "number" &&
    typeof value.partialLength === "number" &&
    typeof value.pendingTextCount === "number" &&
    typeof value.pendingTextLength === "number" &&
    typeof value.pendingAudioBytes === "number" &&
    typeof value.audioChunkCount === "number" &&
    typeof value.audioChunkBytes === "number" &&
    typeof value.zeroAudioSegments === "number"
  );
};

const isModelTextEvent = (value: unknown): value is ModelTextEventPayload =>
  isPlainObject(value) && value.event === "MODEL_TEXT";

/**
 * TURN_COMMIT形式のイベントであるか簡易検査する。
 */
const isTurnCommitEvent = (value: unknown): value is TurnCommitEventPayload => {
  if (!isRecord(value)) return false;
  return (
    value.event === "TURN_COMMIT" &&
    typeof value.turnId === "number" &&
    typeof value.finalText === "string" &&
    typeof value.segmentCount === "number"
  );
};

const isServerCompleteAck = (value: unknown): boolean => {
  return (
    isRecord(value) &&
    value.mode === "serverComplete" &&
    value.ack === true
  );
};

/**
 * Base64文字列をArrayBufferへ変換する。
 * @throws Error Base64デコードが実装環境で利用できない場合
 */
const decodeBase64ToArrayBuffer = (base64: string): ArrayBuffer => {
  let binary: string;
  if (typeof atob === "function") {
    binary = atob(base64);
  } else {
    const maybeBuffer = (globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } };
    }).Buffer;
    if (maybeBuffer) {
      binary = maybeBuffer.from(base64, "base64").toString("binary");
    } else {
      throw new Error("Base64 decoding is not supported in this environment");
    }
  }
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const clampConfigValue = (value: number, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

const FEATURE_FLAG_BOOLEAN_KEYS: Array<keyof LiveAudioSessionFeatureFlags> = [
  "ttsPrefixDedupeEnabled",
  "ttsExclusivePlaybackEnabled",
  "playerFlushBargeInOnly",
  "playerFlushOnStartMicLegacy",
  "playerSupersedePrefixEnabled",
];

const FEATURE_FLAG_NUMBER_KEYS: Array<keyof LiveAudioSessionFeatureFlags> = [
  "ttsTextDebounceMs",
  "playerInitialQueueMs",
  "playerStartLeadMs",
  "playerTrimGraceMs",
  "playerSentencePauseMs",
  "playerArmSupersedeQuietMs",
  "playerCommitGuardMs",
];

const normalizeFeatureFlags = (
  raw: unknown
): Partial<LiveAudioSessionFeatureFlags> => {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of FEATURE_FLAG_BOOLEAN_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") {
        result[key] = true;
      } else if (value.toLowerCase() === "false") {
        result[key] = false;
      }
    }
  }

  for (const key of FEATURE_FLAG_NUMBER_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
    if (typeof numeric === "number" && Number.isFinite(numeric)) {
      result[key] = numeric;
    }
  }

  return result as Partial<LiveAudioSessionFeatureFlags>;
};

const readFeatureFlagsFromLocalStorage = (): Partial<LiveAudioSessionFeatureFlags> => {
  try {
    if (typeof localStorage === "undefined") return {};
    const stored = localStorage.getItem(LOCAL_STORAGE_FLAG_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return normalizeFeatureFlags(parsed);
  } catch (_error) {
    return {};
  }
};

const readFeatureFlagsFromWindow = (): Partial<LiveAudioSessionFeatureFlags> => {
  if (typeof window === "undefined") return {};
  const raw = window.__denwaFeatureFlags;
  if (!raw) return {};
  return normalizeFeatureFlags(raw);
};

const jsonDetector = new TextDecoder("utf-8", { fatal: true });


const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const nowMs = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

interface SentenceCandidate {
  readonly text: string;
  readonly hasTerminal: boolean;
}

interface SentenceEvaluationResult {
  readonly accepted: boolean;
  readonly normalizedText?: string;
  readonly reason?: string;
  readonly appendedTerminal?: boolean;
}

interface CaptionMetrics {
  shortTextFallbacks: number;
  audioFallbacks: number;
  finalTimeouts: number;
  textMissing: number;
  commits: number;
}

/**
 * 文末の句読点を遡って最後の文を抽出する。
 * 句読点が見つからない場合は全文を候補として返す。
 */
const extractLastSentenceCandidate = (value: string): SentenceCandidate | null => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const char = normalized[index];
    if (!char) continue;
    if (!SENTENCE_TERMINATOR_SET.has(char as (typeof TERMINAL_CHARACTERS)[number])) continue;

    let startIndex = index - 1;
    while (
      startIndex >= 0 &&
      !SENTENCE_TERMINATOR_SET.has(normalized[startIndex] as (typeof TERMINAL_CHARACTERS)[number])
    ) {
      startIndex -= 1;
    }
    const sentenceStart = startIndex < 0 ? 0 : startIndex + 1;
    let trimmedStart = sentenceStart;
    while (trimmedStart < normalized.length && normalized[trimmedStart] === " ") {
      trimmedStart += 1;
    }
    const candidate = normalized.slice(trimmedStart);
    const trimmedCandidate = candidate.trim();
    if (!trimmedCandidate) {
      return null;
    }
    return { text: trimmedCandidate, hasTerminal: true };
  }

  return { text: normalized, hasTerminal: false };
};

/**
 * 文候補が「十分な長さの確定文」として扱えるかを判定する。
 */
const evaluateSentenceCandidate = (candidate: SentenceCandidate): SentenceEvaluationResult => {
  const normalized = candidate.text.trim();
  if (!normalized) {
    return { accepted: false, reason: "empty" };
  }
  if (candidate.hasTerminal) {
    const plainVariant = normalized.replace(/[。．.？！?!…]+$/, "");
    const whitelisted = SHORT_TEXT_WHITELIST.has(normalized) || SHORT_TEXT_WHITELIST.has(plainVariant);
    if (!whitelisted && normalized.length < MIN_PUNCTUATED_SENTENCE_LENGTH) {
      return { accepted: false, reason: "terminal_too_short" };
    }
    return { accepted: true, normalizedText: normalized };
  }
  const plainWhitelisted = SHORT_TEXT_WHITELIST.has(normalized);
  if (!plainWhitelisted && normalized.length < MIN_UNPUNCTUATED_SENTENCE_LENGTH) {
    return { accepted: false, reason: "plain_too_short" };
  }
  if (plainWhitelisted) {
    return { accepted: true, normalizedText: `${normalized}。`, appendedTerminal: !candidate.hasTerminal };
  }
  return { accepted: true, normalizedText: `${normalized}。`, appendedTerminal: true };
};

/**
 * 画面表示用に最後の文だけを抽出する。
 */
const prepareCaptionForDisplay = (caption: string): string => {
  const candidate = extractLastSentenceCandidate(caption);
  if (!candidate) return caption;
  if (!candidate.hasTerminal) return caption;
  return candidate.text;
};

type VoiceLifecycleReason = "completed" | "cancelled" | "barge-in" | "disconnect";

type InterruptReason = "barge-in" | "manual" | "disconnect" | "legacy" | "panic";

type VoiceTimerEntry = { timer: number; stateKey: string };

interface CaptionPlaybackState {
  readonly key: string;
  readonly turnId: number;
  readonly seq: number;
  pendingText: string;
  debounceTimer: number | null;
  scheduledChars: number;
  committedChars: number;
  activeVoiceIds: Set<string>;
  nextVoiceSeq: number;
}

export class LiveAudioSession {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private modulesLoaded = false;
  private encoderNode: AudioWorkletNode | null = null;
  private playerNode: AudioWorkletNode | null = null;
  private playbackCursor = 0;
  private binaryStreamingActive = false;
  private lastBinaryChunkAt: number | null = null;
  private binaryReceptionSummary: BinaryReceptionSummary = this.createBinaryReceptionSummary();
  // 文確定処理の品質を追跡するためのメトリクス
  private captionMetricsTurn: CaptionMetrics = {
    shortTextFallbacks: 0,
    audioFallbacks: 0,
    finalTimeouts: 0,
    textMissing: 0,
    commits: 0,
  };
  private captionMetricsSession: CaptionMetrics = {
    shortTextFallbacks: 0,
    audioFallbacks: 0,
    finalTimeouts: 0,
    textMissing: 0,
    commits: 0,
  };
  private captionFallbackAlerted = false;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private playerInitFailed = false;

  private readonly flags: LiveAudioSessionFeatureFlags;
  private readonly captionStates = new Map<string, CaptionPlaybackState>();
  private readonly captionKeyOrder: string[] = [];
  private readonly voiceTimers = new Map<string, VoiceTimerEntry>();
  private readonly activeVoicesGlobal = new Set<string>();
  private readonly sessionId = LiveAudioSession.generateSessionId();
  private readonly flagSources: Record<keyof LiveAudioSessionFeatureFlags, "default" | "localStorage" | "window" | "options">;
  private readonly transcriptStore = new TranscriptStore();

  private lastCaptionText = "";
  private currentTurnId = 0;
  private currentSeq = 0;
  private currentCaptionKey: string;
  private pendingNewSequence = false;
  private lastFlushAt = 0;
  private controlFrameStreak = 0;
  private lastVoiceCount: number | null = null;
  private lastQueuedMs: number | null = null;
  private audioEpoch = 0;
  private lastSupersedeCaption = "";
  private playerInitialQueueMs = PLAYER_DEFAULT_INITIAL_QUEUE_MS;
  private playerStartLeadMs = PLAYER_DEFAULT_START_LEAD_MS;
  private playerTrimGraceMs = PLAYER_DEFAULT_TRIM_GRACE_MS;
  private playerSentencePauseMs = PLAYER_DEFAULT_SENTENCE_PAUSE_MS;
  private playerArmSupersedeQuietMs = PLAYER_DEFAULT_ARM_SUPERSEDE_QUIET_MS;
  private playerCommitGuardMs = PLAYER_DEFAULT_COMMIT_GUARD_MS;
  private playerHasOutput = false;
  private playerLastOutputAt: number | null = null;
  private lastSupersedeAt: number | null = null;
  private playerSupersedePrefixEnabled = DEFAULT_FEATURE_FLAGS.playerSupersedePrefixEnabled;
  private audioFallbackTimer: number | null = null;
  private audioFallbackKey: string | null = null;
  private audioFallbackEpoch: number | null = null;
  private audioFallbackArmed = false;
  private audioFallbackCommitted = false;
  private placeholderCaptionActive = false;
  private commitModeActive = false;
  private turnSegmentHistory: string[] = [];
  private postTurnResetPending = false;
  private finalCommitTimer: number | null = null;
  private finalCommitIssued = false;
  private finalCommitEpoch = 0;
  private generationCompleteObserved = false;
  private lastAudioBurstAt: number | null = null;
  private longestCaptionText = "";
  private captionCandidateHistory: string[] = [];

  constructor(
    private readonly url: string,
    private readonly callbacks: LiveSessionCallbacks = {},
    options: LiveAudioSessionOptions = {}
  ) {
    const storedFlags = readFeatureFlagsFromLocalStorage();
    const windowFlags = readFeatureFlagsFromWindow();
    const optionFlags = options.featureFlags ? normalizeFeatureFlags(options.featureFlags) : {};

    const mergedFlags: LiveAudioSessionFeatureFlags = {
      ...DEFAULT_FEATURE_FLAGS,
      ...storedFlags,
      ...windowFlags,
      ...optionFlags,
    };

    const sources: Record<keyof LiveAudioSessionFeatureFlags, "default" | "localStorage" | "window" | "options"> = {
      ttsPrefixDedupeEnabled: "default",
      ttsTextDebounceMs: "default",
      ttsExclusivePlaybackEnabled: "default",
      playerFlushBargeInOnly: "default",
      playerFlushOnStartMicLegacy: "default",
      playerInitialQueueMs: "default",
      playerStartLeadMs: "default",
      playerTrimGraceMs: "default",
      playerSentencePauseMs: "default",
      playerArmSupersedeQuietMs: "default",
      playerCommitGuardMs: "default",
      playerSupersedePrefixEnabled: "default",
    };

    const assignSources = (
      flagSet: Partial<LiveAudioSessionFeatureFlags>,
      source: "localStorage" | "window" | "options"
    ) => {
      for (const key of FEATURE_FLAG_BOOLEAN_KEYS) {
        if (flagSet[key] !== undefined) {
          sources[key] = source;
        }
      }
      for (const key of FEATURE_FLAG_NUMBER_KEYS) {
        if (flagSet[key] !== undefined) {
          sources[key] = source;
        }
      }
    };

    assignSources(storedFlags, "localStorage");
    assignSources(windowFlags, "window");
    assignSources(optionFlags, "options");

    this.flagSources = sources;
    this.flags = mergedFlags;
    this.playerSupersedePrefixEnabled = mergedFlags.playerSupersedePrefixEnabled ?? false;
    this.currentCaptionKey = this.captionKey(this.currentTurnId, this.currentSeq);
    const initialState = this.createCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
    this.registerCaptionState(initialState);
    this.updatePlayerConfig(true);
    this.resetFinalCommitState(this.audioEpoch);
    this.callbacks.onTranscript?.(this.transcriptStore.snapshot());

    const flushPolicyLabel = this.flags.playerFlushBargeInOnly ? "barge-in-only" : "legacy";
    const appliedFlags = {
      ttsPrefixDedupeEnabled: this.flags.ttsPrefixDedupeEnabled,
      ttsTextDebounceMs: this.flags.ttsTextDebounceMs,
      ttsExclusivePlaybackEnabled: this.flags.ttsExclusivePlaybackEnabled,
      playerFlushPolicy: flushPolicyLabel,
      playerFlushOnStartMicLegacy: this.flags.playerFlushOnStartMicLegacy,
      playerInitialQueueMs: this.playerInitialQueueMs,
      playerStartLeadMs: this.playerStartLeadMs,
      playerTrimGraceMs: this.playerTrimGraceMs,
      playerSentencePauseMs: this.playerSentencePauseMs,
      playerArmSupersedeQuietMs: this.playerArmSupersedeQuietMs,
      playerCommitGuardMs: this.playerCommitGuardMs,
      playerSupersedePrefixEnabled: this.playerSupersedePrefixEnabled,
      sources: this.flagSources,
    };
    this.log(`[flags] ${JSON.stringify(appliedFlags)}`);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.log("[ws] already connected");
        return;
      }
      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.log("[ws] connection in progress");
        return new Promise((resolve) => {
          const check = () => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              resolve();
            } else {
              requestAnimationFrame(check);
            }
          };
          check();
        });
      }
    }

    this.log(`[ws] connecting ${this.url}`);

    await new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";

        const handleError = () => {
          ws.removeEventListener("open", handleOpen);
          reject(new Error("WebSocket connection failed"));
        };

        const handleOpen = () => {
          ws.removeEventListener("error", handleError);
          this.attachSocket(ws);
          this.log("[ws] open");
          this.callbacks.onOpen?.();
          resolve();
        };

        ws.addEventListener("error", handleError, { once: true });
        ws.addEventListener("open", handleOpen, { once: true });
      } catch (error) {
        reject(error);
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
      this.log(`[ws] error: ${message}`);
      throw error;
    });
  }

  disconnect(): void {
    this.log("[ws] disconnect requested");
    this.stopMic();
    this.playbackCursor = 0;
    this.cancelAllVoices("disconnect");
    this.supersedeAudio("disconnect", undefined, { cancelVoices: false });
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, "client_request");
        }
      } catch (error) {
        this.log(`[ws] close failed: ${(error as Error).message}`);
      }
      this.ws = null;
    }
    this.resetCaptionStates();
  }

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("[send] skipped: socket not open");
      return;
    }
    const payload = { realtimeInput: { text } };
    this.ws.send(JSON.stringify(payload));
    const preview =
      text.length <= TEXT_PREVIEW_LENGTH ? text : `${text.slice(0, TEXT_PREVIEW_LENGTH)}…`;
    this.log(`[send:text] ${preview}`);
  }

  async startMic(): Promise<MediaStream> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const context = await this.ensureAudioContext();
    const encoderNode = await this.ensureEncoderNode(context);

    if (this.micStream) {
      this.log("[audio] microphone already active");
      return this.micStream;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const source = context.createMediaStreamSource(stream);
    source.connect(encoderNode);

    if (this.flags.playerFlushOnStartMicLegacy) {
      this.flushPlayerBuffer("start_mic_legacy", { queuedMs: this.lastQueuedMs ?? undefined });
    }

    this.micStream = stream;
    this.micSource = source;
    this.log("[audio] microphone streaming started");
    return stream;
  }

  stopMic(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (error) {
        this.log(`[audio] source disconnect failed: ${(error as Error).message}`);
      }
      this.micSource = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
      this.log("[audio] microphone streaming stopped");
    }
  }

  interruptPlayback(reason: InterruptReason = "manual"): void {
    if (this.flags.playerFlushBargeInOnly && !(reason === "barge-in" || reason === "panic")) {
      this.log(`[player] flush suppressed reason=${reason}`);
      return;
    }

    if (reason === "barge-in") {
      // マイクが有効でない場合は、VAD誤検知による再生割込みを抑止
      if (!this.micStream) {
        this.log("[player] barge-in ignored (mic inactive)");
        return;
      }
      this.cancelAllVoices("barge-in");
      const soft = this.lastQueuedMs !== null && this.lastQueuedMs <= SOFT_SUPERSEDE_THRESHOLD_MS;
      this.supersedeAudio("barge_in", undefined, { soft, cancelVoices: false });
      return;
    }

    this.flushPlayerBuffer(reason, { queuedMs: this.lastQueuedMs ?? undefined });
  }

  async getAudioContext(): Promise<AudioContext> {
    return this.ensureAudioContext();
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  private attachSocket(ws: WebSocket) {
    this.ws = ws;
    this.binaryStreamingActive = false;
    this.lastBinaryChunkAt = null;
    ws.onmessage = (event) => this.handleMessage(event);
    ws.onclose = (event) => {
      this.log(`[ws] close code=${event.code} reason=${event.reason || "(no reason)"}`);
      this.stopMic();
      this.playbackCursor = 0;
      this.cancelAllVoices("disconnect");
      this.supersedeAudio("disconnect", undefined, { cancelVoices: false });
      this.callbacks.onClose?.(event);
      this.ws = null;
      this.resetCaptionStates();
    };
    ws.onerror = () => {
      this.callbacks.onError?.("WebSocket runtime error");
      this.log("[ws] runtime error");
    };
  }

  private handleMessage(event: MessageEvent) {
    const { data } = event;
    if (typeof data === "string") {
      const preview =
        data.length <= TEXT_PREVIEW_LENGTH ? data : `${data.slice(0, TEXT_PREVIEW_LENGTH)}…`;
      this.log(`[recv:text] ${preview}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        this.log(`[recv:parse-error] ${(error as Error).message}`);
        return;
      }

      if (isServerCompleteAck(parsed)) {
        this.log(`[recv:server-complete-ack] ${data}`);
        this.commitModeActive = true;
        this.clearFinalCommitTimer();
        this.clearAudioFallback();
        this.callbacks.onLog?.(`[session=${this.sessionId}] serverCompleteAck`);
        this.callbacks.onOpen?.();
        return;
      }

      if (isSegmentCommitEvent(parsed)) {
        this.handleSegmentCommitEvent(parsed);
        return;
      }

      if (isTurnCommitEvent(parsed)) {
        this.handleTurnCommitEvent(parsed);
        return;
      }

      if (isSegmentDiagnosticsEvent(parsed)) {
        this.handleSegmentDiagnosticsEvent(parsed);
        return;
      }

      if (isModelTextEvent(parsed)) {
        this.handleModelTextEvent(parsed);
        return;
      }

      if (this.detectGenerationComplete(parsed)) {
        this.handleGenerationComplete();
      }

      const caption = extractCaption(parsed);
      if (caption !== null) {
        this.processCaption(caption);
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.log(`[recv:binary] ${data.byteLength} bytes`);
      this.binaryStreamingActive = true;
      this.lastBinaryChunkAt = nowMs();
      this.recordBinaryReception(data.byteLength, "ws");
      void this.pushToPlayer(data.slice(0));
      return;
    }

    if (data instanceof Blob) {
      this.log(`[recv:blob] size=${data.size}`);
      data
        .arrayBuffer()
        .then((buffer) => {
          this.binaryStreamingActive = true;
          this.lastBinaryChunkAt = nowMs();
          this.recordBinaryReception(buffer.byteLength, "blob");
          return this.pushToPlayer(buffer);
        })
        .catch((error) => {
          this.log(`[recv:blob-error] ${(error as Error).message}`);
        });
      return;
    }

    this.log(`[recv:unknown] ${Object.prototype.toString.call(data)}`);
  }

  /**
   * SEGMENT_COMMITイベントを処理し、音声プレイヤーおよび字幕を更新する。
   */
  private handleSegmentCommitEvent(event: SegmentCommitEventPayload): void {
    if (this.postTurnResetPending) {
      this.resetFinalCommitState(this.audioEpoch);
      this.postTurnResetPending = false;
      this.turnSegmentHistory = [];
    }

    this.commitModeActive = true;
    this.placeholderCaptionActive = false;
    this.clearFinalCommitTimer();
    this.clearAudioFallback();
    this.turnSegmentHistory.push(event.text);
    this.lastCaptionText = event.text;
    this.longestCaptionText = event.text;
    this.captionCandidateHistory = [];
    this.generationCompleteObserved = false;

    const nominalDuration = event.nominalDurationMs ?? event.durationMs;
    this.log(
      `[commit:segment] turn=${event.turnId} idx=${event.index} id=${event.segmentId} audio=${event.audioBytes}B duration=${nominalDuration}ms`
    );

    const streamingFresh =
      this.binaryStreamingActive &&
      this.lastBinaryChunkAt !== null &&
      nowMs() - this.lastBinaryChunkAt <= STREAMING_STALE_THRESHOLD_MS;

    if (streamingFresh) {
      // 直近にバイナリ音声を受信している場合は重複再生を避ける。
      this.log(`[commit:segment] skip_audio_replay stream_active=1`);
    } else {
      if (this.binaryStreamingActive && !streamingFresh) {
        // バイナリ受信が途絶したと判断したのでフェイルセーフとしてBase64音声を復帰。
        this.log(`[commit:segment] stream_inactive_fallback`);
        this.flushBinaryReceptionSummary("fallback");
        this.binaryStreamingActive = false;
        this.lastBinaryChunkAt = null;
      }
      try {
        const decoded = decodeBase64ToArrayBuffer(event.audio);
        const transferable = decoded.slice(0);
        this.recordBinaryReception(transferable.byteLength, "segment_fallback");
        void this.pushToPlayer(transferable);
      } catch (error) {
        this.log(`[commit:segment-error] ${(error as Error).message}`);
      }
    }

    const transcriptSnapshot = this.transcriptStore.commitSegment({
      segmentId: event.segmentId,
      turnId: event.turnId,
      index: event.index,
      text: event.text,
      durationMs: event.durationMs,
      nominalDurationMs: nominalDuration,
    });
    const latestSentence = transcriptSnapshot.latestSentence;
    if (latestSentence) {
      this.log(
        `[transcript:segment] turn=${latestSentence.turnId} idx=${latestSentence.index} start_ms=${latestSentence.startMs} end_ms=${latestSentence.endMs}`
      );
    }
    this.callbacks.onTranscript?.(transcriptSnapshot);

    this.callbacks.onCaption?.(event.text);
  }

  /**
   * TURN_COMMITイベントを処理し、最終文を確定させる。
   */
  private handleTurnCommitEvent(event: TurnCommitEventPayload): void {
    this.flushBinaryReceptionSummary("turn");
    this.commitModeActive = true;
    this.finalCommitIssued = true;
    this.finalCommitEpoch = this.audioEpoch;
    this.clearFinalCommitTimer();
    this.clearAudioFallback();

    const preview =
      event.finalText.length <= 32 ? event.finalText : `${event.finalText.slice(0, 32)}…`;
    this.log(
      `[commit:turn] turn=${event.turnId} segments=${event.segmentCount} text=${preview} length=${event.finalText.length}`
    );

    const transcriptSnapshot = this.transcriptStore.finalizeTurn({
      turnId: event.turnId,
      finalText: event.finalText,
      segmentCount: event.segmentCount,
      fallbackText: this.audioFallbackCommitted ? AUDIO_ONLY_LABEL : null,
    });
    const serializedFinalText = JSON.stringify(event.finalText);
    this.log(
      `[raw_final_transcript] turn=${event.turnId} length=${event.finalText.length} text=${serializedFinalText}`
    );
    this.callbacks.onTranscript?.(transcriptSnapshot);

    const trimmed = event.finalText.trim();
    if (trimmed.length === 0) {
      this.placeholderCaptionActive = true;
      this.callbacks.onCaption?.(CAPTION_PLACEHOLDER);
      this.lastCaptionText = CAPTION_PLACEHOLDER;
      this.longestCaptionText = CAPTION_PLACEHOLDER;
    } else {
      this.placeholderCaptionActive = false;
      this.callbacks.onCaption?.(event.finalText);
      this.lastCaptionText = event.finalText;
      this.longestCaptionText = event.finalText;
    }
    this.captionCandidateHistory = [];

    const isAudioOnly = trimmed.length === 0;
    this.audioFallbackCommitted = isAudioOnly;
    if (isAudioOnly) {
      this.incrementCaptionMetric("textMissing");
    }
    this.incrementCaptionMetric("commits");
    this.logCaptionMetrics("turn_commit", event.finalText.length, isAudioOnly);

    this.turnSegmentHistory = [];
    this.postTurnResetPending = true;
  }

  private handleSegmentDiagnosticsEvent(event: SegmentDiagnosticsEventPayload): void {
    const parts: string[] = [
      `turn=${event.turnId}`,
      `transcript=${event.transcriptLength}`,
      `partial=${event.partialLength}`,
      `pending_text=${event.pendingTextLength}`,
      `pending_audio=${event.pendingAudioBytes}`,
      `audio_chunks=${event.audioChunkCount}`,
      `audio_bytes=${event.audioChunkBytes}`,
      `zero_segments=${event.zeroAudioSegments}`,
    ];
    if (typeof event.audioChunkMin === "number") {
      parts.push(`audio_min=${event.audioChunkMin}`);
    }
    if (typeof event.audioChunkMax === "number") {
      parts.push(`audio_max=${event.audioChunkMax}`);
    }
    this.log(`[diag:segment] ${parts.join(" ")}`);
  }

  /**
   * モデルの発話テキストイベントを処理
   */
  private handleModelTextEvent(event: ModelTextEventPayload): void {
    this.log(
      `[model.text] text="${event.text}" complete=${event.isComplete} turnId=${event.turnId ?? 'unknown'}`
    );
    
    // コールバックでモデルのテキストを通知
    this.callbacks.onModelText?.(event.text, event.isComplete, event.turnId);
  }

  private async pushToPlayer(buffer: ArrayBuffer): Promise<void> {
    const snapshotEpoch = this.audioEpoch;
    const context = await this.ensureAudioContext();
    if (snapshotEpoch !== this.audioEpoch) {
      this.log(`[player:skip-stale] reason=epoch_changed snapshot=${snapshotEpoch} current=${this.audioEpoch}`);
      return;
    }

    const bytes = new Uint8Array(buffer);
    const controlText = CONTROL_DETECTION_ENABLED ? this.detectControlFrame(bytes) : null;

    if (controlText) {
      this.controlFrameStreak += 1;
      if (this.controlFrameStreak >= 2) {
        this.log(`[player:skip-control] streak=${this.controlFrameStreak} bytes=${bytes.byteLength}`);
        return;
      }
      this.log(`[player:control-detected] streak=${this.controlFrameStreak}`);
    } else if (this.controlFrameStreak > 0) {
      this.controlFrameStreak = 0;
    }

    const sampleCount = Math.floor(buffer.byteLength / 2);
    if (sampleCount === 0) {
      this.log(`[player:enqueue-empty] epoch=${snapshotEpoch}`);
      await this.enqueueFallbackClip(context, buffer, bytes, snapshotEpoch);
      this.armAudioFallback(this.currentCaptionKey);
      this.markAudioBurst();
      return;
    }

    const player = await this.ensurePlayerNode(context);
    if (snapshotEpoch !== this.audioEpoch) {
      this.log(`[player:skip-stale] reason=epoch_changed snapshot=${snapshotEpoch} current=${this.audioEpoch}`);
      return;
    }
    if (player) {
      this.log(`[audio:burst] t=${nowMs().toFixed(1)} bytes=${buffer.byteLength}`);
      this.log(`[player:enqueue-ok] bytes=${buffer.byteLength} epoch=${snapshotEpoch}`);
      player.port.postMessage({ type: "push", buffer, epoch: snapshotEpoch }, [buffer]);
      this.markAudioBurst();
      this.armAudioFallback(this.currentCaptionKey);
      return;
    }

    this.log(`[player:enqueue-fallback] reason=no_player bytes=${buffer.byteLength}`);
    await this.enqueueFallbackClip(context, buffer, bytes, snapshotEpoch);
    this.markAudioBurst();
    this.armAudioFallback(this.currentCaptionKey);
  }

  private detectControlFrame(bytes: Uint8Array): string | null {
    if (bytes.length === 0 || bytes.length > CONTROL_MAX_BYTES) return null;

    let text: string;
    try {
      text = jsonDetector.decode(bytes);
    } catch (_error) {
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed) return null;
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

    let asciiCount = 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const code = trimmed.charCodeAt(i);
      if (code >= 0x20 && code <= 0x7e) {
        asciiCount += 1;
      }
    }
    const asciiRatio = asciiCount / Math.max(1, trimmed.length);
    if (asciiRatio < 0.9) return null;

    try {
      JSON.parse(trimmed);
    } catch (_error) {
      return null;
    }

    return trimmed;
  }

  private detectGenerationComplete(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const record = payload as Record<string, unknown>;
    const direct = record.generationComplete;
    if (direct === true) return true;
    const serverContent = record.serverContent;
    if (serverContent && typeof serverContent === "object") {
      const flag = (serverContent as Record<string, unknown>).generationComplete;
      if (flag === true) {
        return true;
      }
    }
    return false;
  }

  private handleGenerationComplete(): void {
    if (this.commitModeActive) {
      if (!this.generationCompleteObserved) {
        this.generationCompleteObserved = true;
        this.log(`[caption:event] generation_complete (commit_mode)`);
      }
      return;
    }
    if (!this.generationCompleteObserved) {
      this.generationCompleteObserved = true;
      this.log(`[caption:event] generation_complete epoch=${this.audioEpoch}`);
    }
    this.commitFinalCaption("generation_complete");
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ latencyHint: "interactive" });
      this.log(`[audio] context_created sample_rate=${this.audioContext.sampleRate}`);
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    await this.ensureAudioModules(this.audioContext);
    return this.audioContext;
  }

  private async ensureAudioModules(context: AudioContext): Promise<void> {
    if (this.modulesLoaded) return;
    await context.audioWorklet.addModule(
      new URL("../audio-worklets/encoder.worklet.js", import.meta.url)
    );
    await context.audioWorklet.addModule(
      new URL("../audio-worklets/player.worklet.js", import.meta.url)
    );
    this.modulesLoaded = true;
  }

  private async ensureEncoderNode(context: AudioContext): Promise<AudioWorkletNode> {
    if (this.encoderNode) return this.encoderNode;
    const node = new AudioWorkletNode(context, "pcm16-encoder", { numberOfOutputs: 0 });
    node.port.onmessage = (event) => {
      const { data } = event;
      if (!data || data.type !== "chunk" || !data.buffer) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        const base64 = arrayBufferToBase64(data.buffer as ArrayBuffer);
        const payload = {
          realtimeInput: {
            mimeType: AUDIO_MIME,
            data: base64,
          },
        };
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.log(`[audio] encode send failed: ${(error as Error).message}`);
      }
    };
    this.encoderNode = node;
    return node;
  }

  private async ensurePlayerNode(context: AudioContext): Promise<AudioWorkletNode | null> {
    if (this.playerInitFailed) return null;
    if (this.playerNode) {
      this.updatePlayerConfig();
      return this.playerNode;
    }

    try {
      const node = new AudioWorkletNode(context, "pcm24-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.connect(context.destination);
      this.playerHasOutput = false;
      this.playerLastOutputAt = null;
      this.lastSupersedeAt = null;
      node.port.onmessage = (event) => {
        const { data } = event;
        if (!data || typeof data !== "object") return;
        if (data.type === "context_info" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const sampleRate = typeof detail.sampleRate === "number" ? detail.sampleRate : undefined;
          const inputSampleRate =
            typeof detail.inputSampleRate === "number" ? detail.inputSampleRate : undefined;
          const resampleRatio =
            typeof detail.resampleRatio === "number" ? detail.resampleRatio : undefined;
          const fadeWindowMs = typeof detail.fadeWindowMs === "number" ? detail.fadeWindowMs : undefined;
          const crossfadeMinMs =
            typeof detail.crossfadeMinMs === "number" ? detail.crossfadeMinMs : undefined;
          const logs: string[] = [];
          if (sampleRate !== undefined) logs.push(`sample_rate=${sampleRate}`);
          if (inputSampleRate !== undefined) logs.push(`input_rate=${inputSampleRate}`);
          if (resampleRatio !== undefined) logs.push(`resample_ratio=${resampleRatio.toFixed(6)}`);
          if (fadeWindowMs !== undefined) logs.push(`edge_window_ms=${fadeWindowMs}`);
          if (crossfadeMinMs !== undefined) logs.push(`crossfade_min_ms=${crossfadeMinMs}`);
          this.log(`[player:context] ${logs.join(" ")}`);
          return;
        }
        if (data.type === "chunk_metrics" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const samples = typeof detail.samples === "number" ? detail.samples : undefined;
          const peak = typeof detail.peak === "number" ? detail.peak : undefined;
          const peakDb = typeof detail.peakDb === "number" ? detail.peakDb : undefined;
          const resampleRatio =
            typeof detail.resampleRatio === "number" ? detail.resampleRatio : undefined;
          const sampleRate = typeof detail.sampleRate === "number" ? detail.sampleRate : undefined;
          const equalPowerFadeMs =
            typeof detail.equalPowerFadeMs === "number" ? detail.equalPowerFadeMs : undefined;
          const parts: string[] = [];
          if (samples !== undefined) parts.push(`samples=${samples}`);
          if (peak !== undefined) parts.push(`peak=${peak.toFixed(4)}`);
          if (peakDb !== undefined) parts.push(`peak_db=${peakDb.toFixed(1)}`);
          if (resampleRatio !== undefined) parts.push(`resample_ratio=${resampleRatio.toFixed(6)}`);
          if (sampleRate !== undefined) parts.push(`context_rate=${sampleRate}`);
          if (equalPowerFadeMs !== undefined) parts.push(`equal_power_fade_ms=${equalPowerFadeMs.toFixed(2)}`);
          this.log(`[player:chunk] ${parts.join(" ")}`);
          return;
        }
        if (data.type === "queue_low" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const queuedMs = typeof detail.queuedMs === "number" ? detail.queuedMs : undefined;
          const samples = typeof detail.samples === "number" ? detail.samples : undefined;
          const epoch = typeof detail.epoch === "number" ? detail.epoch : undefined;
          const queuedLabel = queuedMs !== undefined ? queuedMs.toFixed(1) : "n/a";
          const sampleLabel = samples !== undefined ? samples : "n/a";
          const epochLabel = epoch !== undefined ? epoch : "n/a";
          this.log(`[player:queue-low] queued_ms=${queuedLabel} samples=${sampleLabel} epoch=${epochLabel}`);
          return;
        }
        if (data.type === "underrun" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const epoch = typeof detail.epoch === "number" ? detail.epoch : undefined;
          const renderTimeMs =
            typeof detail.renderTimeMs === "number" ? detail.renderTimeMs : undefined;
          const epochLabel = epoch !== undefined ? epoch : "n/a";
          const renderLabel = renderTimeMs !== undefined ? renderTimeMs.toFixed(1) : "n/a";
          this.log(`[player:underrun] epoch=${epochLabel} render_ms=${renderLabel}`);
          return;
        }
        if (data.type === "diagnostic" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const queuedMs = typeof detail.queuedMs === "number" ? detail.queuedMs : undefined;
          const voiceCountValue = typeof detail.voiceCount === "number" ? detail.voiceCount : undefined;
          const availableSamples = typeof detail.availableSamples === "number" ? detail.availableSamples : undefined;
          const epoch = typeof detail.epoch === "number" ? detail.epoch : undefined;
          const droppedSinceLast = typeof detail.droppedSinceLast === "number" ? detail.droppedSinceLast : 0;
          const hasPlayed = detail.hasPlayed === true;
          const firstPlaybackAt = typeof detail.firstPlaybackAt === "number" ? detail.firstPlaybackAt : undefined;
          const trimGraceAccepts = typeof detail.trimGraceAccepts === "number" ? detail.trimGraceAccepts : undefined;
          const startLeadMsDetail = typeof detail.startLeadMs === "number" ? detail.startLeadMs : undefined;
          const initialQueueMsDetail = typeof detail.initialQueueMs === "number" ? detail.initialQueueMs : undefined;
          const trimGraceMsDetail = typeof detail.trimGraceMs === "number" ? detail.trimGraceMs : undefined;
          const firstPlaybackQueueMs = typeof detail.firstPlaybackQueueMs === "number" ? detail.firstPlaybackQueueMs : undefined;
          const firstPlaybackLeadMs = typeof detail.firstPlaybackLeadMs === "number" ? detail.firstPlaybackLeadMs : undefined;

          if (queuedMs !== undefined) {
            this.lastQueuedMs = queuedMs;
          }

          if (voiceCountValue !== undefined) {
            if (voiceCountValue > 1 && voiceCountValue !== this.lastVoiceCount) {
              const queued = queuedMs !== undefined ? queuedMs.toFixed(1) : "n/a";
              this.log(`[player:overlap] voice_count=${voiceCountValue} queued_ms=${queued}`);
            }
            this.lastVoiceCount = voiceCountValue;
          }

          if (droppedSinceLast > 0 && epoch !== undefined) {
            this.log(`[player:supersede] dropped=${droppedSinceLast} epoch=${epoch}`);
          }

          const queued = queuedMs !== undefined ? queuedMs.toFixed(1) : "n/a";
          const samples = availableSamples !== undefined ? availableSamples : "n/a";
          const parts = [`queued_ms=${queued}`, `samples=${samples}`, `voice=${voiceCountValue ?? "n/a"}`];
          if (initialQueueMsDetail !== undefined) parts.push(`initialQueueMs=${initialQueueMsDetail}`);
          if (startLeadMsDetail !== undefined) parts.push(`startLeadMs=${startLeadMsDetail}`);
          if (trimGraceMsDetail !== undefined) parts.push(`trimGraceMs=${trimGraceMsDetail}`);
          if (firstPlaybackQueueMs !== undefined) parts.push(`firstQueueMs=${firstPlaybackQueueMs.toFixed(1)}`);
          if (firstPlaybackLeadMs !== undefined) parts.push(`firstLeadMs=${firstPlaybackLeadMs}`);
          if (firstPlaybackAt !== undefined) parts.push(`firstPlaybackAt=${firstPlaybackAt.toFixed(1)}`);
          if (hasPlayed) parts.push("hasPlayed=1");
          if (hasPlayed && !this.playerHasOutput) {
            this.playerHasOutput = true;
            this.playerLastOutputAt = nowMs();
          }
          if (trimGraceAccepts !== undefined && trimGraceAccepts > 0) parts.push(`trimGraceAccepts=${trimGraceAccepts}`);
          this.log(`[player:ring] ${parts.join(" ")}`);
          return;
        }
        if (data.type === "join_metrics" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const xfadeMs = typeof detail.xfadeMs === "number" ? detail.xfadeMs : undefined;
          const rmsBefore = typeof detail.rmsBefore === "number" ? detail.rmsBefore : undefined;
          const rmsAfter = typeof detail.rmsAfter === "number" ? detail.rmsAfter : undefined;
          const rmsDelta = typeof detail.rmsDelta === "number" ? detail.rmsDelta : undefined;
          const logs: string[] = [];
          if (xfadeMs !== undefined) logs.push(`xfade_ms=${xfadeMs.toFixed(1)}`);
          if (rmsBefore !== undefined) logs.push(`rms_before=${rmsBefore.toFixed(6)}`);
          if (rmsAfter !== undefined) logs.push(`rms_after=${rmsAfter.toFixed(6)}`);
          if (rmsAfter !== undefined && rmsBefore !== undefined) {
            const delta = rmsDelta !== undefined ? rmsDelta : rmsAfter - rmsBefore;
            logs.push(`rms_delta=${delta.toFixed(6)}`);
          }
          this.log(`[player:join] ${logs.join(" ")}`);
          return;
        }
        if (data.type === "pause_inserted" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const pauseMs = typeof detail.ms === "number" ? detail.ms : undefined;
          const reason = typeof detail.reason === "string" ? detail.reason : "unknown";
          if (pauseMs !== undefined && pauseMs > 0) {
            this.log(`[pause.insert] ms=${pauseMs} reason=${reason}`);
          }
          return;
        }
        if (data.type === "arm_blocked" && data.detail) {
          const detail = data.detail as Record<string, unknown>;
          const sinceSupersedeMs = typeof detail.sinceSupersedeMs === "number" ? detail.sinceSupersedeMs : undefined;
          const requiredMs = typeof detail.requiredMs === "number" ? detail.requiredMs : undefined;
          const queuedMs = typeof detail.queuedMs === "number" ? detail.queuedMs : undefined;
          const sinceLabel = sinceSupersedeMs !== undefined ? sinceSupersedeMs.toFixed(1) : "n/a";
          const requiredLabel = requiredMs !== undefined ? requiredMs.toFixed(1) : "n/a";
          const queuedLabel = queuedMs !== undefined ? queuedMs.toFixed(1) : "n/a";
          this.log(
            `[player:arm-blocked] since_supersede_ms=${sinceLabel} required_ms=${requiredLabel} queued_ms=${queuedLabel}`
          );
          return;
        }
        if (data.type === "buffer_trimmed" && data.detail) {
          const { droppedMs } = data.detail as Record<string, number>;
          if (typeof droppedMs === "number") {
            this.log(`[player:trim] dropped_ms=${droppedMs.toFixed(1)}`);
          }
          return;
        }
        if (data.type === "playback_armed") {
          this.log("[player] playback armed");
          return;
        }
      };
      this.playerNode = node;
      this.updatePlayerConfig(true);
      return node;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[player] init failed: ${message}`);
      this.playerInitFailed = true;
      return null;
    }
  }

  private flushPlayerBuffer(reason: string, options: { guardMs?: number; queuedMs?: number } = {}): void {
    const { guardMs = 0, queuedMs } = options;
    const now = nowMs();
    if (guardMs > 0 && now - this.lastFlushAt < guardMs) {
      this.log(
        `[player:flush-skipped] reason=${reason} since_last_ms=${(now - this.lastFlushAt).toFixed(1)}`
      );
      return;
    }

    this.lastFlushAt = now;
    const tail = queuedMs !== undefined ? ` queued_ms_before=${queuedMs.toFixed(1)}` : "";
    this.log(`[player:flush] reason=${reason}${tail}`);
    this.clearAudioFallback();

    if (this.playerNode) {
      try {
        this.playerNode.port.postMessage({ type: "flush" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[player] flush failed: ${message}`);
      }
    }

    this.playbackCursor = 0;
    this.playerHasOutput = false;
    this.playerLastOutputAt = null;
  }

  private createBinaryReceptionSummary(): BinaryReceptionSummary {
    const now = nowMs();
    return {
      chunkCount: 0,
      totalBytes: 0,
      minBytes: Number.POSITIVE_INFINITY,
      maxBytes: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      lastFlushAt: now,
      originCounts: {
        ws: 0,
        blob: 0,
        segment_fallback: 0,
      },
      originBytes: {
        ws: 0,
        blob: 0,
        segment_fallback: 0,
      },
    };
  }

  private recordBinaryReception(bytes: number, origin: BinaryReceptionOrigin): void {
    if (bytes <= 0 || !Number.isFinite(bytes)) return;
    const summary = this.binaryReceptionSummary;
    const now = nowMs();
    if (summary.chunkCount === 0) {
      summary.firstChunkAt = now;
      summary.minBytes = bytes;
      summary.maxBytes = bytes;
    } else {
      summary.minBytes = Math.min(summary.minBytes, bytes);
      summary.maxBytes = Math.max(summary.maxBytes, bytes);
    }
    summary.chunkCount += 1;
    summary.totalBytes += bytes;
    summary.lastChunkAt = now;
    summary.originCounts[origin] += 1;
    summary.originBytes[origin] += bytes;

    const flushByChunk = summary.chunkCount >= BINARY_RECV_SUMMARY_CHUNK_LIMIT;
    const flushByInterval = summary.lastChunkAt - summary.lastFlushAt >= BINARY_RECV_SUMMARY_INTERVAL_MS;
    if (flushByChunk || flushByInterval) {
      this.flushBinaryReceptionSummary(flushByChunk ? "chunk" : "interval");
    }
  }

  private flushBinaryReceptionSummary(reason: BinaryReceptionSummaryReason): void {
    const summary = this.binaryReceptionSummary;
    if (summary.chunkCount === 0) {
      summary.lastFlushAt = nowMs();
      return;
    }

    const now = nowMs();
    const spanMs = summary.lastChunkAt > summary.firstChunkAt ? summary.lastChunkAt - summary.firstChunkAt : 0;
    const averageBytes = Math.round(summary.totalBytes / summary.chunkCount);
    const minBytes = summary.minBytes === Number.POSITIVE_INFINITY ? 0 : summary.minBytes;
    const originCounts = summary.originCounts;
    const originBytes = summary.originBytes;

    this.log(
      `[binary:summary] reason=${reason} chunks=${summary.chunkCount} bytes=${summary.totalBytes} avg=${averageBytes} min=${minBytes} max=${summary.maxBytes} span_ms=${spanMs} origins=${JSON.stringify(
        originCounts
      )} origin_bytes=${JSON.stringify(originBytes)}`
    );

    this.binaryReceptionSummary = this.createBinaryReceptionSummary();
    this.binaryReceptionSummary.lastFlushAt = now;
  }

  private processCaption(caption: string): void {
    this.log(
      `[cap:update] t=${nowMs().toFixed(1)} len=${caption.length} terminal=${
        TERMINAL_PUNCTUATION.test(caption.trim()) ? 1 : 0
      }`
    );
    const guarded = this.applyCaptionGuard(caption);
    if (guarded === null) {
      return;
    }
    caption = guarded;
    const trimmed = caption.trim();
    if (trimmed.length > this.longestCaptionText.trim().length) {
      this.longestCaptionText = caption;
    }
    const longestTrimmed = this.longestCaptionText.trim();
    const displaySource =
      longestTrimmed.length > trimmed.length ||
      (longestTrimmed.length === trimmed.length && this.longestCaptionText !== caption)
        ? this.longestCaptionText
        : caption;
    const displayCaption = prepareCaptionForDisplay(displaySource);
    if (displayCaption !== displaySource) {
      this.log(
        `[cap:display-trim] raw_len=${displaySource.length} display_len=${displayCaption.length}`
      );
    }
    this.callbacks.onCaption?.(displayCaption);
    if (displayCaption.trim().length > 0) {
      const lastCandidate = this.captionCandidateHistory[this.captionCandidateHistory.length - 1];
      if (lastCandidate !== displayCaption) {
        this.captionCandidateHistory.push(displayCaption);
        if (this.captionCandidateHistory.length > 16) {
          this.captionCandidateHistory.shift();
        }
      }
    }
    if (trimmed.length > 0 || longestTrimmed.length > 0) {
      this.clearAudioFallback();
    }
    if (!this.flags.ttsPrefixDedupeEnabled) {
      const state = this.ensureCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
      state.pendingText = caption;
      state.committedChars = caption.length;
      state.scheduledChars = caption.length;
      this.lastCaptionText = caption;
      this.pendingNewSequence = trimmed.length > 0 && TERMINAL_PUNCTUATION.test(trimmed);
      return;
    }
    const previous = this.lastCaptionText;
    const lengthShrank = caption.length < previous.length - 1;
    const isSame = caption === previous;
    const isAppend = !isSame && previous.length > 0 && caption.length >= previous.length && caption.startsWith(previous);

    if (lengthShrank) {
      if (trimmed.length === 0) {
        this.longestCaptionText = caption;
        this.captionCandidateHistory = [];
        this.currentTurnId += 1;
        this.currentSeq = 0;
        this.pendingNewSequence = false;
        this.currentCaptionKey = this.captionKey(this.currentTurnId, this.currentSeq);
        this.ensureCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
        this.log(`[tts] new turn=${this.turnIdLabel(this.currentTurnId)}`);
        this.supersedeAudio("caption_reset", caption);
      } else {
        this.log(`[cap:shrink-revision] prev_len=${previous.length} new_len=${caption.length}`);
      }
    } else if (
      this.pendingNewSequence &&
      caption.length >= previous.length &&
      !caption.startsWith(previous)
    ) {
      this.currentSeq += 1;
      this.currentCaptionKey = this.captionKey(this.currentTurnId, this.currentSeq);
      this.ensureCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
      this.pendingNewSequence = false;
      this.log(`[tts] new segment turn=${this.turnIdLabel(this.currentTurnId)} seq=${this.currentSeq}`);
      this.supersedeAudio("segment_reset", caption, { soft: true });
      this.longestCaptionText = caption;
      this.captionCandidateHistory = [];
    }

    if (trimmed.length === 0) {
      this.pendingNewSequence = false;
    } else if (TERMINAL_PUNCTUATION.test(trimmed)) {
      this.pendingNewSequence = true;
    }

    if (!isSame) {
      // 字幕更新ではプレイヤーをリセットしない（音声の先頭・中間欠落を防止）
      // どうしても切り替えたい場合のみ、明示フラグで有効化
      if (
        this.flags.ttsExclusivePlaybackEnabled &&
        !isAppend &&
        previous.length > 0 &&
        caption !== this.lastSupersedeCaption
      ) {
        this.supersedeAudio("prefix_changed", caption);
      } else if (
        this.flags.ttsExclusivePlaybackEnabled &&
        TERMINAL_PUNCTUATION.test(trimmed) &&
        previous.length > 0 &&
        caption !== this.lastSupersedeCaption
      ) {
        const soft = this.lastQueuedMs !== null && this.lastQueuedMs <= SOFT_SUPERSEDE_THRESHOLD_MS;
        this.supersedeAudio("terminal_revision", caption, { soft });
      }
    }

    const state = this.ensureCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
    state.pendingText = caption;
    this.scheduleCaptionProcessing(state.key);
    this.lastCaptionText = caption;

    if (trimmed.length === 0) {
      state.committedChars = 0;
      state.scheduledChars = 0;
    }
  }

  private scheduleCaptionProcessing(stateKey: string): void {
    const state = this.captionStates.get(stateKey);
    if (!state) return;

    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }

    const delay = Math.max(0, this.flags.ttsTextDebounceMs);
    state.debounceTimer = window.setTimeout(() => {
      state.debounceTimer = null;
      this.processCaptionState(stateKey);
    }, delay);
  }

  private processCaptionState(stateKey: string): void {
    const state = this.captionStates.get(stateKey);
    if (!state) return;

    const pending = state.pendingText;
    const committed = state.committedChars;
    if (pending.length <= committed) {
      return;
    }

    const suffix = pending.slice(committed);
    if (!suffix.trim()) {
      return;
    }

    if (this.flags.ttsExclusivePlaybackEnabled && state.activeVoiceIds.size > 0) {
      for (const voiceId of Array.from(state.activeVoiceIds)) {
        this.cancelVoice(state, voiceId, "cancelled");
      }
    }

    const voiceId = this.startVoice(state, committed, pending.length, suffix.length);
    state.scheduledChars = pending.length;
  }

  private startVoice(
    state: CaptionPlaybackState,
    prefixLen: number,
    totalLen: number,
    suffixLen: number
  ): string {
    state.nextVoiceSeq += 1;
    const voiceId = `${state.key}#${state.nextVoiceSeq}`;
    state.activeVoiceIds.add(voiceId);
    this.activeVoicesGlobal.add(voiceId);

    this.log(
      `[TTS:start] turn=${this.turnIdLabel(state.turnId)} caption=${state.key} voice=${voiceId} prefix=${prefixLen} suffix=${suffixLen} active=${this.activeVoicesGlobal.size}`
    );

    const estimatedDuration = this.estimateVoiceDurationMs(suffixLen);
    const timer = window.setTimeout(() => {
      this.finishVoice(state, voiceId, "completed", totalLen);
    }, estimatedDuration);
    this.voiceTimers.set(voiceId, { timer, stateKey: state.key });

    return voiceId;
  }

  private cancelVoice(
    state: CaptionPlaybackState,
    voiceId: string,
    reason: VoiceLifecycleReason
  ): void {
    if (!state.activeVoiceIds.delete(voiceId)) return;
    this.activeVoicesGlobal.delete(voiceId);

    const timerEntry = this.voiceTimers.get(voiceId);
    if (timerEntry) {
      clearTimeout(timerEntry.timer);
      this.voiceTimers.delete(voiceId);
    }

    state.scheduledChars = Math.max(state.committedChars, state.scheduledChars);
    this.log(
      `[TTS:cancel] turn=${this.turnIdLabel(state.turnId)} caption=${state.key} voice=${voiceId} reason=${reason}`
    );
  }

  private finishVoice(
    state: CaptionPlaybackState,
    voiceId: string,
    reason: VoiceLifecycleReason,
    totalLen: number
  ): void {
    if (!state.activeVoiceIds.delete(voiceId)) return;
    this.activeVoicesGlobal.delete(voiceId);

    const timerEntry = this.voiceTimers.get(voiceId);
    if (timerEntry) {
      clearTimeout(timerEntry.timer);
      this.voiceTimers.delete(voiceId);
    }

    state.committedChars = Math.max(state.committedChars, totalLen);
    this.log(
      `[TTS:finish] turn=${this.turnIdLabel(state.turnId)} caption=${state.key} voice=${voiceId} reason=${reason} committed=${state.committedChars}`
    );
  }

  private cancelAllVoices(reason: VoiceLifecycleReason): void {
    for (const key of Array.from(this.captionStates.keys())) {
      const state = this.captionStates.get(key);
      if (!state) continue;
      this.cancelStateVoices(state, reason);
    }
    this.voiceTimers.clear();
    this.activeVoicesGlobal.clear();
  }

  private cancelStateVoices(state: CaptionPlaybackState, reason: VoiceLifecycleReason): void {
    for (const voiceId of Array.from(state.activeVoiceIds)) {
      this.cancelVoice(state, voiceId, reason);
    }
  }

  private estimateVoiceDurationMs(suffixLen: number): number {
    const characters = Math.max(1, suffixLen);
    const estimated = characters * 80; // ~12.5 chars / second baseline
    return Math.min(Math.max(estimated, 400), 6000);
  }

  private ensureCaptionState(key: string, turnId: number, seq: number): CaptionPlaybackState {
    let state = this.captionStates.get(key);
    if (!state) {
      state = this.createCaptionState(key, turnId, seq);
      this.registerCaptionState(state);
    }
    return state;
  }

  private createCaptionState(key: string, turnId: number, seq: number): CaptionPlaybackState {
    return {
      key,
      turnId,
      seq,
      pendingText: "",
      debounceTimer: null,
      scheduledChars: 0,
      committedChars: 0,
      activeVoiceIds: new Set<string>(),
      nextVoiceSeq: 0,
    };
  }

  private registerCaptionState(state: CaptionPlaybackState): void {
    this.captionStates.set(state.key, state);
    this.captionKeyOrder.push(state.key);
    this.trimCaptionStateCache();
  }

  private updatePlayerConfig(force = false): void {
    this.playerSupersedePrefixEnabled = this.flags.playerSupersedePrefixEnabled ?? false;
    const currentQueue = this.playerInitialQueueMs;
    const currentLead = this.playerStartLeadMs;
    const currentTrim = this.playerTrimGraceMs;
    const currentPause = this.playerSentencePauseMs;
    const currentQuiet = this.playerArmSupersedeQuietMs;
    const currentCommitGuard = this.playerCommitGuardMs;
    const queueMs = this.flags.ttsPrefixDedupeEnabled
      ? clampConfigValue(
          this.flags.playerInitialQueueMs,
          MIN_INITIAL_QUEUE_MS,
          MAX_INITIAL_QUEUE_MS,
          DEFAULT_FEATURE_FLAGS.playerInitialQueueMs
        )
      : PLAYER_DEFAULT_INITIAL_QUEUE_MS;
    const leadMs = this.flags.ttsPrefixDedupeEnabled
      ? clampConfigValue(
          this.flags.playerStartLeadMs,
          MIN_START_LEAD_MS,
          MAX_START_LEAD_MS,
          DEFAULT_FEATURE_FLAGS.playerStartLeadMs
        )
      : PLAYER_DEFAULT_START_LEAD_MS;
    const trimGraceMs = this.flags.ttsPrefixDedupeEnabled
      ? clampConfigValue(
          this.flags.playerTrimGraceMs,
          MIN_TRIM_GRACE_MS,
          MAX_TRIM_GRACE_MS,
          DEFAULT_FEATURE_FLAGS.playerTrimGraceMs
        )
      : PLAYER_DEFAULT_TRIM_GRACE_MS;
    const sentencePauseMs = clampConfigValue(
      this.flags.playerSentencePauseMs,
      MIN_SENTENCE_PAUSE_MS,
      MAX_SENTENCE_PAUSE_MS,
      DEFAULT_FEATURE_FLAGS.playerSentencePauseMs
    );
    const armSupersedeQuietMs = clampConfigValue(
      this.flags.playerArmSupersedeQuietMs,
      MIN_ARM_SUPERSEDE_QUIET_MS,
      MAX_ARM_SUPERSEDE_QUIET_MS,
      DEFAULT_FEATURE_FLAGS.playerArmSupersedeQuietMs
    );
    const commitGuardMs = clampConfigValue(
      this.flags.playerCommitGuardMs,
      MIN_COMMIT_GUARD_MS,
      MAX_COMMIT_GUARD_MS,
      DEFAULT_FEATURE_FLAGS.playerCommitGuardMs
    );

    const needsUpdate =
      force ||
      queueMs !== currentQueue ||
      leadMs !== currentLead ||
      trimGraceMs !== currentTrim ||
      sentencePauseMs !== currentPause ||
      armSupersedeQuietMs !== currentQuiet ||
      commitGuardMs !== currentCommitGuard;

    this.playerInitialQueueMs = queueMs;
    this.playerStartLeadMs = leadMs;
    this.playerTrimGraceMs = trimGraceMs;
    this.playerSentencePauseMs = sentencePauseMs;
    this.playerArmSupersedeQuietMs = armSupersedeQuietMs;
    this.playerCommitGuardMs = commitGuardMs;

    if (this.playerNode && needsUpdate) {
      try {
        this.playerNode.port.postMessage({
          type: "config",
          playerInitialQueueMs: queueMs,
          playerStartLeadMs: leadMs,
          playerTrimGraceMs: trimGraceMs,
          playerSentencePauseMs: sentencePauseMs,
          playerArmSupersedeQuietMs: armSupersedeQuietMs,
        });
      } catch (error) {
        this.log(`[player] config post failed: ${(error as Error).message}`);
      }
    }

    if (needsUpdate) {
      const queueSource = this.flags.ttsPrefixDedupeEnabled
        ? this.flagSources.playerInitialQueueMs
        : "default";
      const leadSource = this.flags.ttsPrefixDedupeEnabled
        ? this.flagSources.playerStartLeadMs
        : "default";
      const trimSource = this.flags.ttsPrefixDedupeEnabled
        ? this.flagSources.playerTrimGraceMs
        : "default";
      const pauseSource = this.flagSources.playerSentencePauseMs;
      const quietSource = this.flagSources.playerArmSupersedeQuietMs;
      const commitSource = this.flagSources.playerCommitGuardMs;
      this.log(
        `[player:config] initialQueueMs=${queueMs} (${queueSource}) startLeadMs=${leadMs} (${leadSource}) trimGraceMs=${trimGraceMs} (${trimSource}) sentencePauseMs=${sentencePauseMs} (${pauseSource}) armSupersedeQuietMs=${armSupersedeQuietMs} (${quietSource}) commitGuardMs=${commitGuardMs} (${commitSource})`
      );
    }
  }

  private trimCaptionStateCache(): void {
    const MAX_STATES = 8;
    while (this.captionKeyOrder.length > MAX_STATES) {
      const oldestKey = this.captionKeyOrder.shift();
      if (!oldestKey) continue;
      const state = this.captionStates.get(oldestKey);
      if (!state) continue;
      this.cancelStateVoices(state, "cancelled");
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
      }
      this.captionStates.delete(oldestKey);
    }
  }

  private resetCaptionStates(): void {
    this.flushBinaryReceptionSummary("reset");
    const transcriptSnapshot = this.transcriptStore.reset();
    this.callbacks.onTranscript?.(transcriptSnapshot);
    this.binaryStreamingActive = false;
    this.lastBinaryChunkAt = null;
    for (const key of Array.from(this.captionStates.keys())) {
      const state = this.captionStates.get(key);
      if (!state) continue;
      this.cancelStateVoices(state, "disconnect");
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
      }
    }
    this.captionStates.clear();
    this.captionKeyOrder.length = 0;
    this.currentTurnId = 0;
    this.currentSeq = 0;
    this.currentCaptionKey = this.captionKey(this.currentTurnId, this.currentSeq);
    const initialState = this.createCaptionState(this.currentCaptionKey, this.currentTurnId, this.currentSeq);
    this.registerCaptionState(initialState);
    this.lastCaptionText = "";
    this.pendingNewSequence = false;
    this.lastSupersedeCaption = "";
    this.resetFinalCommitState(this.audioEpoch);
    this.clearAudioFallback();
    this.supersedeAudio("reset", undefined, { cancelVoices: false });
    this.commitModeActive = false;
    this.turnSegmentHistory = [];
    this.postTurnResetPending = false;
  }

  private captionKey(turnId: number, seq: number): string {
    return `${this.turnIdLabel(turnId)}#${seq}`;
  }

  private turnIdLabel(turnId: number): string {
    return `turn-${turnId}`;
  }

  private log(message: string): void {
    this.callbacks.onLog?.(`[session=${this.sessionId}] ${message}`);
  }

  private static generateSessionId(): string {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  private supersedeAudio(
    reason: string,
    newCaption?: string,
    options: { soft?: boolean; cancelVoices?: boolean } = {}
  ): void {
    const prePlayback = !this.playerHasOutput;
    this.clearAudioFallback();
    if (newCaption) {
      this.lastSupersedeCaption = newCaption;
    }
    const isPrefixReason = reason === "prefix_changed" || reason === "terminal_revision";
    if (!this.playerSupersedePrefixEnabled && isPrefixReason) {
      this.log(`[player:supersede-skip] reason=${reason} policy=prefix_suppressed`);
      return;
    }
    if (prePlayback && isPrefixReason) {
      this.log(`[player:supersede-skip] reason=${reason} stage=pre_playback`);
      return;
    }
    const previousQueuedMs = this.lastQueuedMs;
    this.lastQueuedMs = null;
    const shouldCancelVoices = options.cancelVoices !== false;
    if (shouldCancelVoices) {
      this.cancelAllVoices("cancelled");
    }
    const now = nowMs();
    this.lastSupersedeAt = now;
    const commitGuardActive =
      this.playerHasOutput &&
      this.playerCommitGuardMs > 0 &&
      this.playerLastOutputAt !== null &&
      now - this.playerLastOutputAt < this.playerCommitGuardMs;
    if (commitGuardActive) {
      this.log(
        `[player:supersede-guard] reason=${reason} since_play_ms=${(now - (this.playerLastOutputAt ?? now)).toFixed(1)} guard_ms=${this.playerCommitGuardMs}`
      );
    }
    this.audioEpoch += 1;
    const epoch = this.audioEpoch;
    this.resetFinalCommitState(epoch);
    const queueSoft =
      options.soft === true &&
      previousQueuedMs !== null &&
      previousQueuedMs <= SOFT_SUPERSEDE_THRESHOLD_MS;
    const shouldSoft = queueSoft || commitGuardActive;
    const softLabel = shouldSoft ? " soft" : "";
    this.log(`[player:supersede] reason=${reason} epoch=${epoch}${softLabel}`);
    if (this.playerNode) {
      try {
        const contextTime = this.audioContext ? this.audioContext.currentTime : undefined;
        this.playerNode.port.postMessage({ type: "epoch", epoch, contextTime });
        if (shouldSoft) {
          this.playerNode.port.postMessage({ type: "soft_flush" });
        }
      } catch (error) {
        this.log(`[player] epoch notify failed: ${(error as Error).message}`);
      }
    }
    this.playbackCursor = 0;
    this.controlFrameStreak = 0;
    this.playerHasOutput = false;
    this.playerLastOutputAt = null;
  }

  private applyCaptionGuard(text: string): string | null {
    const result = guardCaption(text);
    if (!result.sanitized) {
      if (result.reason) {
        this.log(`[caption.guard] suppressed ${result.reason}`);
      }
      return null;
    }
    return result.sanitized;
  }

  private armAudioFallback(stateKey: string): void {
    if (typeof window === "undefined") return;
    if (this.finalCommitIssued) return;
    this.clearAudioFallback();
    this.audioFallbackArmed = true;
    this.audioFallbackCommitted = false;
    this.audioFallbackKey = stateKey;
    const expectedEpoch = this.audioEpoch;
    this.audioFallbackEpoch = expectedEpoch;
    this.audioFallbackTimer = window.setTimeout(() => {
      this.commitAudioFallback(stateKey, expectedEpoch);
    }, AUDIO_FALLBACK_DELAY_MS);
  }

  private clearAudioFallbackTimer(): void {
    if (typeof window === "undefined") return;
    if (this.audioFallbackTimer !== null) {
      window.clearTimeout(this.audioFallbackTimer);
      this.audioFallbackTimer = null;
    }
  }

  private clearAudioFallback(): void {
    this.clearAudioFallbackTimer();
    this.audioFallbackArmed = false;
    this.audioFallbackCommitted = false;
    this.audioFallbackKey = null;
    this.audioFallbackEpoch = null;
  }

  private markAudioBurst(): void {
    if (typeof window === "undefined") return;
    this.lastAudioBurstAt = nowMs();
    if (!this.finalCommitIssued && !this.commitModeActive) {
      this.scheduleFinalCommitTimer("audio_idle");
    }
  }

  private scheduleFinalCommitTimer(reason: string): void {
    if (typeof window === "undefined") return;
    if (this.finalCommitIssued) return;
    this.clearFinalCommitTimer();
    this.finalCommitTimer = window.setTimeout(() => {
      this.finalCommitTimer = null;
      if (this.finalCommitIssued) return;
      this.log(`[caption:final-timeout] reason=${reason}`);
      this.commitFinalCaption(`timeout:${reason}`);
    }, FINAL_COMMIT_DELAY_MS);
  }

  private clearFinalCommitTimer(): void {
    if (typeof window === "undefined") return;
    if (this.finalCommitTimer !== null) {
      window.clearTimeout(this.finalCommitTimer);
      this.finalCommitTimer = null;
    }
  }

  private resetFinalCommitState(epoch: number): void {
    this.clearFinalCommitTimer();
    this.finalCommitIssued = false;
    this.generationCompleteObserved = false;
    this.lastAudioBurstAt = null;
    this.finalCommitEpoch = epoch;
    this.longestCaptionText = "";
    this.captionCandidateHistory = [];
    this.resetCaptionTurnMetrics();
  }

  private commitFinalCaption(reason: string): void {
    if (this.commitModeActive) {
      this.log(`[caption:commit] skipped reason=${reason} mode=commit`);
      return;
    }
    if (this.finalCommitIssued) return;

    const state = this.captionStates.get(this.currentCaptionKey);
    const candidates: string[] = [];
    if (this.longestCaptionText) candidates.push(this.longestCaptionText);
    if (state?.pendingText) candidates.push(state.pendingText);
    if (this.lastCaptionText) candidates.push(this.lastCaptionText);
    if (this.captionCandidateHistory.length > 0) {
      candidates.push(...this.captionCandidateHistory);
    }

    let rawCandidate: string | null = null;
    for (const candidate of candidates) {
      const guarded = this.applyCaptionGuard(candidate);
      if (!guarded) continue;
      if (!rawCandidate || guarded.trim().length > rawCandidate.trim().length) {
        rawCandidate = guarded;
      }
    }

    let finalCaption: string | null = null;
    let fallbackReason: string | null = null;
    let shortTextFallback = false;

    if (rawCandidate) {
      const sentenceCandidate = extractLastSentenceCandidate(rawCandidate);
      if (sentenceCandidate) {
        const evaluation = evaluateSentenceCandidate(sentenceCandidate);
        if (evaluation.accepted && evaluation.normalizedText) {
          finalCaption = evaluation.normalizedText;
          if (evaluation.appendedTerminal) {
            const appendedPreview =
              finalCaption.length <= 32 ? finalCaption : `${finalCaption.slice(0, 32)}…`;
            this.log(`[caption:terminal-append] text=${appendedPreview}`);
          }
        } else {
          fallbackReason = evaluation.reason ?? "sentence_rejected";
          if (
            evaluation.reason === "terminal_too_short" ||
            evaluation.reason === "plain_too_short" ||
            evaluation.reason === "empty"
          ) {
            shortTextFallback = true;
          }
        }
      } else {
        fallbackReason = "sentence_missing";
        shortTextFallback = true;
      }
    } else if (reason !== "audio_fallback") {
      fallbackReason = "no_candidate";
      shortTextFallback = true;
    }

    if (shortTextFallback) {
      this.incrementCaptionMetric("shortTextFallbacks");
    }

    if (reason.startsWith("timeout")) {
      this.incrementCaptionMetric("finalTimeouts");
    }

    if (!finalCaption) {
      finalCaption = AUDIO_ONLY_LABEL;
      if (reason !== "audio_fallback") {
        const label = fallbackReason ?? reason;
        const previewSource = rawCandidate ?? "";
        const previewText =
          previewSource.length === 0
            ? ""
            : previewSource.length <= 32
            ? previewSource
            : `${previewSource.slice(0, 32)}…`;
        if (previewText) {
          this.log(`[caption:fallback] reason=${label} text=${previewText}`);
        } else {
          this.log(`[caption:fallback] reason=${label}`);
        }
      }
    }

    const preview = finalCaption.length <= 32 ? finalCaption : `${finalCaption.slice(0, 32)}…`;
    this.finalCommitIssued = true;
    this.finalCommitEpoch = this.audioEpoch;
    this.clearFinalCommitTimer();
    this.clearAudioFallback();
    this.log(`[caption:commit] reason=${reason} text=${preview} length=${finalCaption.length}`);
    this.callbacks.onCaption?.(finalCaption);

    if (state) {
      state.pendingText = finalCaption;
      state.scheduledChars = finalCaption.length;
      state.committedChars = finalCaption.length;
    }
    this.lastCaptionText = finalCaption;
    const isAudioOnly = finalCaption === AUDIO_ONLY_LABEL;
    this.audioFallbackCommitted = isAudioOnly;
    if (isAudioOnly) {
      this.incrementCaptionMetric("textMissing");
    }
    this.incrementCaptionMetric("commits");
    this.logCaptionMetrics(reason, finalCaption.length, isAudioOnly || reason === "audio_fallback");
    this.captionCandidateHistory = [];
  }

  private commitAudioFallback(stateKey: string, expectedEpoch: number): void {
    if (!this.audioFallbackArmed || this.audioFallbackCommitted) return;
    if (this.audioFallbackKey !== stateKey) return;
    if (this.audioFallbackEpoch !== expectedEpoch) return;

    const state = this.captionStates.get(stateKey);
    if (state && state.pendingText.trim().length > 0) {
      return;
    }
    if (this.lastCaptionText.trim().length > 0) {
      return;
    }

    this.log(`[caption:fallback] reason=audio_timer key=${stateKey}`);
    this.incrementCaptionMetric("audioFallbacks");
    this.commitFinalCaption("audio_fallback");
  }

  /**
   * 文確定に関するメトリクスをターン単位・セッション単位で記録する。
   */
  private incrementCaptionMetric(metric: keyof CaptionMetrics): void {
    this.captionMetricsTurn[metric] += 1;
    this.captionMetricsSession[metric] += 1;
  }

  /**
   * ターン内のメトリクスをリセットする。
   */
  private resetCaptionTurnMetrics(): void {
    this.captionMetricsTurn = {
      shortTextFallbacks: 0,
      audioFallbacks: 0,
      finalTimeouts: 0,
      textMissing: 0,
      commits: 0,
    };
  }

  /**
   * 最終文コミット時にメトリクスをまとめて出力する。
   */
  private logCaptionMetrics(reason: string, committedLength: number, fallbackApplied: boolean): void {
    const turn = this.captionMetricsTurn;
    const session = this.captionMetricsSession;
    const sessionCommits = Math.max(session.commits, 1);
    const rate = (value: number): string => ((value / sessionCommits) * 100).toFixed(1);

    this.log(
      `[caption:metrics] turn_short=${turn.shortTextFallbacks} turn_audio=${turn.audioFallbacks} turn_timeout=${turn.finalTimeouts} turn_text_missing=${turn.textMissing} turn_commits=${turn.commits} fallback=${fallbackApplied ? 1 : 0} length=${committedLength} reason=${reason}`
    );
    this.log(
      `[caption:metrics.session] commits=${session.commits} short=${session.shortTextFallbacks}(${rate(session.shortTextFallbacks)}%) audio=${session.audioFallbacks}(${rate(session.audioFallbacks)}%) timeout=${session.finalTimeouts}(${rate(session.finalTimeouts)}%) text_missing=${session.textMissing}(${rate(session.textMissing)}%)`
    );

    if (!this.captionFallbackAlerted && session.commits >= METRIC_ALERT_SAMPLE_MIN) {
      const shortRate = session.shortTextFallbacks / session.commits;
      const audioRate = session.audioFallbacks / session.commits;
      const timeoutRate = session.finalTimeouts / session.commits;
      const textMissingRate = session.textMissing / session.commits;
      if (
        shortRate >= SHORT_TEXT_ALERT_RATE ||
        audioRate >= AUDIO_FALLBACK_ALERT_RATE ||
        timeoutRate >= FINAL_TIMEOUT_ALERT_RATE ||
        textMissingRate >= TEXT_MISSING_ALERT_RATE
      ) {
        this.captionFallbackAlerted = true;
        this.log(
          `[caption:fallback-alert] commits=${session.commits} short_rate=${(shortRate * 100).toFixed(2)}% audio_rate=${(audioRate * 100).toFixed(2)}% timeout_rate=${(timeoutRate * 100).toFixed(2)}% text_missing_rate=${(textMissingRate * 100).toFixed(2)}%`
        );
      }
    }

    this.resetCaptionTurnMetrics();
  }

  private async enqueueFallbackClip(
    context: AudioContext,
    buffer: ArrayBuffer,
    bytes: Uint8Array,
    expectedEpoch: number
  ): Promise<void> {
    if (expectedEpoch !== this.audioEpoch) {
      this.log(`[player:skip-fallback] reason=epoch_changed expected=${expectedEpoch} current=${this.audioEpoch}`);
      return;
    }
    const preview = Array.from(bytes.slice(0, 8))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(" ");

    if (bytes.byteLength % 2 !== 0) {
      this.log(`[player:warn] odd-byte-length=${bytes.byteLength} preview=${preview}`);
    }

    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) {
      this.log(`[player:skip-empty] bytes=${buffer.byteLength}`);
      return;
    }

    const view = new DataView(buffer, 0, sampleCount * 2);
    const floats = new Float32Array(sampleCount);
    let sum = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const intSample = view.getInt16(i * 2, true);
      const value = intSample / 32768;
      floats[i] = value;
      sum += Math.abs(value);
    }

    const mean = sum / sampleCount;
    const audioBuffer = context.createBuffer(1, floats.length, 24_000);
    audioBuffer.copyToChannel(floats, 0, 0);

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);

    const now = context.currentTime;
    const leadSeconds = this.flags.ttsPrefixDedupeEnabled
      ? Math.max(this.playerStartLeadMs / 1000, 0)
      : 0;
    const pauseSeconds = Math.max(this.playerSentencePauseMs / 1000, 0);
    const startDelay = Math.max(0.01, leadSeconds + pauseSeconds);
    const startAt = Math.max(this.playbackCursor, now + startDelay);
    if (expectedEpoch !== this.audioEpoch) {
      return;
    }
    source.start(startAt);
    this.playbackCursor = startAt + audioBuffer.duration;
    this.playerHasOutput = true;
    this.playerLastOutputAt = nowMs();
    this.markAudioBurst();

    source.onended = () => {
      if (this.playbackCursor <= now + 0.5) {
        this.playbackCursor = Math.max(this.playbackCursor, context.currentTime);
      }
    };

    this.log(
      `[player:fallback] bytes=${buffer.byteLength} samples=${sampleCount} mean=${mean.toFixed(6)} startAt=${startAt.toFixed(3)} duration=${audioBuffer.duration.toFixed(3)} lead_ms=${(startDelay * 1000).toFixed(1)}`
    );
  }
}
