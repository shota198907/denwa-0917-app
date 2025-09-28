/**
 * 文単位でGemini Live API応答を蓄積するトランスクリプトストア。
 * UI側はこのスナップショットを使って確定済みの文一覧や
 * 再生タイムラインを描画できる。
 */
export class TranscriptStore {
  private readonly turns = new Map<number, MutableTranscriptTurn>();
  private readonly turnOrder: number[] = [];
  private latestSentence: TranscriptSentence | null = null;

  /**
   * 音声セグメントと文のペアを確定させる。
   * @param payload SEGMENT_COMMITイベント由来のメタデータ
   * @returns 現在のトランスクリプトスナップショット
   */
  public commitSegment(payload: TranscriptSegmentPayload): TranscriptSnapshot {
    const turn = this.ensureTurn(payload.turnId);
    const durationSource =
      typeof payload.nominalDurationMs === "number" && Number.isFinite(payload.nominalDurationMs)
        ? payload.nominalDurationMs
        : payload.durationMs;
    const normalizedDuration = normalizeDuration(durationSource ?? 0);
    const sanitizedText = payload.text.trim();
    if (sanitizedText.length === 0) {
      return this.snapshot();
    }

    if (turn.sentences.some((sentence) => sentence.sentenceId === payload.segmentId)) {
      return this.snapshot();
    }

    const startMs = turn.elapsedMs;
    const endMs = startMs + normalizedDuration;

    const sentence: TranscriptSentence = {
      sentenceId: payload.segmentId,
      turnId: payload.turnId,
      index: payload.index,
      text: sanitizedText,
      startMs,
      endMs,
    };

    turn.sentences.push(sentence);
    turn.elapsedMs = endMs;
    turn.finalized = false;
    this.latestSentence = sentence;
    turn.sentences.sort((a, b) => a.index - b.index);
    return this.snapshot();
  }

  /**
   * ターン終了を確定させ、必要に応じてフォールバック文を追加する。
   * @param payload TURN_COMMITイベント由来の情報
   * @returns 現在のトランスクリプトスナップショット
   */
  public finalizeTurn(payload: TranscriptTurnCommitPayload): TranscriptSnapshot {
    const turn = this.ensureTurn(payload.turnId);
    turn.finalized = true;

    const fallback = payload.fallbackText?.trim?.();
    if (fallback && fallback.length > 0 && turn.sentences.length === 0) {
      const sentence: TranscriptSentence = {
        sentenceId: `${payload.turnId}-fallback`,
        turnId: payload.turnId,
        index: 0,
        text: fallback,
        startMs: turn.elapsedMs,
        endMs: turn.elapsedMs,
      };
      turn.sentences.push(sentence);
      this.latestSentence = sentence;
    }

    return this.snapshot();
  }

  /**
   * 全ターンを初期化する。
   * @returns 空のトランスクリプトスナップショット
   */
  public reset(): TranscriptSnapshot {
    this.turns.clear();
    this.turnOrder.length = 0;
    this.latestSentence = null;
    return this.snapshot();
  }

  /**
   * 現在の状態をスナップショットとして取得する。
   */
  public snapshot(): TranscriptSnapshot {
    const turns = this.turnOrder
      .map((turnId) => this.turns.get(turnId))
      .filter(Boolean)
      .map((turn) => ({
        turnId: turn!.turnId,
        finalized: turn!.finalized,
        sentences: turn!.sentences.slice(),
      }));

    const displayText = buildDisplayText(turns);
    return {
      turns,
      latestSentence: this.latestSentence,
      displayText,
    };
  }

  private ensureTurn(turnId: number): MutableTranscriptTurn {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        sentences: [],
        elapsedMs: 0,
        finalized: false,
      };
      this.turns.set(turnId, turn);
      this.turnOrder.push(turnId);
    }
    return turn;
  }
}

/**
 * SEGMENT_COMMITイベントから受け取る文情報。
 */
export interface TranscriptSegmentPayload {
  readonly segmentId: string;
  readonly turnId: number;
  readonly index: number;
  readonly text: string;
  readonly durationMs: number;
  readonly nominalDurationMs?: number;
}

/**
 * TURN_COMMITイベントから受け取るターン情報。
 */
export interface TranscriptTurnCommitPayload {
  readonly turnId: number;
  readonly finalText: string;
  readonly segmentCount: number;
  readonly fallbackText?: string | null;
}

/**
 * トランスクリプトの1文を表すメタデータ。
 */
export interface TranscriptSentence {
  readonly sentenceId: string;
  readonly turnId: number;
  readonly index: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * 1ターン分のトランスクリプト情報。
 */
export interface TranscriptTurnSnapshot {
  readonly turnId: number;
  readonly sentences: readonly TranscriptSentence[];
  readonly finalized: boolean;
}

/**
 * UIへ返却するトランスクリプトスナップショット。
 */
export interface TranscriptSnapshot {
  readonly turns: readonly TranscriptTurnSnapshot[];
  readonly latestSentence: TranscriptSentence | null;
  readonly displayText: string;
}

interface MutableTranscriptTurn {
  readonly turnId: number;
  sentences: TranscriptSentence[];
  elapsedMs: number;
  finalized: boolean;
}

const normalizeDuration = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
};

const buildDisplayText = (turns: readonly TranscriptTurnSnapshot[]): string => {
  const lines: string[] = [];
  for (const turn of turns) {
    for (const sentence of turn.sentences) {
      lines.push(sentence.text);
    }
    if (turn.finalized && turn.sentences.length > 0) {
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n+$/u, "");
};
