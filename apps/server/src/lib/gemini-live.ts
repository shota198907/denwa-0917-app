import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { TextDecoder } from "node:util";
import { env } from "../env";
import { createExponentialBackoff } from "./backoff";
import { AdaptiveRateLimiter } from "./rate-limit";
import { metrics } from "../observability/metrics";
import { trace } from "../observability/tracing";
import {
  LiveSegmenter,
  SegmentCommitMessage,
  TurnCommitMessage,
  SegmentEvent,
  PendingStateSnapshot,
  TurnFinalizationResult,
  SegmenterDiagnosticsSummary,
} from "./live-segmenter";

interface PendingMessage {
  readonly data: WebSocket.RawData;
  readonly isBinary: boolean;
}

export interface AudioChunk {
  readonly buffer: Buffer;
  readonly mimeType: string;
}

interface ExtractedPayload {
  readonly sanitized: unknown;
  readonly audioChunks: AudioChunk[];
  readonly goAwayDetected: boolean;
  readonly sessionSnapshot?: Record<string, unknown>;
}

const RETRYABLE_CLOSE_CODES = new Set([1006, 1011, 1012, 1013]);
const MAX_PENDING_QUEUE = 256;
const DEFAULT_AUDIO_MIME = "audio/pcm;rate=16000";
const BINARY_SUMMARY_INTERVAL_MS = 1200;
const BINARY_SUMMARY_MAX_CHUNKS = 24;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type BinaryChunkOrigin = "upstream_raw" | "payload_extract";
type BinarySummaryReason = "chunk" | "interval" | "turn" | "shutdown" | "generation";

interface BinaryChunkSummary {
  totalChunks: number;
  totalBytes: number;
  minBytes: number;
  maxBytes: number;
  firstChunkAt: number;
  lastChunkAt: number;
  lastLogAt: number;
  originCounts: Record<BinaryChunkOrigin, number>;
  originBytes: Record<BinaryChunkOrigin, number>;
}

interface AudioChunkSummary {
  readonly count: number;
  readonly totalBytes: number;
  readonly minBytes: number;
  readonly maxBytes: number;
}

const toBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as string);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isUtf8 = (buffer: Buffer): boolean => {
  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch (_error) {
    return false;
  }
};

const extractAudioChunks = (payload: unknown): ExtractedPayload => {
  const audioChunks: AudioChunk[] = [];
  let goAwayDetected = false;
  let sessionSnapshot: Record<string, unknown> | undefined;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry));
    }

    if (!isPlainObject(value)) {
      if (typeof value === "string" && value.toLowerCase() === "goaway") {
        goAwayDetected = true;
      }
      return value;
    }

    const cloned: Record<string, unknown> = {};

    const inlineAudio = maybeExtractAudio(value);
    if (inlineAudio) {
      audioChunks.push(inlineAudio.chunk);
      return inlineAudio.sanitized;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "session" && isPlainObject(child)) {
        sessionSnapshot = child;
      }
      if (key === "goAway") {
        goAwayDetected = true;
      }
      if (key === "event" && typeof child === "string" && child.toLowerCase() === "goaway") {
        goAwayDetected = true;
      }

      const audioFromChild = maybeExtractAudio(child);
      if (audioFromChild) {
        audioChunks.push(audioFromChild.chunk);
        cloned[key] = audioFromChild.sanitized;
        continue;
      }

      if (Array.isArray(child) && (key === "parts" || key === "media_chunks")) {
        const normalizedParts = child.map((entry) => {
          const audioInEntry = maybeExtractAudio(entry);
          if (audioInEntry) {
            audioChunks.push(audioInEntry.chunk);
            return audioInEntry.sanitized;
          }
          if (isPlainObject(entry) && Array.isArray(entry.mediaChunks)) {
            const sanitizedEntry: Record<string, unknown> = { ...entry, mediaChunks: [] };
            for (const sub of entry.mediaChunks) {
              const audioSub = maybeExtractAudio(sub);
              if (audioSub) {
                audioChunks.push(audioSub.chunk);
                (sanitizedEntry.mediaChunks as unknown[]).push(audioSub.sanitized);
              } else {
                (sanitizedEntry.mediaChunks as unknown[]).push(sub);
              }
            }
            return sanitizedEntry;
          }
          if (isPlainObject(entry) && Array.isArray(entry.media_chunks)) {
            const sanitizedEntry: Record<string, unknown> = { ...entry, media_chunks: [] };
            for (const sub of entry.media_chunks) {
              const audioSub = maybeExtractAudio(sub);
              if (audioSub) {
                audioChunks.push(audioSub.chunk);
                (sanitizedEntry.media_chunks as unknown[]).push(audioSub.sanitized);
              } else {
                (sanitizedEntry.media_chunks as unknown[]).push(sub);
              }
            }
            return sanitizedEntry;
          }
          return walk(entry);
        });
        cloned[key] = normalizedParts;
        continue;
      }

      cloned[key] = walk(child);
    }

    return cloned;
  };

  const sanitized = walk(payload);
  return { sanitized, audioChunks, goAwayDetected, sessionSnapshot };
};

  /**
   * 鐘（ターン終了）の検出
   * Gemini Live APIでは、candidates配列のfinishReasonが"STOP"の場合がターン終了を示す
   * @param payload Live APIからのサニタイズ済みペイロード
   */
  const detectTurnEnd = (payload: unknown): boolean => {
    return detectTurnEndRecursive(payload, 0, new Set());
  };

  /**
   * ターン終了検出の再帰ロジック
   */
  const detectTurnEndRecursive = (
    value: unknown,
    depth: number,
    seen: Set<unknown>
  ): boolean => {
    if (depth > 8) return false;
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (detectTurnEndRecursive(entry, depth + 1, seen)) {
          return true;
        }
      }
      return false;
    }

    const record = value as Record<string, unknown>;
    
    // serverCompleteフラグの検出（従来の方法）
    if (record.serverComplete === true || record.server_complete === true) {
      return true;
    }

    // serverContent内のcandidates配列をチェック
    if (isPlainObject(record.serverContent)) {
      const serverContent = record.serverContent as Record<string, unknown>;
      if (Array.isArray(serverContent.candidates)) {
        for (const candidate of serverContent.candidates) {
          if (isPlainObject(candidate)) {
            const cand = candidate as Record<string, unknown>;
            // finishReasonが"STOP"の場合はターン終了
            if (cand.finishReason === "STOP") {
              return true;
            }
          }
        }
      }
    }

    // その他の子要素を再帰的にチェック
    for (const child of Object.values(record)) {
      if (detectTurnEndRecursive(child, depth + 1, seen)) {
        return true;
      }
    }
    return false;
  };

interface AudioExtractionResult {
  readonly chunk: AudioChunk;
  readonly sanitized: unknown;
}

const pickMimeType = (value: Record<string, unknown>): string | undefined => {
  const camel = typeof value.mimeType === "string" ? value.mimeType : undefined;
  const snake = typeof value.mime_type === "string" ? value.mime_type : undefined;
  return camel ?? snake;
};

const pickChunkData = (value: Record<string, unknown>): string | undefined => {
  const data = typeof value.data === "string" ? value.data : undefined;
  const inline = typeof value.inline_data === "string" ? value.inline_data : undefined;
  return data ?? inline;
};

const maybeExtractAudio = (value: unknown): AudioExtractionResult | undefined => {
  if (!isPlainObject(value)) return undefined;

  metrics.audioExtractionAttempted();
  const directMime = pickMimeType(value);
  const directData = pickChunkData(value);

  if (directMime && directData && directMime.includes("audio")) {
    const buffer = Buffer.from(directData, "base64");
    const sanitized = { ...value, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
    metrics.audioExtractionSucceeded();
    return { chunk: { buffer, mimeType: directMime }, sanitized };
  }

  if (isPlainObject(value.inlineData)) {
    const mime = pickMimeType(value.inlineData);
    const data = pickChunkData(value.inlineData);
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedInline = { ...value.inlineData, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, inlineData: sanitizedInline };
      metrics.audioExtractionSucceeded();
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.inline_data)) {
    const mime = pickMimeType(value.inline_data);
    const data = pickChunkData(value.inline_data);
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedInline = { ...value.inline_data, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, inline_data: sanitizedInline };
      metrics.audioExtractionSucceeded();
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.audio)) {
    const mime = pickMimeType(value.audio);
    const data = pickChunkData(value.audio);
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedAudio = { ...value.audio, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, audio: sanitizedAudio };
      metrics.audioExtractionSucceeded();
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.realtimeOutput)) {
    const mime = pickMimeType(value.realtimeOutput);
    const data = pickChunkData(value.realtimeOutput);
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedRealtime = { ...value.realtimeOutput, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, realtimeOutput: sanitizedRealtime };
      metrics.realtimeOutputDetected();
      metrics.audioExtractionSucceeded();
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.realtime_output)) {
    const mime = pickMimeType(value.realtime_output);
    const data = pickChunkData(value.realtime_output);
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedRealtime = { ...value.realtime_output, data: undefined, inline_data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, realtime_output: sanitizedRealtime };
      metrics.realtimeOutputDetected();
      metrics.audioExtractionSucceeded();
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  metrics.audioExtractionFailed();
  return undefined;
};

const randomId = (): string => crypto.randomBytes(6).toString("hex");

const normalizeModel = (modelId: string): string => {
  if (!modelId) return "models/gemini-live-2.5-flash-preview";
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
};

const buildSetupPayload = (sessionSnapshot?: Record<string, unknown>) => {
  const setup: Record<string, unknown> = {
    model: normalizeModel(env.gemini.model),
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: env.gemini.voiceName,
          },
        },
      },
    },
    systemInstruction: {
      parts: [{ text: env.gemini.systemInstruction }],
    },
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    // contextWindowCompression: {
    //   triggerTokens: env.gemini.contextWindowCompressionTriggerTokens,
    // },
  };

  const resumptionHandle =
    sessionSnapshot && typeof sessionSnapshot === "object" && sessionSnapshot !== null
      ? typeof (sessionSnapshot as Record<string, unknown>).handle === "string"
        ? (sessionSnapshot as Record<string, unknown>).handle
        : undefined
      : undefined;

  if (resumptionHandle) {
    setup.sessionResumption = { handle: resumptionHandle };
    console.info("[setup.session_resumption]", { handle: resumptionHandle });
  }

  if (sessionSnapshot) {
    setup.session = sessionSnapshot;
  }

  console.info("[debug.setup_payload]", JSON.stringify(setup));
  return { setup };
};

const createAudioRealtimePayload = (base64: string, mimeType: string = DEFAULT_AUDIO_MIME) => ({
  realtime_input: {
    media_chunks: [
      {
        mime_type: mimeType,
        data: base64,
      },
    ],
  },
});

const createTextRealtimePayload = (text: string) => ({
  realtime_input: { text },
});

const normalizeRealtimeInput = (input: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};

  if (typeof input.text === "string" && input.text.length > 0) {
    normalized.text = input.text;
  }

  const mediaChunks: unknown[] = [];

  const appendChunk = (chunk: unknown) => {
    if (!isPlainObject(chunk)) return;
    const mime = pickMimeType(chunk);
    const data = pickChunkData(chunk);
    if (!mime || !data) return;
    mediaChunks.push({ mime_type: mime, data });
  };

  if (typeof input.mimeType === "string" && typeof input.data === "string") {
    mediaChunks.push({ mime_type: input.mimeType, data: input.data });
  }

  if (typeof input.mime_type === "string" && typeof input.data === "string") {
    mediaChunks.push({ mime_type: input.mime_type, data: input.data });
  }

  if (isPlainObject(input.audio)) {
    appendChunk(input.audio);
  }

  if (isPlainObject(input.audio_chunk)) {
    appendChunk(input.audio_chunk);
  }

  if (Array.isArray((input as Record<string, unknown>).mediaChunks)) {
    for (const chunk of (input as Record<string, unknown>).mediaChunks as unknown[]) {
      appendChunk(chunk);
    }
  }

  if (Array.isArray((input as Record<string, unknown>).media_chunks)) {
    for (const chunk of (input as Record<string, unknown>).media_chunks as unknown[]) {
      appendChunk(chunk);
    }
  }

  if (mediaChunks.length > 0) {
    normalized.media_chunks = mediaChunks;
  }

  for (const [key, value] of Object.entries(input)) {
    if (
      key === "text" ||
      key === "mimeType" ||
      key === "mime_type" ||
      key === "data" ||
      key === "inline_data" ||
      key === "audio" ||
      key === "audio_chunk" ||
      key === "mediaChunks" ||
      key === "media_chunks"
    ) {
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
};

const normalizeRealtimePayload = (payload: unknown): unknown => {
  if (!isPlainObject(payload)) return payload;

  const cloned: Record<string, unknown> = { ...payload };

  if (isPlainObject(cloned.realtime_input)) {
    cloned.realtime_input = normalizeRealtimeInput(cloned.realtime_input);
  }

  if (isPlainObject(cloned.realtimeInput)) {
    cloned.realtime_input = normalizeRealtimeInput(cloned.realtimeInput);
    delete cloned.realtimeInput;
  }

  return cloned;
};

const shouldRetryClose = (code: number, reason: string): boolean => {
  if (RETRYABLE_CLOSE_CODES.has(code)) return true;
  if (code === 1000) return false;
  if (reason.includes("429")) return true;
  if (reason.startsWith("5")) return true;
  return false;
};

const LOG_PREVIEW_LENGTH = 100;

const previewPayload = (data: WebSocket.RawData, isBinary: boolean): string => {
  if (isBinary) {
    const base64 = toBuffer(data).toString("base64");
    return base64.length <= LOG_PREVIEW_LENGTH ? base64 : `${base64.slice(0, LOG_PREVIEW_LENGTH)}…`;
  }

  const text = typeof data === "string" ? data : toBuffer(data).toString("utf8");
  if (!text) return "";
  return text.length <= LOG_PREVIEW_LENGTH ? text : `${text.slice(0, LOG_PREVIEW_LENGTH)}…`;
};

export interface GeminiProxyOptions {
  readonly client: WebSocket;
  readonly request: IncomingMessage;
  readonly serverCompleteForced: boolean;
}

export class GeminiLiveProxy {
  private readonly client: WebSocket;
  private upstream?: WebSocket;
  private readonly request: IncomingMessage;
  private readonly sessionId = randomId();
  private readonly serverCompleteForced: boolean;
  private readonly backoff = createExponentialBackoff({ initialDelayMs: 500, maxDelayMs: 15_000 });
  private readonly audioLimiter = new AdaptiveRateLimiter();
  private readonly pending: PendingMessage[] = [];
  private readonly segmenter = new LiveSegmenter({
    sampleRate: env.segmentation.sampleRate,
    silenceThreshold: env.segmentation.silenceThreshold,
    silenceDurationMs: env.segmentation.silenceDurationMs,
    maxPendingSegments: env.segmentation.maxPendingSegments,
  });
  private plannedReconnectTimer?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private turnFinalizationTimer?: NodeJS.Timeout;
  private turnFinalizationExtended = false;
  private turnFinalizationStartMs: number | undefined;
  private turnFinalizationTranscriptLength = 0;
  private closed = false;
  private reconnectRequested = false;
  private sessionSnapshot?: Record<string, unknown>;
  private sessionHandle?: string;
  private serverCompleteAckSent = false;
  private serverCompleteSeen = false;
  private binaryOutSummary: BinaryChunkSummary = this.createBinarySummary();
  private lastDiagnosticsSignature: string | null = null;

  constructor(options: GeminiProxyOptions) {
    this.client = options.client;
    this.request = options.request;
    this.serverCompleteForced = options.serverCompleteForced;
  }

  start(): void {
    metrics.sessionStarted();
    trace({ event: "session.start", data: { sessionId: this.sessionId } });
    console.info("[session.config]", {
      sessionId: this.sessionId,
      serverCompleteForced: this.serverCompleteForced,
    });
    this.bindClientEvents();
    this.sendServerCompleteAckIfNeeded();
    this.connectToUpstream("initial");
  }

  private bindClientEvents(): void {
    this.client.on("message", (data, isBinary) => {
      console.info("[cli.msg]", previewPayload(data, isBinary));
      this.forwardClientMessage({ data, isBinary });
    });

    this.client.on("close", (code, reason) => {
      trace({ event: "session.client_closed", data: { sessionId: this.sessionId, code, reason: reason.toString() } });
      this.shutdown();
    });

    this.client.on("error", (err) => {
      trace({ event: "session.client_error", data: { sessionId: this.sessionId, message: stringifyError(err) } });
      this.shutdown();
    });
  }

  private sendServerCompleteAckIfNeeded(): void {
    if (!this.serverCompleteForced || this.serverCompleteAckSent) return;
    const ackPayload = { mode: "serverComplete", ack: true };
    this.safeSendToClientJSON({ setupComplete: {} });
    this.safeSendToClientJSON(ackPayload);
    trace({ event: "session.server_complete_ack", data: { sessionId: this.sessionId } });
    console.info("[session.server_complete_ack]", { sessionId: this.sessionId });
    this.serverCompleteAckSent = true;
    this.serverCompleteSeen = true;
  }

  private connectToUpstream(reason: string): void {
    if (this.closed) return;

    if (!env.gemini.wsUrl || !env.gemini.apiKey) {
      const payload = { error: "upstream_not_configured", hint: "Set GEMINI_LIVE_WS_URL & GEMINI_API_KEY" };
      this.safeSendToClientJSON(payload);
      this.client.close(1011, "server_not_configured");
      return;
    }

    this.clearUpstreamTimers();
    this.reconnectRequested = false;

    console.info("[up.connect_attempt]", env.gemini.wsUrl);
    trace({ event: "upstream.connect_attempt", data: { sessionId: this.sessionId, reason } });

    const upstream = new WebSocket(env.gemini.wsUrl, {
      perMessageDeflate: false,
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY! },
      skipUTF8Validation: true,
    });
    this.upstream = upstream;

    upstream.on("open", () => {
      console.info("[up.open]");
      trace({ event: "upstream.open", data: { sessionId: this.sessionId } });
      this.backoff.reset();
      this.sendSetup();
      this.flushPending();
      this.schedulePlannedReconnect();
      this.startHeartbeat();
      if (reason !== "initial") {
        metrics.reconnectRecorded();
      }
    });

    upstream.on("message", (data, isBinary) => {
      console.info("[up.msg]", previewPayload(data, isBinary));
      this.handleUpstreamMessage(data, isBinary);
    });

    upstream.on("close", (code, reasonBuffer) => {
      const reasonText = reasonBuffer.toString();
      console.info("[up.close]", code, reasonText);
      if (reasonBuffer.length > 0) {
        const hex = reasonBuffer.toString("hex");
        console.info("[up.close.raw]", { hex });
      }
      trace({ event: "upstream.close", data: { sessionId: this.sessionId, code, reason: reasonText } });
      this.handleUpstreamClose(code, reasonText);
    });

    upstream.on("error", (err) => {
      const message = stringifyError(err);
      console.info("[up.error]", err?.message);
      trace({ event: "upstream.error", data: { sessionId: this.sessionId, message } });
      if (message.includes("429")) {
        this.audioLimiter.markRateLimited();
        metrics.rateLimitedReconnect();
      }
      if (this.upstream?.readyState === WebSocket.CLOSING || this.upstream?.readyState === WebSocket.CLOSED) {
        this.scheduleRetry("error");
      }
    });
  }

  private sendSetup(): void {
    try {
      const payload = buildSetupPayload(this.sessionSnapshot);
      this.sendToUpstream(JSON.stringify(payload));
    } catch (error) {
      trace({ event: "upstream.send_setup_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
    }
  }

  private forwardClientMessage(message: PendingMessage): void {
    if (this.closed) return;
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      if (this.pending.length >= MAX_PENDING_QUEUE) {
        this.pending.shift();
      }
      this.pending.push(message);
      return;
    }

    if (message.isBinary) {
      this.forwardBinaryAudio(message.data);
      return;
    }

    this.forwardTextMessage(message.data);
  }

  private forwardBinaryAudio(data: WebSocket.RawData): void {
    if (!this.audioLimiter.allowSend()) {
      trace({ event: "upstream.audio_dropped_rate_limited", data: { sessionId: this.sessionId } });
      return;
    }

    const buffer = toBuffer(data);
    if (buffer.length === 0) return;

    const payload = createAudioRealtimePayload(buffer.toString("base64"));
    this.sendToUpstream(JSON.stringify(payload));
    this.audioLimiter.markSuccess();
  }

  private forwardTextMessage(data: WebSocket.RawData): void {
    const buffer = typeof data === "string" ? Buffer.from(data) : toBuffer(data);
    if (!isUtf8(buffer)) {
      this.forwardBinaryAudio(buffer);
      return;
    }

    const text = typeof data === "string" ? data : buffer.toString("utf8");
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      const payload = createTextRealtimePayload(text);
      this.sendToUpstream(JSON.stringify(payload));
      return;
    }

    if (!isPlainObject(parsed)) {
      const normalizedText = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      const payload = createTextRealtimePayload(normalizedText);
      this.sendToUpstream(JSON.stringify(payload));
      return;
    }

    if (isAudioEnvelope(parsed)) {
      const audioBase64 = String(parsed.data);
      if (!audioBase64) return;
      const mimeType = pickMimeType(parsed) ?? DEFAULT_AUDIO_MIME;
      const payload = createAudioRealtimePayload(audioBase64, mimeType);
      this.sendToUpstream(JSON.stringify(payload));
      return;
    }

    const normalized = normalizeRealtimePayload(parsed);
    this.sendToUpstream(JSON.stringify(normalized));
  }

  private createBinarySummary(): BinaryChunkSummary {
    return {
      totalChunks: 0,
      totalBytes: 0,
      minBytes: Number.POSITIVE_INFINITY,
      maxBytes: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      lastLogAt: Date.now(),
      originCounts: {
        upstream_raw: 0,
        payload_extract: 0,
      },
      originBytes: {
        upstream_raw: 0,
        payload_extract: 0,
      },
    };
  }

  private recordBinaryOut(bytes: number, origin: BinaryChunkOrigin): void {
    if (bytes <= 0 || !Number.isFinite(bytes)) return;
    const summary = this.binaryOutSummary;
    const now = Date.now();
    if (summary.totalChunks === 0) {
      summary.firstChunkAt = now;
      summary.minBytes = bytes;
      summary.maxBytes = bytes;
    } else {
      summary.minBytes = Math.min(summary.minBytes, bytes);
      summary.maxBytes = Math.max(summary.maxBytes, bytes);
    }
    summary.totalChunks += 1;
    summary.totalBytes += bytes;
    summary.lastChunkAt = now;
    summary.originCounts[origin] += 1;
    summary.originBytes[origin] += bytes;

    const shouldFlushByChunk = summary.totalChunks >= BINARY_SUMMARY_MAX_CHUNKS;
    const shouldFlushByTime = summary.lastChunkAt - summary.lastLogAt >= BINARY_SUMMARY_INTERVAL_MS;
    if (shouldFlushByChunk || shouldFlushByTime) {
      this.flushBinaryOutSummary(shouldFlushByChunk ? "chunk" : "interval");
    }
  }

  private flushBinaryOutSummary(reason: BinarySummaryReason): void {
    const summary = this.binaryOutSummary;
    if (summary.totalChunks === 0) {
      summary.lastLogAt = Date.now();
      return;
    }

    const now = Date.now();
    const spanMs = summary.lastChunkAt > summary.firstChunkAt ? summary.lastChunkAt - summary.firstChunkAt : 0;
    const averageBytes = Math.round(summary.totalBytes / summary.totalChunks);

    console.info("[binary.out.summary]", {
      sessionId: this.sessionId,
      reason,
      chunks: summary.totalChunks,
      totalBytes: summary.totalBytes,
      avgBytes: averageBytes,
      minBytes: summary.minBytes === Number.POSITIVE_INFINITY ? 0 : summary.minBytes,
      maxBytes: summary.maxBytes,
      spanMs,
      originCounts: summary.originCounts,
      originBytes: summary.originBytes,
    });

    this.binaryOutSummary = this.createBinarySummary();
    this.binaryOutSummary.lastLogAt = now;
  }

  private summarizeAudioChunks(chunks: ReadonlyArray<AudioChunk>): AudioChunkSummary {
    if (chunks.length === 0) {
      return { count: 0, totalBytes: 0, minBytes: 0, maxBytes: 0 };
    }

    let total = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const chunk of chunks) {
      const bytes = chunk.buffer.length;
      total += bytes;
      if (bytes < min) min = bytes;
      if (bytes > max) max = bytes;
    }
    return {
      count: chunks.length,
      totalBytes: total,
      minBytes: min === Number.POSITIVE_INFINITY ? 0 : min,
      maxBytes: max,
    };
  }

  private shouldEmitDiagnostics(
    events: SegmentEvent[],
    diagnostics: SegmenterDiagnosticsSummary,
    audioSummary: AudioChunkSummary,
    zeroAudioSegments: number
  ): boolean {
    if (events.length === 0) return false;
    if (zeroAudioSegments > 0) return true;
    if (diagnostics.bestCandidateLength > 0 && diagnostics.bestCandidateLength <= 4) return true;
    if (audioSummary.totalBytes === 0 && diagnostics.transcriptLength > 0) return true;
    return false;
  }

  private maybeEmitDiagnostics(
    events: SegmentEvent[],
    diagnostics: SegmenterDiagnosticsSummary,
    audioSummary: AudioChunkSummary,
    zeroAudioSegments: number
  ): void {
    if (!this.shouldEmitDiagnostics(events, diagnostics, audioSummary, zeroAudioSegments)) {
      return;
    }

    const signature = `${diagnostics.turnId}:${diagnostics.transcriptLength}:${diagnostics.partialLength}:${audioSummary.totalBytes}:${zeroAudioSegments}`;
    if (signature === this.lastDiagnosticsSignature) {
      return;
    }
    this.lastDiagnosticsSignature = signature;

    this.safeSendToClientJSON({
      event: "SEGMENT_DIAGNOSTICS",
      sessionId: this.sessionId,
      turnId: diagnostics.turnId,
      transcriptLength: diagnostics.transcriptLength,
      partialLength: diagnostics.partialLength,
      pendingTextCount: diagnostics.pendingTextCount,
      pendingTextLength: diagnostics.pendingTextLength,
      pendingAudioBytes: diagnostics.pendingAudioBytes,
      bestCandidateLength: diagnostics.bestCandidateLength,
      bestCandidatePreview: diagnostics.bestCandidatePreview,
      candidateCount: diagnostics.candidateCount,
      candidateSummaries: diagnostics.candidateSummaries,
      audioChunkCount: audioSummary.count,
      audioChunkBytes: audioSummary.totalBytes,
      audioChunkMin: audioSummary.minBytes,
      audioChunkMax: audioSummary.maxBytes,
      zeroAudioSegments,
    });
  }

  private flushPending(): void {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    while (this.pending.length > 0) {
      const message = this.pending.shift();
      if (!message) break;
      this.forwardClientMessage(message);
    }
  }

  private handleUpstreamMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      const buffer = toBuffer(data);
      if (buffer.length === 0) return;
      if (isUtf8(buffer)) {
        const text = buffer.toString("utf8");
        console.info("[up.msg.reclassified]", { bytes: buffer.length });
        this.processUpstreamText(text);
        return;
      }
      trace({
        event: "upstream.audio_chunk",
        data: {
          sessionId: this.sessionId,
          bytes: buffer.length,
          mimeType: DEFAULT_AUDIO_MIME,
        },
      });
      // クライアント側で逐次再生させるため、音声チャンクを即時中継する。
      this.safeSendToClientBinary(buffer);
      this.recordBinaryOut(buffer.length, "upstream_raw");
      const { events } = this.segmenter.handleUpstreamPayload(undefined, [
        { buffer, mimeType: DEFAULT_AUDIO_MIME },
      ]);
      for (const event of events) {
        this.safeSendToClientJSON(event);
      }
      return;
    }

    const text = typeof data === "string" ? data : toBuffer(data).toString("utf8");
    this.processUpstreamText(text);
  }

  private processUpstreamText(text: string): void {
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      this.safeSendToClientText(text);
      return;
    }

    // 🔍 生データのデバッグログ追加（PII考慮済み）
    this.logRawPayload(parsed);

    const { sanitized, audioChunks, goAwayDetected, sessionSnapshot } = extractAudioChunks(parsed);
    const turnEndDetected = detectTurnEnd(sanitized);
    if (turnEndDetected) {
      this.serverCompleteSeen = true;
    }
    const serverCompleteActive = this.serverCompleteForced || this.serverCompleteSeen;

    if (sessionSnapshot) {
      this.sessionSnapshot = sessionSnapshot;
      const snapshotRecord = sessionSnapshot as Record<string, unknown>;
      const maybeHandle =
        typeof snapshotRecord.handle === "string" ? (snapshotRecord.handle as string) : undefined;
      if (maybeHandle && maybeHandle !== this.sessionHandle) {
        this.sessionHandle = maybeHandle;
        console.info("[upstream.session_handle]", maybeHandle);
      }
    }

    if (goAwayDetected) {
      this.initiatePlannedReconnect("goAway");
    }

    if (audioChunks.length > 0) {
      for (const chunk of audioChunks) {
        trace({
          event: "upstream.audio_chunk",
          data: {
            sessionId: this.sessionId,
            bytes: chunk.buffer.length,
            mimeType: chunk.mimeType,
          },
        });
        // サーバ側で抽出したPCMチャンクも逐次クライアントへ送信する。
        this.safeSendToClientBinary(chunk.buffer);
        this.recordBinaryOut(chunk.buffer.length, "payload_extract");
      }
    }

    const segmentResult = this.segmenter.handleUpstreamPayload(sanitized, audioChunks);
    const segmentEvents = segmentResult.events;
    const diagnostics = this.segmenter.getDiagnosticsSummary();
    const audioSummary = this.summarizeAudioChunks(audioChunks);
    const zeroAudioSegments = segmentEvents.filter(
      (event): event is SegmentCommitMessage => event.event === "SEGMENT_COMMIT" && event.audioBytes === 0
    ).length;
    
    // segment_fallbackの検出とメトリクス記録
    if (zeroAudioSegments > 0) {
      metrics.zeroAudioSegmentDetected();
      console.warn("[debug.segment_fallback_detected]", {
        sessionId: this.sessionId,
        turnId: diagnostics.turnId,
        zeroAudioSegments,
        audioChunkCount: audioSummary.count,
        audioChunkBytes: audioSummary.totalBytes,
      });
    }
    this.maybeEmitDiagnostics(segmentEvents, diagnostics, audioSummary, zeroAudioSegments);
    const hasNewSegments = segmentEvents.some((event) => event.event === "SEGMENT_COMMIT");
    const { segmentCommitSummaries, turnCommitSummary } = this.dispatchSegmentEvents(segmentEvents, "stream");

    if (turnCommitSummary) {
      this.clearTurnFinalizationTimer();
      this.flushBinaryOutSummary("turn");
    }

    if (serverCompleteActive && (segmentCommitSummaries.length > 0 || turnCommitSummary)) {
      const lastCommit =
        segmentCommitSummaries.length > 0
          ? segmentCommitSummaries[segmentCommitSummaries.length - 1]
          : undefined;
      const pendingSnapshot = this.segmenter.getPendingSnapshot();
      trace({
        event: "segmentation.server_complete_observed",
        data: {
          sessionId: this.sessionId,
          turnId: turnCommitSummary?.turnId ?? lastCommit?.turnId ?? null,
          segmentCommits: segmentCommitSummaries,
          turnCommitIssued: Boolean(turnCommitSummary),
          source: serverCompleteDetected ? "payload" : this.serverCompleteForced ? "forced" : "cached",
          pendingTextCount: pendingSnapshot.pendingTextCount,
          pendingTextLength: pendingSnapshot.pendingTextLength,
          pendingAudioBytes: pendingSnapshot.pendingAudioBytes,
        },
      });
    }

    if (segmentResult.generationComplete) {
      this.flushBinaryOutSummary("generation");
      this.scheduleTurnFinalization();
    } else {
      this.maybeExtendTurnFinalization(hasNewSegments);
    }
  }

  private dispatchSegmentEvents(
    events: SegmentEvent[],
    reason: "stream" | "forced_close" | "timer"
  ): {
    segmentCommitSummaries: Array<{
      segmentId: string;
      turnId: number;
      index: number;
      durationMs: number;
      audioBytes: number;
      textLength: number;
      audioSamples: number;
    }>;
    turnCommitSummary?: { turnId: number; segmentCount: number; finalTextLength: number };
  } {
    const segmentCommitSummaries: Array<{
      segmentId: string;
      turnId: number;
      index: number;
      durationMs: number;
      audioBytes: number;
      textLength: number;
      audioSamples: number;
    }> = [];
    const segmentsByTurn = new Map<number, SegmentCommitMessage[]>();
    let turnCommitSummary: { turnId: number; segmentCount: number; finalTextLength: number } | undefined;

    for (const event of events) {
      if (event.event === "SEGMENT_COMMIT") {
        const commit = event as SegmentCommitMessage;
        segmentCommitSummaries.push({
          segmentId: commit.segmentId,
          turnId: commit.turnId,
          index: commit.index,
          durationMs: commit.nominalDurationMs ?? commit.durationMs,
          audioBytes: commit.audioBytes,
          textLength: commit.text.length,
          audioSamples: commit.audioSamples ?? Math.floor(commit.audioBytes / 2),
        });
        const bucket = segmentsByTurn.get(commit.turnId);
        if (bucket) {
          bucket.push(commit);
        } else {
          segmentsByTurn.set(commit.turnId, [commit]);
        }
        const traceData: Record<string, unknown> = {
          sessionId: this.sessionId,
          turnId: commit.turnId,
          segmentId: commit.segmentId,
          index: commit.index,
          nominalDurationMs: commit.nominalDurationMs ?? commit.durationMs,
          audioBytes: commit.audioBytes,
          textLength: commit.text.length,
          sampleCount: commit.audioSamples ?? Math.floor(commit.audioBytes / 2),
        };
        if (reason !== "stream") {
          traceData.reason = reason;
        }
        trace({ event: "segmentation.segment_commit_emitted", data: traceData });
      } else if (event.event === "TURN_COMMIT") {
        const commit = event as TurnCommitMessage;
        turnCommitSummary = {
          turnId: commit.turnId,
          segmentCount: commit.segmentCount,
          finalTextLength: commit.finalText.length,
        };
        const committedSegments = segmentsByTurn.get(commit.turnId) ?? [];
        const committedLength = committedSegments.reduce((sum, segment) => sum + segment.text.length, 0);
        const trimmedFinal = commit.finalText.trim();
        if (commit.segmentCount === 0 && trimmedFinal.length === 0) {
          metrics.emptyTurnCommitted();
          const traceData: Record<string, unknown> = {
            sessionId: this.sessionId,
            turnId: commit.turnId,
          };
          if (reason !== "stream") {
            traceData.reason = reason;
          }
          trace({ event: "segmentation.empty_turn_commit", data: traceData });
        }
        if (committedLength !== commit.finalText.length) {
          metrics.lengthMismatchDetected();
          const traceData: Record<string, unknown> = {
            sessionId: this.sessionId,
            turnId: commit.turnId,
            committedLength,
            finalLength: commit.finalText.length,
          };
          if (reason !== "stream") {
            traceData.reason = reason;
          }
          trace({ event: "segmentation.turn_length_mismatch", data: traceData });
        }
        segmentsByTurn.delete(commit.turnId);
        const traceData: Record<string, unknown> = {
          sessionId: this.sessionId,
          turnId: commit.turnId,
          segmentCount: commit.segmentCount,
          finalTextLength: commit.finalText.length,
        };
        if (reason !== "stream") {
          traceData.reason = reason;
        }
        trace({ event: "segmentation.turn_commit_emitted", data: traceData });
      }

      this.safeSendToClientJSON(event);
      if (event.event === "SEGMENT_COMMIT") {
        const payload: Record<string, unknown> = {
          sessionId: this.sessionId,
          turnId: event.turnId,
          segmentId: event.segmentId,
          index: event.index,
          durationMs: event.nominalDurationMs ?? event.durationMs,
          audioBytes: event.audioBytes,
          textLength: event.text.length,
        };
        if (reason !== "stream") {
          payload.reason = reason;
        }
        console.info("[segmentation.segment_commit]", payload);
      } else if (event.event === "TURN_COMMIT") {
        const payload: Record<string, unknown> = {
          sessionId: this.sessionId,
          turnId: event.turnId,
          segmentCount: event.segmentCount,
          finalTextLength: event.finalText.length,
        };
        if (reason !== "stream") {
          payload.reason = reason;
        }
        console.info("[segmentation.turn_commit]", payload);
      }
    }

    return { segmentCommitSummaries, turnCommitSummary };
  }

  private scheduleTurnFinalization(): void {
    this.clearTurnFinalizationTimer();
    this.turnFinalizationStartMs = Date.now();
    this.turnFinalizationExtended = false;
    this.turnFinalizationTranscriptLength = this.segmenter.getCurrentTranscriptLength();
    this.turnFinalizationTimer = setTimeout(() => {
      this.triggerTurnFinalization();
    }, 1800);
  }

  private maybeExtendTurnFinalization(hasNewSegments: boolean): void {
    if (!this.turnFinalizationTimer || this.turnFinalizationExtended) {
      return;
    }
    const currentLength = this.segmenter.getCurrentTranscriptLength();
    if (!hasNewSegments && currentLength <= this.turnFinalizationTranscriptLength) {
      return;
    }
    this.turnFinalizationExtended = true;
    this.turnFinalizationTranscriptLength = currentLength;
    const start = this.turnFinalizationStartMs ?? Date.now();
    const maxDeadline = start + 2100;
    const remaining = Math.max(maxDeadline - Date.now(), 50);
    clearTimeout(this.turnFinalizationTimer);
    this.turnFinalizationTimer = setTimeout(() => {
      this.triggerTurnFinalization();
    }, remaining);
  }

  private triggerTurnFinalization(): void {
    this.turnFinalizationTimer = undefined;
    this.turnFinalizationExtended = false;
    this.turnFinalizationStartMs = undefined;
    this.turnFinalizationTranscriptLength = 0;
    const result = this.segmenter.finalizeTurn({ force: true });
    if (result.events.length === 0) {
      return;
    }
    this.processTurnFinalizationResult(result, "timer");
  }

  private clearTurnFinalizationTimer(): void {
    if (this.turnFinalizationTimer) {
      clearTimeout(this.turnFinalizationTimer);
      this.turnFinalizationTimer = undefined;
    }
    this.turnFinalizationExtended = false;
    this.turnFinalizationStartMs = undefined;
    this.turnFinalizationTranscriptLength = 0;
  }

  private processTurnFinalizationResult(
    result: TurnFinalizationResult,
    reason: "timer" | "forced_close"
  ): void {
    this.clearTurnFinalizationTimer();
    const { segmentCommitSummaries, turnCommitSummary } = this.dispatchSegmentEvents(result.events, reason);
    if (!turnCommitSummary && segmentCommitSummaries.length === 0) {
      return;
    }

    const serverCompleteActive = this.serverCompleteForced || this.serverCompleteSeen;
    if (!serverCompleteActive) {
      return;
    }

    const lastCommit =
      segmentCommitSummaries.length > 0
        ? segmentCommitSummaries[segmentCommitSummaries.length - 1]
        : undefined;
    const pendingSnapshot = this.segmenter.getPendingSnapshot();
    trace({
      event: "segmentation.server_complete_observed",
      data: {
        sessionId: this.sessionId,
        turnId: turnCommitSummary?.turnId ?? lastCommit?.turnId ?? null,
        segmentCommits: segmentCommitSummaries,
        turnCommitIssued: Boolean(turnCommitSummary),
        source: this.serverCompleteForced ? "forced" : "payload",
        pendingTextCount: pendingSnapshot.pendingTextCount,
        pendingTextLength: pendingSnapshot.pendingTextLength,
        pendingAudioBytes: pendingSnapshot.pendingAudioBytes,
        reason,
      },
    });
  }

  private handleUpstreamClose(code: number, reason: string): void {
    if (this.closed) return;

    this.clearUpstreamTimers();

    if (this.reconnectRequested) {
      this.connectToUpstream("planned");
      return;
    }

    if (shouldRetryClose(code, reason)) {
      this.scheduleRetry("close");
      return;
    }

    const pendingBeforeClose: PendingStateSnapshot = this.segmenter.getPendingSnapshot();
    if (pendingBeforeClose.pendingTextCount > 0 || pendingBeforeClose.pendingAudioBytes > 0) {
      metrics.pendingAtCloseObserved();
      trace({
        event: "segmentation.pending_on_close",
        data: {
          sessionId: this.sessionId,
          pendingTextCount: pendingBeforeClose.pendingTextCount,
          pendingTextLength: pendingBeforeClose.pendingTextLength,
          pendingAudioBytes: pendingBeforeClose.pendingAudioBytes,
        },
      });
    }

    this.clearTurnFinalizationTimer();
    const forcedFinalization = this.segmenter.forceCompleteTurn();
    if (forcedFinalization.events.length > 0) {
      metrics.forcedCloseDropped();
      this.emitForcedFinalization(forcedFinalization);
    }

    this.safeSendToClientJSON({ event: "upstream_closed", code, reason });
    const truncatedReason = reason.slice(0, 120);
    this.client.close(code, truncatedReason);
    this.shutdown();
  }

  private scheduleRetry(reason: string): void {
    if (this.closed) return;
    if (this.reconnectTimeout) return;
    const delay = this.backoff.next();
    trace({ event: "upstream.retry_scheduled", data: { sessionId: this.sessionId, delay } });
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      this.connectToUpstream("retry:" + reason);
    }, delay);
  }

  /**
   * 上流切断時に残っていたイベントを強制送出し、メトリクスへ反映する。
   * @param result セグメンターが生成した最終イベント群
   */
  private emitForcedFinalization(result: TurnFinalizationResult): void {
    this.processTurnFinalizationResult(result, "forced_close");
  }

  private initiatePlannedReconnect(trigger: string): void {
    if (this.closed) return;
    if (this.reconnectRequested) return;
    trace({ event: "upstream.planned_reconnect", data: { sessionId: this.sessionId, trigger } });
    this.reconnectRequested = true;
    this.backoff.reset();
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.close(1012, "planned_reconnect");
    } else {
      this.connectToUpstream("planned");
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (env.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
      try {
        this.upstream.ping();
      } catch (error) {
        trace({ event: "upstream.ping_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
      }
    }, env.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private schedulePlannedReconnect(): void {
    if (env.plannedReconnectMaxMs <= 0) return;
    const min = env.plannedReconnectMinMs;
    const max = env.plannedReconnectMaxMs;
    const delay = min + Math.random() * Math.max(max - min, 1_000);

    if (this.plannedReconnectTimer) clearTimeout(this.plannedReconnectTimer);
    this.plannedReconnectTimer = setTimeout(() => {
      this.plannedReconnectTimer = undefined;
      this.initiatePlannedReconnect("timer");
    }, delay);
  }

  private clearUpstreamTimers(): void {
    if (this.plannedReconnectTimer) {
      clearTimeout(this.plannedReconnectTimer);
      this.plannedReconnectTimer = undefined;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.stopHeartbeat();
  }

  private sendToUpstream(payload: string): void {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    try {
      const buffer = Buffer.from(payload, "utf8");
      try {
        utf8Decoder.decode(buffer);
      } catch (error) {
        console.error("UTF-8エラー検出:", buffer.slice(0, 50).toString("hex"));
      }
      const isString = typeof payload === "string";
      const preview = isString ? payload.slice(0, 120) : "<binary>";
      console.info("[debug.send_to_upstream]", {
        type: typeof payload,
        length: isString ? payload.length : undefined,
        preview,
      });
      this.upstream.send(payload);
    } catch (error) {
      trace({ event: "upstream.send_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
    }
  }

  private safeSendToClientBinary(buffer: Buffer): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    try {
      this.client.send(buffer, { binary: true });
    } catch (error) {
      trace({ event: "client.send_binary_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
    }
  }

  private safeSendToClientText(text: string): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    try {
      this.client.send(text);
    } catch (error) {
      trace({ event: "client.send_text_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
    }
  }

  private safeSendToClientJSON(payload: unknown): void {
    if (payload === undefined || payload === null) return;
    try {
      const serialized = JSON.stringify(payload);
      this.safeSendToClientText(serialized);
    } catch (error) {
      trace({ event: "client.serialize_failed", data: { sessionId: this.sessionId, message: stringifyError(error) } });
    }
  }

  /**
   * 生ペイロードの構造化ログを出力（PII考慮済み）
   * @param payload Gemini Live APIから受信した生データ
   */
  private logRawPayload(payload: unknown): void {
    if (!isPlainObject(payload)) return;

    const record = payload as Record<string, unknown>;
    
    // serverContentとcandidates配列の詳細をログ化
    const debugInfo: Record<string, unknown> = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
    };

    // serverContentの分析
    if (record.serverContent) {
      debugInfo.hasServerContent = true;
      debugInfo.serverContentType = typeof record.serverContent;
      
      if (isPlainObject(record.serverContent)) {
        const serverContent = record.serverContent as Record<string, unknown>;
        debugInfo.serverContentKeys = Object.keys(serverContent);
        
        // candidates配列の詳細
        if (Array.isArray(serverContent.candidates)) {
          debugInfo.candidatesCount = serverContent.candidates.length;
          debugInfo.candidatesPreview = serverContent.candidates.slice(0, 3).map((candidate: unknown) => {
            if (isPlainObject(candidate)) {
              const cand = candidate as Record<string, unknown>;
              return {
                hasContent: !!cand.content,
                contentType: typeof cand.content,
                contentKeys: isPlainObject(cand.content) ? Object.keys(cand.content) : undefined,
                finishReason: cand.finishReason,
                // PIIを避けるため、テキスト内容は長さのみ記録
                textLength: this.extractTextLength(cand.content),
              };
            }
            return { type: typeof candidate };
          });
        }
      }
    }

    // generationConfigの確認
    if (record.generationConfig) {
      debugInfo.hasGenerationConfig = true;
      if (isPlainObject(record.generationConfig)) {
        const config = record.generationConfig as Record<string, unknown>;
        debugInfo.responseModalities = config.responseModalities;
        debugInfo.speechConfig = !!config.speechConfig;
      }
    }

    // その他の重要なフィールド
    if (record.event) debugInfo.event = record.event;
    if (record.serverComplete !== undefined) debugInfo.serverComplete = record.serverComplete;
    if (record.server_complete !== undefined) debugInfo.server_complete = record.server_complete;

    console.info("[debug.raw_payload_analysis]", debugInfo);
  }

  /**
   * テキストの長さを安全に抽出（PII回避）
   * @param content コンテンツオブジェクト
   * @returns テキストの長さ情報
   */
  private extractTextLength(content: unknown): { totalLength: number; partsLength?: number[] } | null {
    if (typeof content === "string") {
      return { totalLength: content.length };
    }
    
    if (isPlainObject(content)) {
      const record = content as Record<string, unknown>;
      
      // parts配列の処理
      if (Array.isArray(record.parts)) {
        const partsLength = record.parts.map((part: unknown) => {
          if (typeof part === "string") return part.length;
          if (isPlainObject(part) && typeof part.text === "string") {
            return part.text.length;
          }
          return 0;
        });
        const totalLength = partsLength.reduce((sum, len) => sum + len, 0);
        return { totalLength, partsLength };
      }
      
      // 直接テキストフィールドの処理
      if (typeof record.text === "string") {
        return { totalLength: record.text.length };
      }
    }
    
    return null;
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushBinaryOutSummary("shutdown");
    this.clearUpstreamTimers();
    this.clearTurnFinalizationTimer();
    metrics.sessionEnded();
    this.segmenter.reset();

    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.close(1000, "client_gone");
    }
    this.upstream = undefined;
  }
}

const stringifyError = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
};

const isAudioEnvelope = (
  value: Record<string, unknown>
): value is { type?: string; data: string; mimeType?: string; mime_type?: string } => {
  if (typeof value.data !== "string") return false;
  if (typeof value.type === "string" && value.type !== "audio") return false;
  const mime = pickMimeType(value);
  return typeof mime === "string" || value.type === "audio";
};

export const createGeminiProxy = (options: GeminiProxyOptions): GeminiLiveProxy => {
  return new GeminiLiveProxy(options);
};

export const handleGeminiProxyConnection = (client: WebSocket, request: IncomingMessage): void => {
  const proxy = createGeminiProxy({
    client,
    request,
    serverCompleteForced: env.serverCompleteForced,
  });
  proxy.start();
};
