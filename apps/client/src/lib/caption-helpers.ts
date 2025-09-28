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

const getNestedString = (source: Record<string, unknown>, path: string[]): string | null => {
  let cursor: unknown = source;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : null;
};

const collectTextCandidates = (
  value: unknown,
  depth = 0,
  seen: Set<unknown> = new Set()
): string[] => {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const aggregated: string[] = [];
    for (const entry of value) {
      aggregated.push(...collectTextCandidates(entry, depth + 1, seen));
    }
    return aggregated;
  }
  if (typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const result: string[] = [];
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (TEXT_VALUE_KEYS.has(key) && typeof child === "string") {
      result.push(child);
      continue;
    }
    if (TEXT_CONTAINER_KEYS.has(key)) {
      result.push(...collectTextCandidates(child, depth + 1, seen));
      continue;
    }
  }
  return result;
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

  const candidates = collectTextCandidates(record);
  return selectBestCandidate(candidates);
};

const selectBestCandidate = (candidates: string[]): string | null => {
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const score = computeCandidateScore(trimmed);
    if (score > bestScore || (score === bestScore && best && trimmed.length > best.length)) {
      best = trimmed;
      bestScore = score;
    }
  }

  return best;
};

const computeCandidateScore = (text: string): number => {
  let score = text.length;
  const lastChar = text.length > 0 ? text[text.length - 1] : "";
  if (lastChar && TERMINAL_CHARACTERS.has(lastChar)) {
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
