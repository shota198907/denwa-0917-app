const TERMINAL_CHARACTERS = new Set(["。", "．", ".", "？", "?", "！", "!", "…"]);

interface SentenceParseResult {
  readonly complete: string[];
  readonly partial: string;
}

const TEXT_CONTAINER_KEYS = new Set([
  "serverContent",
  "server_content",
  "modelResponse",
  "model_response",
  "response",
  "output",
  "outputs",
  "candidates",
  "content",
  "contents",
  "parts",
  "finalResponse",
  "final_response",
  "generations",
]);

const TEXT_VALUE_KEYS = new Set([
  "text",
  "finalText",
  "final_text",
  "responseText",
  "response_text",
  "outputText",
  "output_text",
  "transcript",
  "transcription",
]);

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * サニタイズ済みペイロードから最新の文字起こしを抽出する。
 * @param payload Live APIからのサーバイベント
 * @returns 最新の文字列。見つからなければnull。
 */
export const extractTranscript = (payload: unknown): string | null => {
  if (!isObject(payload)) return null;

  const direct = getNestedString(payload, ["serverContent", "outputTranscription", "text"]);
  if (direct) return direct;

  const candidates = collectTextCandidates(payload);
  return selectBestCandidate(candidates);
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

const collectTextCandidates = (
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): string[] => {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const aggregated: string[] = [];
    for (const entry of value) {
      aggregated.push(...collectTextCandidates(entry, depth + 1, seen));
    }
    return aggregated;
  }
  if (!isObject(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const results: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (TEXT_VALUE_KEYS.has(key) && typeof child === "string") {
      results.push(child);
      continue;
    }
    if (TEXT_CONTAINER_KEYS.has(key)) {
      results.push(...collectTextCandidates(child, depth + 1, seen));
      continue;
    }
  }
  return results;
};

export interface TranscriptCandidateDiagnostics {
  readonly bestCandidate: string | null;
  readonly bestCandidateScore: number;
  readonly candidates: ReadonlyArray<{
    readonly text: string;
    readonly length: number;
    readonly score: number;
    readonly preview: string;
  }>;
}

export const inspectTranscriptPayload = (payload: unknown): TranscriptCandidateDiagnostics | null => {
  if (!isObject(payload)) return null;

  const direct = getNestedString(payload, ["serverContent", "outputTranscription", "text"]);
  const rawCandidates = collectTextCandidates(payload);
  if (typeof direct === "string") {
    rawCandidates.push(direct);
  }

  const seen = new Set<string>();
  const summaries: Array<{ text: string; length: number; score: number; preview: string }> = [];
  let bestCandidate: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of rawCandidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    const score = computeCandidateScore(trimmed);
    if (score > bestScore || (score === bestScore && bestCandidate !== null && trimmed.length > bestCandidate.length)) {
      bestCandidate = trimmed;
      bestScore = score;
    }
    summaries.push({
      text: trimmed,
      length: trimmed.length,
      score,
      preview: trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 120)}…`,
    });
  }

  return {
    bestCandidate,
    bestCandidateScore: bestScore,
    candidates: summaries,
  };
};

const selectBestCandidate = (candidates: string[]): string | null => {
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    const score = computeCandidateScore(trimmed);
    if (score > bestScore || (score === bestScore && best !== null && trimmed.length > best.length)) {
      best = trimmed;
      bestScore = score;
    }
  }

  return best;
};

const computeCandidateScore = (text: string): number => {
  let score = text.length;
  const lastChar = text.length > 0 ? text[text.length - 1] : "";
  if (TERMINAL_CHARACTERS.has(lastChar)) {
    score += 10;
  }
  if (/\s/.test(text)) {
    score += 2;
  }
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    score += 1;
  }
  return score;
};
