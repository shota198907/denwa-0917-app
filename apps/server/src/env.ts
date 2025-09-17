import assert from "node:assert";

export interface GeminiConfig {
  readonly apiKey: string | undefined;
  readonly wsUrl: string | undefined;
  readonly model: string;
  readonly voiceName: string;
}

export interface RuntimeConfig {
  readonly port: number;
  readonly allowedOrigin: string;
  readonly gemini: GeminiConfig;
  readonly plannedReconnectMinMs: number;
  readonly plannedReconnectMaxMs: number;
  readonly heartbeatIntervalMs: number;
}

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

export const env: RuntimeConfig = {
  port: numberFromEnv(process.env.PORT, 8080),
  allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    wsUrl: process.env.GEMINI_LIVE_WS_URL,
    model: pickModel(),
    voiceName: pickVoice(),
  },
  plannedReconnectMinMs: numberFromEnv(process.env.PLANNED_RECONNECT_MIN_MS, 8 * 60 * 1000),
  plannedReconnectMaxMs: numberFromEnv(process.env.PLANNED_RECONNECT_MAX_MS, 9 * 60 * 1000),
  heartbeatIntervalMs: numberFromEnv(process.env.UPSTREAM_HEARTBEAT_INTERVAL_MS, 30_000),
};

export const assertGeminiConfig = (): void => {
  assert(env.gemini.wsUrl, "GEMINI_LIVE_WS_URL is required");
  assert(env.gemini.apiKey, "GEMINI_API_KEY is required");
};
