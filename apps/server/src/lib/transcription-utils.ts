const TERMINAL_CHARACTERS = new Set(["。", "．", ".", "？", "?", "！", "!", "…"]);

interface SentenceParseResult {
  readonly complete: string[];
  readonly partial: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const OUTPUT_TRANSCRIPTION_KEYS = new Set(["outputTranscription", "output_transcription"]);
const MODEL_TURN_KEYS = new Set(["modelTurn", "model_turn"]);
const SERVER_CONTENT_KEYS = new Set(["serverContent", "server_content"]);
const MAX_WALK_DEPTH = 12;

/**
 * サニタイズ済みペイロードから最新の文字起こしを抽出する。
 * @param payload Live APIからのサーバイベント
 * @returns 最新の文字列。見つからなければnull。
 */
export const extractTranscript = (payload: unknown): string | null => {
  if (!isObject(payload)) return null;

  const direct = getNestedString(payload, ["serverContent", "outputTranscription", "text"]);
  if (direct) return direct;

  return findOutputTranscriptionText(payload, 0, new Set());
};

/**
 * 文字列を文単位に分解し、終端済み文と末尾の部分文を返す。
 * @param source 最新の文字起こし
 */
export const parseSentences = (source: string): SentenceParseResult => {
  const complete: string[] = [];
  let buffer = "";

  for (const char of source) {
    buffer += char;
    if (TERMINAL_CHARACTERS.has(char)) {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        complete.push(trimmed);
      }
      buffer = "";
    }
  }

  return { complete, partial: buffer.trim() };
};

/**
 * generationCompleteフラグを検出する。
 * @param payload Live APIのサーバイベント
 */
export const isGenerationComplete = (payload: unknown): boolean => {
  if (!isObject(payload)) return false;
  if (payload.generationComplete === true) return true;
  if (payload.turnComplete === true) return true;
  const serverContent = payload.serverContent;
  if (isObject(serverContent)) {
    if (serverContent.generationComplete === true) return true;
    if (serverContent.turnComplete === true) return true;
  }
  const event = typeof payload.event === "string" ? payload.event.toLowerCase() : "";
  if (event === "finish" || event === "completed" || event === "turncomplete") return true;
  return false;
};

const getNestedString = (source: Record<string, unknown>, path: readonly string[]): string | null => {
  let cursor: unknown = source;
  for (const key of path) {
    if (!isObject(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : null;
};

const findOutputTranscriptionText = (
  value: unknown,
  depth: number,
  seen: Set<unknown>
): string | null => {
  if (depth > MAX_WALK_DEPTH) {
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

  if (!isObject(value)) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const key of OUTPUT_TRANSCRIPTION_KEYS) {
    const container = value[key];
    if (isObject(container)) {
      const text = container.text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text;
      }
    }
  }

  for (const key of MODEL_TURN_KEYS) {
    if (key in value) {
      const nested = findOutputTranscriptionText(value[key], depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
  }

  for (const key of SERVER_CONTENT_KEYS) {
    if (key in value) {
      const nested = findOutputTranscriptionText(value[key], depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
  }

  for (const child of Object.values(value)) {
    const nested = findOutputTranscriptionText(child, depth + 1, seen);
    if (nested) {
      return nested;
    }
  }

  return null;
};
