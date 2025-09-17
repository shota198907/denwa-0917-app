import crypto from "node:crypto";
import { IncomingMessage } from "node:http";
import WebSocket from "ws";
import { env } from "../env";
import { createExponentialBackoff } from "./backoff";
import { AdaptiveRateLimiter } from "./rate-limit";
import { metrics } from "../observability/metrics";
import { trace } from "../observability/tracing";

interface PendingMessage {
  readonly data: WebSocket.RawData;
  readonly isBinary: boolean;
}

interface AudioChunk {
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

const toBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as string);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

      cloned[key] = walk(child);
    }

    return cloned;
  };

  const sanitized = walk(payload);
  return { sanitized, audioChunks, goAwayDetected, sessionSnapshot };
};

interface AudioExtractionResult {
  readonly chunk: AudioChunk;
  readonly sanitized: unknown;
}

const maybeExtractAudio = (value: unknown): AudioExtractionResult | undefined => {
  if (!isPlainObject(value)) return undefined;

  const directMime = typeof value.mimeType === "string" ? value.mimeType : undefined;
  const directData = typeof value.data === "string" ? value.data : undefined;

  if (directMime && directData && directMime.includes("audio")) {
    const buffer = Buffer.from(directData, "base64");
    const sanitized = { ...value, data: undefined, sizeBytes: buffer.length };
    return { chunk: { buffer, mimeType: directMime }, sanitized };
  }

  if (isPlainObject(value.inlineData)) {
    const mime = typeof value.inlineData.mimeType === "string" ? value.inlineData.mimeType : undefined;
    const data = typeof value.inlineData.data === "string" ? value.inlineData.data : undefined;
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedInline = { ...value.inlineData, data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, inlineData: sanitizedInline };
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.audio)) {
    const mime = typeof value.audio.mimeType === "string" ? value.audio.mimeType : undefined;
    const data = typeof value.audio.data === "string" ? value.audio.data : undefined;
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedAudio = { ...value.audio, data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, audio: sanitizedAudio };
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  if (isPlainObject(value.realtimeOutput)) {
    const mime = typeof value.realtimeOutput.mimeType === "string" ? value.realtimeOutput.mimeType : undefined;
    const data = typeof value.realtimeOutput.data === "string" ? value.realtimeOutput.data : undefined;
    if (mime && data && mime.includes("audio")) {
      const buffer = Buffer.from(data, "base64");
      const sanitizedRealtime = { ...value.realtimeOutput, data: undefined, sizeBytes: buffer.length };
      const sanitized = { ...value, realtimeOutput: sanitizedRealtime };
      return { chunk: { buffer, mimeType: mime }, sanitized };
    }
  }

  return undefined;
};

const randomId = (): string => crypto.randomBytes(6).toString("hex");

const normalizeModel = (modelId: string): string => {
  if (!modelId) return "models/gemini-live-2.5-flash-preview";
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
};

const buildSetupPayload = (sessionSnapshot?: Record<string, unknown>) => {
  const base: Record<string, unknown> = {
    setup: {
      model: normalizeModel(String(env.gemini.model)),
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: env.gemini.voiceName },
          },
        },
      },
      systemInstruction: "あなたは親切な日本語アシスタントです。",
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 300,
          silenceDurationMs: 800,
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      outputAudioTranscription: {},
      sessionResumption: { transparent: true },
      contextWindowCompression: { triggerTokens: 32000 },
    },
  };

  if (sessionSnapshot) {
    (base.setup as Record<string, unknown>).session = sessionSnapshot;
  }

  return base;
};

const shouldRetryClose = (code: number, reason: string): boolean => {
  if (RETRYABLE_CLOSE_CODES.has(code)) return true;
  if (code === 1000) return false;
  if (reason.includes("429")) return true;
  if (reason.startsWith("5")) return true;
  return false;
};

export interface GeminiProxyOptions {
  readonly client: WebSocket;
  readonly request: IncomingMessage;
}

export class GeminiLiveProxy {
  private readonly client: WebSocket;
  private upstream?: WebSocket;
  private readonly request: IncomingMessage;
  private readonly sessionId = randomId();
  private readonly backoff = createExponentialBackoff({ initialDelayMs: 500, maxDelayMs: 15_000 });
  private readonly audioLimiter = new AdaptiveRateLimiter();
  private readonly pending: PendingMessage[] = [];
  private plannedReconnectTimer?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private closed = false;
  private reconnectRequested = false;
  private sessionSnapshot?: Record<string, unknown>;

  constructor(options: GeminiProxyOptions) {
    this.client = options.client;
    this.request = options.request;
  }

  start(): void {
    metrics.sessionStarted();
    trace({ event: "session.start", data: { sessionId: this.sessionId } });
    this.bindClientEvents();
    this.connectToUpstream("initial");
  }

  private bindClientEvents(): void {
    this.client.on("message", (data, isBinary) => {
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

    console.info("[up.connect_attempt]", { url: env.gemini.wsUrl });
    trace({ event: "upstream.connect_attempt", data: { sessionId: this.sessionId, reason } });

    const upstream = new WebSocket(env.gemini.wsUrl, {
      perMessageDeflate: false,
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY! },
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
      this.handleUpstreamMessage(data, isBinary);
    });

    upstream.on("close", (code, reasonBuffer) => {
      const reasonText = reasonBuffer.toString();
      console.info("[up.close]", code, reasonBuffer?.toString?.());
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

    const payload = {
      realtimeInput: {
        mimeType: "audio/pcm;rate=16000",
        data: buffer.toString("base64"),
      },
    };

    this.sendToUpstream(JSON.stringify(payload));
    this.audioLimiter.markSuccess();
  }

  private forwardTextMessage(data: WebSocket.RawData): void {
    const text = typeof data === "string" ? data : toBuffer(data).toString("utf8");
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.sendToUpstream(text);
      return;
    }

    if (!isPlainObject(parsed)) {
      this.sendToUpstream(JSON.stringify(parsed));
      return;
    }

    if (isAudioEnvelope(parsed)) {
      const audioBase64 = String(parsed.data);
      if (!audioBase64) return;
      const mimeType = typeof parsed.mimeType === "string" ? parsed.mimeType : "audio/pcm;rate=16000";
      const payload = {
        realtimeInput: { mimeType, data: audioBase64 },
      };
      this.sendToUpstream(JSON.stringify(payload));
      return;
    }

    this.sendToUpstream(JSON.stringify(parsed));
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
      this.safeSendToClientBinary(toBuffer(data));
      return;
    }

    const text = typeof data === "string" ? data : toBuffer(data).toString("utf8");
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      this.safeSendToClientText(text);
      return;
    }

    const { sanitized, audioChunks, goAwayDetected, sessionSnapshot } = extractAudioChunks(parsed);

    if (sessionSnapshot) {
      this.sessionSnapshot = sessionSnapshot;
    }

    if (goAwayDetected) {
      this.initiatePlannedReconnect("goAway");
    }

    for (const chunk of audioChunks) {
      this.safeSendToClientBinary(chunk.buffer);
    }

    this.safeSendToClientJSON(sanitized);
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

    this.safeSendToClientJSON({ event: "upstream_closed", code, reason });
    this.client.close(code === 1000 ? 1000 : 1011, reason);
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
      const payload = { clientEvent: { event: "PING", sentAt: new Date().toISOString() } };
      this.sendToUpstream(JSON.stringify(payload));
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

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearUpstreamTimers();
    metrics.sessionEnded();

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

const isAudioEnvelope = (value: Record<string, unknown>): value is { type: string; data: string; mimeType?: string } => {
  if (value.type !== "audio") return false;
  return typeof value.data === "string";
};

export const createGeminiProxy = (options: GeminiProxyOptions): GeminiLiveProxy => {
    return new GeminiLiveProxy(options);
};

export const handleGeminiProxyConnection = (client: WebSocket, request: IncomingMessage): void => {
  const proxy = createGeminiProxy({ client, request });
  proxy.start();
};
