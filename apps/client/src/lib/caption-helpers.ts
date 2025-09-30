export const AUDIO_ONLY_LABEL = "（音声のみ）";

export const CAPTION_ALLOWLIST: ReadonlyArray<RegExp> = [];

export const CAPTION_BLOCKLIST: ReadonlyArray<RegExp> = [
  /カメラが設定されていません/i,
  /マイク(が)?(利用|使用)できません/i,
  /マイクが設定されていません/i,
  /デバイス(が)?(見つかりません|接続されていません)/i,
  /このデバイスには対応していません/i,
  /私はAI(です)?/i,
  /ハードウェア\S*(エラー|障害)/i,
];

const TERMINAL_CHARACTERS = new Set(["。", "．", ".", "？", "?", "！", "!", "…"]);

const OUTPUT_TRANSCRIPTION_KEYS = new Set(["outputTranscription", "output_transcription"]);
const MODEL_TURN_KEYS = new Set(["modelTurn", "model_turn"]);
const SERVER_CONTENT_KEYS = new Set(["serverContent", "server_content"]);
const MAX_WALK_DEPTH = 12;

const getNestedString = (source: Record<string, unknown>, path: string[]): string | null => {
  let cursor: unknown = source;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : null;
};

export interface CaptionGuardResult {
  readonly sanitized: string | null;
  readonly reason?: string;
}

export const guardCaption = (text: string): CaptionGuardResult => {
  const normalized = text.trim();
  if (!normalized) return { sanitized: null, reason: "empty" };
  if (normalized === "?" || normalized === "？") {
    return { sanitized: null, reason: "placeholder" };
  }
  for (const allow of CAPTION_ALLOWLIST) {
    if (allow.test(normalized)) {
      return { sanitized: normalized };
    }
  }
  for (const block of CAPTION_BLOCKLIST) {
    if (block.test(normalized)) {
      return { sanitized: null, reason: `pattern:${block}` };
    }
  }
  return { sanitized: normalized };
};

export const extractCaption = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const serverText = getNestedString(record, ["serverContent", "outputTranscription", "text"]);
  if (typeof serverText === "string") return serverText;

  return findOutputTranscriptionText(record, 0, new Set());
};

const findOutputTranscriptionText = (
  value: unknown,
  depth: number,
  seen: Set<unknown>
): string | null => {
  if (depth > MAX_WALK_DEPTH || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findOutputTranscriptionText(entry, depth + 1, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of OUTPUT_TRANSCRIPTION_KEYS) {
    const container = record[key];
    if (container && typeof container === "object") {
      const text = (container as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text;
      }
    }
  }

  for (const key of MODEL_TURN_KEYS) {
    if (key in record) {
      const nested = findOutputTranscriptionText(record[key], depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
  }

  for (const key of SERVER_CONTENT_KEYS) {
    if (key in record) {
      const nested = findOutputTranscriptionText(record[key], depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
  }

  for (const child of Object.values(record)) {
    const nested = findOutputTranscriptionText(child, depth + 1, seen);
    if (nested) {
      return nested;
    }
  }

  return null;
};
