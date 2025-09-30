import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const GLOBAL_ENV_KEY = "__denwaEnvLoaded";
const globalScope = globalThis as typeof globalThis & { [GLOBAL_ENV_KEY]?: boolean };

const loadEnvironmentVariables = (): void => {
  if (globalScope[GLOBAL_ENV_KEY]) return;

  const candidates: Array<{ readonly file: string; readonly override: boolean }> = [];

  if (process.env.DOTENV_CONFIG_PATH) {
    candidates.push({ file: process.env.DOTENV_CONFIG_PATH, override: true });
  }

  candidates.push({ file: ".env", override: false });
  candidates.push({ file: ".env.local", override: true });

  const cwd = process.cwd();
  const loadedPaths = new Set<string>();

  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate.file);
    if (loadedPaths.has(resolved)) continue;
    if (!fs.existsSync(resolved)) continue;
    dotenv.config({ path: resolved, override: candidate.override });
    loadedPaths.add(resolved);
  }

  globalScope[GLOBAL_ENV_KEY] = true;
};

loadEnvironmentVariables();

export interface GeminiConfig {
  readonly apiKey: string | undefined;
  readonly wsUrl: string | undefined;
  readonly model: string;
  readonly voiceName: string;
  readonly systemInstruction: string;
  readonly activityHandling: "START_OF_ACTIVITY_INTERRUPTS";
  readonly automaticActivityDetection: {
    readonly startOfSpeechSensitivity: string;
    readonly endOfSpeechSensitivity: string;
    readonly prefixPaddingMs: number;
    readonly silenceDurationMs: number;
  };
  readonly contextWindowCompressionTriggerTokens: number;
}

export interface DebugConfig {
  readonly segment: boolean;
  readonly binarySummary: boolean;
}

export interface RuntimeConfig {
  readonly port: number;
  readonly allowedOrigin: string;
  readonly gemini: GeminiConfig;
  readonly plannedReconnectMinMs: number;
  readonly plannedReconnectMaxMs: number;
  readonly heartbeatIntervalMs: number;
  readonly segmentation: SegmentationConfig;
  readonly serverCompleteForced: boolean;
  readonly debug: DebugConfig;
}

export interface SegmentationConfig {
  readonly sampleRate: number;
  readonly silenceThreshold: number;
  readonly silenceDurationMs: number;
  readonly maxPendingSegments: number;
}

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const booleanFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const pickModel = (): string => {
  const direct = process.env.GEMINI_LIVE_MODEL;
  if (direct && direct.length > 0) return direct;
  const defaultModel = process.env.DEFAULT_MODEL;
  if (defaultModel && defaultModel.length > 0) return defaultModel;
  return "gemini-live-2.5-flash-preview";
};

const pickVoice = (): string => {
  const direct = process.env.VOICE_NAME;
  if (direct && direct.length > 0) return direct;
  return "Kore";
};

const DEFAULT_SYSTEM_INSTRUCTION = [
  "\u3042\u306a\u305f\u306f\u4e2d\u7acb\u3067\u4eb2\u5207\u306a\u65e5\u672c\u8a9e\u306e\u30a2\u30b7\u30b9\u30bf\u30f3\u30c8\u3067\u3059\u3002",
  "\u5229\u7528\u8005\u306e\u767a\u8a00\u306b\u7b54\u3048\u308b\u969b\u306f\u3001\u5fc5\u305a\u5b8c\u6210\u3057\u305f\u6587\u5358\u4f4d\u3067\u8fd4\u4fe1\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  "\u53e5\u70b9\u3001\u9271\u70b9\u3001\u8a00\u306e\u7d42\u308f\u308a\u3092\u793a\u3059\u8a18\u53f7\u3092\u5fc5\u305a\u4ed8\u3051\u3001\u5177\u4f53\u7684\u306b\u306f\u300c\u3002\u300d\u300c\uff1f\u300d\u300c\uff01\u300d\u306a\u3069\u3067\u672b\u5c3e\u3092\u7d42\u308f\u3089\u305b\u3066\u304f\u3060\u3055\u3044\u3002",
  "\u672c\u6587\u4e2d\u306e\u672a\u78ba\u5b9a\u306a\u6587\u3092\u4e2d\u9014\u3067\u51fa\u529b\u305b\u305a\u3001\u6700\u7d42\u7684\u306b\u78ba\u5b9a\u3057\u305f\u6587\u306e\u307f\u3092\u97f3\u58f0\u3068\u6587\u5b57\u3067\u5236\u4f5c\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  "\u5185\u90e8\u72b6\u6cc1\u3084\u30c7\u30d0\u30a4\u30b9\u72b6\u614b\u306f\u30e6\u30fc\u30b6\u30fc\u304b\u3089\u306e\u660e\u78ba\u306a\u8a00\u53d6\u308a\u304c\u3042\u308b\u5834\u5408\u306b\u306e\u307f\u8aac\u660e\u3057\u307e\u3059\u3002",
].join("");

const pickSystemInstruction = (): string => {
  const direct = process.env.SYSTEM_INSTRUCTION;
  if (direct && direct.length > 0) return direct;
  return DEFAULT_SYSTEM_INSTRUCTION;
};

export const env: RuntimeConfig = {
  port: numberFromEnv(process.env.PORT, 8080),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    wsUrl: process.env.GEMINI_LIVE_WS_URL,
    model: pickModel(),
    voiceName: pickVoice(),
    systemInstruction: pickSystemInstruction(),
    activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    automaticActivityDetection: {
      startOfSpeechSensitivity: process.env.START_OF_SPEECH_SENSITIVITY ?? "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity: process.env.END_OF_SPEECH_SENSITIVITY ?? "END_SENSITIVITY_HIGH",
      prefixPaddingMs: numberFromEnv(process.env.PREFIX_PADDING_MS, 300),
      silenceDurationMs: numberFromEnv(process.env.SILENCE_DURATION_MS, 800),
    },
    contextWindowCompressionTriggerTokens: numberFromEnv(
      process.env.CONTEXT_WINDOW_COMPRESSION_TRIGGER_TOKENS,
      32_000
    ),
  },
  plannedReconnectMinMs: numberFromEnv(process.env.PLANNED_RECONNECT_MIN_MS, 8 * 60 * 1000),
  plannedReconnectMaxMs: numberFromEnv(process.env.PLANNED_RECONNECT_MAX_MS, 9 * 60 * 1000),
  heartbeatIntervalMs: numberFromEnv(process.env.UPSTREAM_HEARTBEAT_INTERVAL_MS, 30_000),
  segmentation: {
    sampleRate: numberFromEnv(process.env.OUTPUT_SAMPLE_RATE, 24_000),
    silenceThreshold: numberFromEnv(process.env.SEGMENT_SILENCE_THRESHOLD, 750),
    silenceDurationMs: numberFromEnv(process.env.SEGMENT_SILENCE_DURATION_MS, 320),
    maxPendingSegments: numberFromEnv(process.env.SEGMENT_MAX_PENDING, 8),
  },
  serverCompleteForced: booleanFromEnv(process.env.SERVER_COMPLETE_FORCED, false),
  debug: {
    segment: booleanFromEnv(process.env.SEGMENT_DEBUG, false),
    binarySummary: booleanFromEnv(process.env.BINARY_SUMMARY_DEBUG, false),
  },
};

export const assertGeminiConfig = (): void => {
  assert(env.gemini.wsUrl, "GEMINI_LIVE_WS_URL is required");
  assert(env.gemini.apiKey, "GEMINI_API_KEY is required");
};
