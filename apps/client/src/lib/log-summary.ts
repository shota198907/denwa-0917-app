/**
 * ログサマリーで利用する重要度を表す列挙型。
 */
export type SummaryLogImportance = "info" | "warn" | "error";

/**
 * サマリーログの1件分を表す構造体。
 */
export interface SummaryLogEntryPayload {
  readonly importance: SummaryLogImportance;
  readonly category: string;
  readonly message: string;
}

/**
 * ログ文字列を解析してサマリーログを生成するユーティリティ。
 */
export class SessionLogSummarizer {
  /**
   * 生ログを日本語のサマリーに変換する。
   * @param rawMessage LiveAudioSessionなどから受信した生ログ文字列
   * @returns サマリーに変換できた場合はSummaryLogEntryPayload、対象外ならnull
   */
  public summarize(rawMessage: string): SummaryLogEntryPayload | null {
    const trimmed = rawMessage.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = removeSessionPrefix(trimmed);
    const parsed = parseLogTag(normalized);
    if (!parsed) {
      return null;
    }

    const { tag, body } = parsed;
    switch (tag) {
      case "error":
        return createSimpleSummary("エラー", body, "error");
      case "warn":
        return createSimpleSummary("警告", body, "warn");
      case "info":
        return createSimpleSummary("情報", body, "info");
      case "ws":
        return summarizeWs(body);
      case "audio":
        return summarizeAudio(body);
      case "prompt":
        return summarizePrompt(body);
      case "vad":
        return summarizeVad(body);
      case "send:text":
        return summarizeSendText(body);
      case "recv:text":
        return summarizeRecvText(body);
      case "recv:parse-error":
        return createSimpleSummary("受信処理エラー", body, "error");
      case "recv:server-complete-ack":
        return createSimpleSummary("サーバ完了ACK", body, "info");
      case "binary:summary":
        return summarizeBinary(body);
      case "caption:commit":
        return summarizeCaptionCommit(body);
      case "caption:fallback":
        return summarizeCaptionFallback(body);
      case "caption:fallback-alert":
        return summarizeCaptionFallbackAlert(body);
      case "caption:metrics":
        return summarizeCaptionMetrics(body);
      case "caption:metrics.session":
        return summarizeCaptionMetricsSession(body);
      case "caption:final-timeout":
        return createSimpleSummary("字幕タイムアウト", body, "warn");
      case "flags":
        return createSimpleSummary("機能フラグ", body, "info");
      case "send":
        return createSimpleSummary("送信失敗", body, "warn");
      case "diag:segment":
        return summarizeSegmentDiagnostics(body);
      case "player:warn":
        return createSimpleSummary("プレーヤー警告", body, "warn");
      case "player:fallback":
        return createSimpleSummary("プレーヤーフォールバック", body, "warn");
      case "player:supersede":
        return createSimpleSummary("プレーヤー制御", body, "info");
      case "player:supersede-guard":
        return createSimpleSummary("プレーヤー制御", body, "warn");
      case "player:supersede-skip":
        return createSimpleSummary("プレーヤー制御", body, "info");
      case "player:flush":
        return createSimpleSummary("プレーヤーフラッシュ", body, "info");
      case "player:config":
        return createSimpleSummary("プレーヤー設定", body, "info");
      case "commit:segment-error":
        return createSimpleSummary("セグメント確定エラー", body, "error");
      case "tts":
        return createSimpleSummary("音声合成", body, "info");
      case "cap:display-trim":
        return createSimpleSummary("字幕整形", body, "info");
      default:
        return null;
    }
  }
}

/**
 * 先頭に付与されるセッションID部分を除去する。
 * @param message ログ文字列
 * @returns セッションIDを取り除いた後の文字列
 */
const removeSessionPrefix = (message: string): string => {
  return message.replace(/^\[session=[^\]]+\]\s*/, "");
};

/**
 * ログ文字列からタグと本文を抽出する。
 * @param message セッションID除去後の文字列
 * @returns タグと本文のセット。判別できない場合はnull
 */
const parseLogTag = (message: string): { tag: string; body: string } | null => {
  const match = message.match(/^\[([^\]]+)]\s*(.*)$/);
  if (!match) {
    return null;
  }
  const [, tag, body] = match;
  return { tag: tag.toLowerCase(), body };
};

/**
 * シンプルなタグ用の汎用サマリーを生成する。
 * @param category 表示用カテゴリ名
 * @param body タグ以降の本文
 * @param importance 重要度
 * @returns サマリーログ
 */
const createSimpleSummary = (
  category: string,
  body: string,
  importance: SummaryLogImportance
): SummaryLogEntryPayload => {
  return {
    category,
    importance,
    message: body.trim(),
  };
};

/**
 * WebSocket関連のログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー、対象外はnull
 */
const summarizeWs = (body: string): SummaryLogEntryPayload | null => {
  const normalized = body.trim();
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("connecting")) {
    const target = normalized.slice("connecting".length).trim();
    return {
      category: "WebSocket",
      importance: "info",
      message: target ? `接続開始: ${target}` : "接続開始",
    };
  }
  if (lower === "open" || lower.startsWith("open")) {
    return {
      category: "WebSocket",
      importance: "info",
      message: "接続が確立しました",
    };
  }
  if (lower.startsWith("error:")) {
    const detail = normalized.slice("error:".length).trim();
    return {
      category: "WebSocket",
      importance: "error",
      message: detail ? `エラー: ${detail}` : "エラーが発生しました",
    };
  }
  if (lower.startsWith("close")) {
    const kv = parseKeyValueSegments(normalized.slice("close".length));
    const code = kv.code ?? "unknown";
    const reason = kv.reason && kv.reason !== "(no" ? kv.reason : "未指定";
    return {
      category: "WebSocket",
      importance: "info",
      message: `切断 code=${code} reason=${reason}`,
    };
  }
  if (lower.includes("runtime error")) {
    return {
      category: "WebSocket",
      importance: "error",
      message: normalized,
    };
  }
  return {
    category: "WebSocket",
    importance: "info",
    message: normalized,
  };
};

/**
 * 音声入力関連のログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeAudio = (body: string): SummaryLogEntryPayload => {
  return {
    category: "音声入力",
    importance: body.includes("failed") ? "error" : "info",
    message: body.trim(),
  };
};

/**
 * サイレンス検知のログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizePrompt = (body: string): SummaryLogEntryPayload => {
  return {
    category: "サイレンス検知",
    importance: "info",
    message: body.trim(),
  };
};

/**
 * 音声活動検出(VAD)のログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeVad = (body: string): SummaryLogEntryPayload => {
  const normalized = body.trim();
  return {
    category: "VAD",
    importance: normalized.includes("ended") ? "info" : "info",
    message: normalized,
  };
};

/**
 * テキスト送信イベントを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeSendText = (body: string): SummaryLogEntryPayload => {
  return {
    category: "テキスト送信",
    importance: "info",
    message: `送信: ${truncate(body.trim(), 80)}`,
  };
};

/**
 * テキスト受信イベントを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeRecvText = (body: string): SummaryLogEntryPayload => {
  return {
    category: "テキスト受信",
    importance: "info",
    message: `受信: ${truncate(body.trim(), 80)}`,
  };
};

/**
 * バイナリ受信のサマリーログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeBinary = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const reason = kv.reason ?? "unknown";
  const chunks = kv.chunks ?? kv.chunkCount ?? "0";
  const bytes = kv.bytes ?? kv.totalBytes ?? "0";
  const span = kv.span_ms ?? kv.spanMs ?? "0";
  return {
    category: "音声受信",
    importance: "info",
    message: `受信サマリー reason=${reason} chunks=${chunks} bytes=${bytes} span_ms=${span}`,
  };
};

/**
 * 字幕確定ログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeCaptionCommit = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const reason = kv.reason ?? "unknown";
  const text = kv.text ?? "";
  const length = kv.length ?? "0";
  return {
    category: "字幕確定",
    importance: "info",
    message: `reason=${reason} length=${length} text=${text}`,
  };
};

/**
 * 字幕フォールバックログを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeCaptionFallback = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const reason = kv.reason ?? "unknown";
  const text = kv.text ?? "(textなし)";
  return {
    category: "字幕フォールバック",
    importance: "warn",
    message: text ? `reason=${reason} text=${text}` : `reason=${reason}`,
  };
};

/**
 * 字幕フォールバック率アラートを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeCaptionFallbackAlert = (body: string): SummaryLogEntryPayload => {
  return {
    category: "字幕フォールバック警告",
    importance: "warn",
    message: body.trim(),
  };
};

/**
 * ターン単位の字幕メトリクスを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeCaptionMetrics = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const commits = kv.turn_commits ?? kv.commits ?? "0";
  const fallback = kv.fallback ?? "0";
  return {
    category: "字幕メトリクス",
    importance: "info",
    message: `turn_commits=${commits} fallback=${fallback} detail=${body.trim()}`,
  };
};

/**
 * セッション全体の字幕メトリクスを整形する。
 * @param body タグ以降の本文
 * @returns 整形済みサマリー
 */
const summarizeCaptionMetricsSession = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const commits = kv.commits ?? "0";
  const audioRate = kv.audio ?? kv.audio_rate ?? "0";
  const shortRate = kv.short ?? kv.short_rate ?? "0";
  return {
    category: "字幕メトリクス(累計)",
    importance: "info",
    message: `commits=${commits} short=${shortRate} audio=${audioRate}`,
  };
};

const summarizeSegmentDiagnostics = (body: string): SummaryLogEntryPayload => {
  const kv = parseKeyValueSegments(body);
  const turn = kv.turn ?? kv.turnId ?? "n/a";
  const bestLen = kv.best_len ?? kv.bestCandidateLength ?? "0";
  const audioBytes = kv.audio_bytes ?? kv.audioChunkBytes ?? "0";
  const zeroSegments = kv.zero_segments ?? kv.zeroAudioSegments ?? "0";
  const preview = kv.preview ?? kv.bestCandidatePreview ?? "";
  const importance = parseInt(zeroSegments, 10) > 0 || parseInt(bestLen, 10) <= 4 ? "warn" : "info";
  const messageParts = [`turn=${turn}`, `best_len=${bestLen}`, `audio_bytes=${audioBytes}`, `zero_segments=${zeroSegments}`];
  if (preview) {
    messageParts.push(`preview=${preview}`);
  }
  return {
    category: "セグメント診断",
    importance,
    message: messageParts.join(" "),
  };
};

/**
 * スペース区切りのキー・バリュー列を解析する。
 * @param body キー・バリュー形式の文字列
 * @returns 解析済みの連想配列
 */
const parseKeyValueSegments = (body: string): Record<string, string> => {
  const result: Record<string, string> = {};
  let index = 0;
  const length = body.length;

  while (index < length) {
    while (index < length && body[index] === " ") {
      index += 1;
    }
    if (index >= length) {
      break;
    }

    const keyStart = index;
    while (index < length && body[index] !== "=" && body[index] !== " ") {
      index += 1;
    }
    if (index >= length || body[index] !== "=") {
      while (index < length && body[index] !== " ") {
        index += 1;
      }
      continue;
    }
    const key = body.slice(keyStart, index);
    index += 1; // skip '='
    const valueStart = index;

    while (index < length) {
      if (body[index] === " ") {
        let lookahead = index + 1;
        while (lookahead < length && body[lookahead] === " ") {
          lookahead += 1;
        }
        let cursor = lookahead;
        while (cursor < length && body[cursor] !== " " && body[cursor] !== "=") {
          cursor += 1;
        }
        if (cursor < length && body[cursor] === "=") {
          break;
        }
      }
      index += 1;
    }

    const value = body.slice(valueStart, index).trim();
    if (key) {
      result[key] = value;
    }
  }

  return result;
};

/**
 * 指定長に丸めて末尾に省略記号を付ける。
 * @param value 対象文字列
 * @param maxLength 最大長
 * @returns 丸め後の文字列
 */
const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
};
