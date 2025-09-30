import crypto from "node:crypto";
import { extractTranscript, parseSentences, isGenerationComplete } from "./transcription-utils";
import { env } from "../env";

const SEGMENT_DEBUG = env.debug.segment;

export interface FlushSummary {
  readonly events: SegmentEvent[];
  readonly emittedSegmentCount: number;
  readonly emittedTextLength: number;
  readonly remainingTextLength: number;
  readonly remainingAudioBytes: number;
}

export interface TurnFinalizationResult {
  readonly events: SegmentEvent[];
  readonly emittedTurnCommit: boolean;
  readonly emittedSegmentCount: number;
  readonly emittedTextLength: number;
  readonly pendingTextLength: number;
  readonly pendingAudioBytes: number;
}

export interface PendingStateSnapshot {
  readonly pendingTextCount: number;
  readonly pendingTextLength: number;
  readonly pendingAudioBytes: number;
}

export interface SegmentProcessingResult {
  readonly events: SegmentEvent[];
  readonly generationComplete: boolean;
}

export interface SegmenterDiagnosticsSummary {
  readonly turnId: number;
  readonly transcriptLength: number;
  readonly partialLength: number;
  readonly pendingTextCount: number;
  readonly pendingTextLength: number;
  readonly pendingAudioBytes: number;
}

export interface SegmentCommitMessage {
  readonly event: "SEGMENT_COMMIT";
  readonly segmentId: string;
  readonly turnId: number;
  readonly index: number;
  readonly text: string;
  readonly audio: string;
  readonly durationMs: number;
  readonly nominalDurationMs: number;
  readonly audioBytes: number;
  readonly audioSamples: number;
}

export interface TurnCommitMessage {
  readonly event: "TURN_COMMIT";
  readonly turnId: number;
  readonly finalText: string;
  readonly segmentCount: number;
}

export type SegmentEvent = SegmentCommitMessage | TurnCommitMessage;

export interface LiveSegmenterConfig {
  readonly sampleRate: number;
  readonly silenceThreshold: number;
  readonly silenceDurationMs: number;
  readonly maxPendingSegments: number;
}

const bytesToMillis = (bytes: number, sampleRate: number): number => {
  const samples = bytes / 2;
  return Math.round((samples / sampleRate) * 1000);
};

const randomId = (): string => crypto.randomBytes(6).toString("hex");

const MIN_SEGMENT_DURATION_MS = 300;
const PARTIAL_COMMIT_DELAY_MS = 1200;
const MIN_PARTIAL_TEXT_LENGTH = 8;

/**
 * Live APIの音声出力を文単位で切り出し、SEGMENT_COMMIT/TURN_COMMITイベントへ変換するオーケストレータ。
 */
export class LiveSegmenter {
  private readonly sampleRate: number;
  private readonly silenceThreshold: number;
  private readonly minSilenceSamples: number;
  private readonly maxPendingSegments: number;

  private readonly pendingAudio: Buffer[] = [];
  private readonly segmentedAudioQueue: Buffer[] = [];
  private pendingTexts: string[] = [];

  private currentTranscript = "";
  private currentPartial = "";
  private silenceRunSamples = 0;
  private committedCount = 0;
  private enqueuedCompleteCount = 0;
  private partialCommittedLength = 0;
  private partialLastUpdatedAt = 0;
  private turnId = 1;
  private segmentSequence = 0;

  public constructor(config: LiveSegmenterConfig) {
    this.sampleRate = config.sampleRate;
    this.silenceThreshold = config.silenceThreshold;
    this.maxPendingSegments = config.maxPendingSegments;
    this.minSilenceSamples = Math.max(1, Math.floor((config.silenceDurationMs / 1000) * this.sampleRate));
  }

  /**
   * 上流のサーバコンテンツを取り込み、必要に応じてSEGMENT_COMMIT/TURN_COMMITイベントを生成する。
   * @param payload 上流から受信したJSONペイロード
   * @param audioChunks 同ペイロード内に含まれる音声チャンク
   * @returns 生成されたイベント一覧
   */
  public handleUpstreamPayload(
    payload: unknown,
    audioChunks: ReadonlyArray<{ readonly buffer: Buffer; readonly mimeType: string }>
  ): SegmentProcessingResult {
    const events: SegmentEvent[] = [];

    this.ingestTranscript(payload);
    this.enqueuePartialIfNeeded(false);

    for (const chunk of audioChunks) {
      this.ingestAudioChunk(chunk.buffer);
    }

    const flush = this.flushPending({ force: false });
    events.push(...flush.events);

    const generationComplete = isGenerationComplete(payload);
    return { events, generationComplete };
  }

  public getDiagnosticsSummary(): SegmenterDiagnosticsSummary {
    const pendingTextCount = this.pendingTexts.length;
    const pendingTextLength = this.pendingTexts.reduce((sum, text) => sum + text.length, 0);
    const pendingAudioBytes = this.pendingAudio.reduce((sum, buffer) => sum + buffer.length, 0);
    const queuedAudioBytes = this.segmentedAudioQueue.reduce((sum, buffer) => sum + buffer.length, 0);
    return {
      turnId: this.turnId,
      transcriptLength: this.currentTranscript.length,
      partialLength: this.currentPartial.length,
      pendingTextCount,
      pendingTextLength,
      pendingAudioBytes: pendingAudioBytes + queuedAudioBytes,
    };
  }

  /**
   * 接続終了時に未処理の音声・テキストを破棄する。TURN_COMMITは送らず新たなターンへ備える。
   */
  public reset(): void {
    this.pendingAudio.length = 0;
    this.segmentedAudioQueue.length = 0;
    this.pendingTexts = [];
    this.currentTranscript = "";
    this.currentPartial = "";
    this.silenceRunSamples = 0;
    this.committedCount = 0;
    this.enqueuedCompleteCount = 0;
    this.partialCommittedLength = 0;
    this.partialLastUpdatedAt = 0;
    this.segmentSequence = 0;
  }

  private ingestTranscript(payload: unknown): void {
    const transcript = extractTranscript(payload);
    if (transcript === null) {
      return;
    }

    // 🔍 transcript処理の詳細ログ追加
    if (SEGMENT_DEBUG) {
      this.logTranscriptProcessing(transcript, payload);
    }

    const previousPartial = this.currentPartial;
    this.currentTranscript = transcript;
    const { complete, partial } = parseSentences(transcript);
    this.currentPartial = partial.trim();
    if (this.currentPartial.length > this.partialCommittedLength && this.currentPartial !== previousPartial) {
      this.partialLastUpdatedAt = Date.now();
    }
    if (this.partialCommittedLength > this.currentPartial.length) {
      this.partialCommittedLength = this.currentPartial.length;
    }

    if (complete.length < this.enqueuedCompleteCount) {
      this.pendingTexts.length = 0;
      this.enqueuedCompleteCount = complete.length;
      this.partialCommittedLength = 0;
    }

    if (complete.length > this.enqueuedCompleteCount) {
      for (let index = this.enqueuedCompleteCount; index < complete.length; index += 1) {
        const sentence = complete[index].trim();
        if (sentence.length === 0) {
          continue;
        }
        this.pendingTexts.push(sentence);
      }
      this.partialCommittedLength = 0;
      this.enqueuedCompleteCount = complete.length;
    }
  }

  /**
   * 文末まで到達していない部分文を条件に応じて送出キューへ追加する。
   * @param force 強制的に残テキストを送出する場合はtrue
   */
  private enqueuePartialIfNeeded(force: boolean): void {
    const partial = this.currentPartial.trim();
    if (partial.length === 0) {
      if (force) {
        this.partialCommittedLength = 0;
        this.partialLastUpdatedAt = 0;
      }
      return;
    }

    const hasNewCharacters = partial.length > this.partialCommittedLength;
    const timeSinceLastUpdate = Date.now() - this.partialLastUpdatedAt;
    
    if (SEGMENT_DEBUG) {
      // 🔍 部分文処理の詳細ログ
      console.info("[debug.partial_processing]", {
        turnId: this.turnId,
        partialLength: partial.length,
        partialPreview: partial.length <= 50 ? partial : `${partial.slice(0, 50)}...`,
        partialCommittedLength: this.partialCommittedLength,
        hasNewCharacters,
        timeSinceLastUpdate,
        force,
        timestamp: Date.now(),
      });
    }

    // タイムアウトによる強制送信の条件を追加
    const shouldForceByTimeout = timeSinceLastUpdate > PARTIAL_COMMIT_DELAY_MS && partial.length >= MIN_PARTIAL_TEXT_LENGTH;
    
    if (!force && !shouldForceByTimeout) {
      return;
    }

    if (!hasNewCharacters && !shouldForceByTimeout) {
      return;
    }

    // 強制送信時の詳細ログ
    if (shouldForceByTimeout && SEGMENT_DEBUG) {
      console.warn("[debug.partial_timeout_force_commit]", {
        turnId: this.turnId,
        partialLength: partial.length,
        timeSinceLastUpdate,
        reason: "timeout",
      });
    }

    this.commitAudioSegment();
    this.pendingTexts.push(partial);
    this.partialCommittedLength = partial.length;

    if (SEGMENT_DEBUG) {
      const preview = partial.length <= 80 ? partial : `${partial.slice(0, 80)}…`;
      const safePreview = JSON.stringify(preview);
      console.info(
        `[rx] partial=${safePreview}; buffer_len=${this.currentTranscript.trim().length}`
      );
    }
  }

  private ingestAudioChunk(buffer: Buffer): void {
    if (buffer.length === 0) {
      return;
    }

    let sliceStart = 0;
    for (let offset = 0; offset < buffer.length; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      if (Math.abs(sample) <= this.silenceThreshold) {
        this.silenceRunSamples += 1;
        if (this.silenceRunSamples >= this.minSilenceSamples) {
          const cutoff = offset + 2;
          const segmentPart = buffer.slice(sliceStart, cutoff);
          if (segmentPart.length > 0) {
            this.pendingAudio.push(segmentPart);
          }
          this.commitAudioSegment();
          sliceStart = cutoff;
          this.silenceRunSamples = 0;
        }
        continue;
      }

      this.silenceRunSamples = 0;
    }

    const remainder = buffer.slice(sliceStart);
    if (remainder.length > 0) {
      this.pendingAudio.push(remainder);
    }
  }

  private commitAudioSegment(): void {
    if (this.pendingAudio.length === 0) {
      return;
    }
    const segmentBuffer = Buffer.concat(this.pendingAudio);
    this.pendingAudio.length = 0;
    if (segmentBuffer.length === 0) {
      return;
    }
    this.segmentedAudioQueue.push(segmentBuffer);
    if (this.segmentedAudioQueue.length > this.maxPendingSegments) {
      this.segmentedAudioQueue.shift();
    }
  }

  /**
   * テキストと音声のキューを突き合わせてSEGMENT_COMMITイベントを生成する。
   * @param events 生成済みイベントの蓄積先
   * @param allowSilentAudio 音声が欠損していても送出する場合はtrue
   */
  private drainPairing(events: SegmentEvent[], allowSilentAudio = false): void {
    while (this.pendingTexts.length > 0) {
      const text = this.pendingTexts[0];
      if (!text) {
        this.pendingTexts.shift();
        continue;
      }

      let audioBuffer = this.segmentedAudioQueue.shift();
      if (!audioBuffer) {
        if (!allowSilentAudio) {
          break;
        }
        audioBuffer = Buffer.alloc(0);
      }

      this.pendingTexts.shift();
      const segmentId = `${this.turnId}-${++this.segmentSequence}-${randomId()}`;
      let durationMs = bytesToMillis(audioBuffer.length, this.sampleRate);

      while (audioBuffer.length > 0 && durationMs < MIN_SEGMENT_DURATION_MS && this.segmentedAudioQueue.length > 0) {
        const nextBuffer = this.segmentedAudioQueue.shift();
        if (!nextBuffer) {
          break;
        }
        audioBuffer = Buffer.concat([audioBuffer, nextBuffer]);
        durationMs = bytesToMillis(audioBuffer.length, this.sampleRate);
      }

      const audioSamples = Math.floor(audioBuffer.length / 2);
      const payload: SegmentCommitMessage = {
        event: "SEGMENT_COMMIT",
        segmentId,
        turnId: this.turnId,
        index: this.committedCount,
        text,
        audio: audioBuffer.toString("base64"),
        durationMs,
        nominalDurationMs: durationMs,
        audioBytes: audioBuffer.length,
        audioSamples,
      };
      events.push(payload);
      this.committedCount += 1;
      this.partialLastUpdatedAt = Date.now();
    }
  }

  /**
   * 現在のターンを完了させ、必要に応じてTURN_COMMITを生成する。
   * @param force 未確定要素を強制的に送出する場合はtrue
   */
  private finalizeTurnInternal(force: boolean): TurnFinalizationResult {
    this.enqueuePartialIfNeeded(force);
    const flush = this.flushPending({ force });
    const finalText = this.currentTranscript.trim();
    const segmentCountForTurn = this.committedCount;
    const shouldEmitTurnCommit =
      finalText.length > 0 || segmentCountForTurn > 0 || flush.emittedSegmentCount > 0;

    if (!shouldEmitTurnCommit) {
      this.prepareNextTurn();
      return {
        events: flush.events,
        emittedTurnCommit: false,
        emittedSegmentCount: flush.emittedSegmentCount,
        emittedTextLength: flush.emittedTextLength,
        pendingTextLength: flush.remainingTextLength,
        pendingAudioBytes: flush.remainingAudioBytes,
      };
    }

    const turnCommit: TurnCommitMessage = {
      event: "TURN_COMMIT",
      turnId: this.turnId,
      finalText,
      segmentCount: segmentCountForTurn,
    };
    const events = [...flush.events, turnCommit];
    this.prepareNextTurn();

    return {
      events,
      emittedTurnCommit: true,
      emittedSegmentCount: flush.emittedSegmentCount,
      emittedTextLength: flush.emittedTextLength,
      pendingTextLength: 0,
      pendingAudioBytes: 0,
    };
  }

  /**
   * 次のターンに向けて内部状態を初期化する。
   */
  private prepareNextTurn(): void {
    this.turnId += 1;
    this.committedCount = 0;
    this.segmentSequence = 0;
    this.pendingTexts.length = 0;
    this.segmentedAudioQueue.length = 0;
    this.pendingAudio.length = 0;
    this.currentTranscript = "";
    this.currentPartial = "";
    this.silenceRunSamples = 0;
    this.enqueuedCompleteCount = 0;
    this.partialCommittedLength = 0;
    this.partialLastUpdatedAt = 0;
  }

  /**
   * 現在のキューをフラッシュし、生成されたイベントと残量を返す。
   * @param options.force 音声欠損時も強制的に送出する場合はtrue
   */
  public flushPending(options: { force: boolean }): FlushSummary {
    const { force } = options;
    if (force) {
      this.commitAudioSegment();
    }

    const events: SegmentEvent[] = [];
    const beforeCount = this.committedCount;
    this.drainPairing(events, force);
    const emittedSegmentCount = this.committedCount - beforeCount;
    const emittedTextLength = events.reduce((sum, event) => {
      return event.event === "SEGMENT_COMMIT" ? sum + event.text.length : sum;
    }, 0);
    const remainingTextLength = this.pendingTexts.reduce((sum, text) => sum + text.length, 0);
    const remainingAudioBytes =
      this.pendingAudio.reduce((sum, buffer) => sum + buffer.length, 0) +
      this.segmentedAudioQueue.reduce((sum, buffer) => sum + buffer.length, 0);

    return { events, emittedSegmentCount, emittedTextLength, remainingTextLength, remainingAudioBytes };
  }

  /**
   * 未完了のターンを強制的に完了させる。
   */
  public finalizeTurn(options: { force: boolean }): TurnFinalizationResult {
    return this.finalizeTurnInternal(options.force);
  }

  public forceCompleteTurn(): TurnFinalizationResult {
    return this.finalizeTurnInternal(true);
  }

  /**
   * 現在のキュー残量を取得する。
   */
  public getPendingSnapshot(): PendingStateSnapshot {
    const pendingTextLength = this.pendingTexts.reduce((sum, text) => sum + text.length, 0);
    const pendingAudioBytes =
      this.pendingAudio.reduce((sum, buffer) => sum + buffer.length, 0) +
      this.segmentedAudioQueue.reduce((sum, buffer) => sum + buffer.length, 0);
    return {
      pendingTextCount: this.pendingTexts.length,
      pendingTextLength,
      pendingAudioBytes,
    };
  }

  /**
   * 現在保持している全文字列の長さを返す。
   */
  public getCurrentTranscriptLength(): number {
    return this.currentTranscript.length;
  }

  /**
   * transcript処理の詳細ログを出力
   * @param transcript 抽出されたtranscript
   * @param originalPayload 元のペイロード
   */
  private logTranscriptProcessing(transcript: string, originalPayload: unknown): void {
    const debugInfo = {
      turnId: this.turnId,
      timestamp: Date.now(),
      transcriptLength: transcript.length,
      transcriptPreview: transcript.length <= 100 ? transcript : `${transcript.slice(0, 100)}...`,
      previousTranscriptLength: this.currentTranscript.length,
      previousPartialLength: this.currentPartial.length,
      // ペイロードの構造分析
      payloadAnalysis: this.analyzePayloadStructure(originalPayload),
    };

    // 短いtranscriptや異常な状況を特にログ化
    if (transcript.length <= 5 || transcript.trim().length === 0) {
      console.warn("[debug.transcript_short]", debugInfo);
    } else if (transcript.length > this.currentTranscript.length + 50) {
      console.info("[debug.transcript_significant_growth]", debugInfo);
    } else {
      console.info("[debug.transcript_processing]", debugInfo);
    }
  }

  /**
   * ペイロードの構造を分析
   * @param payload 分析対象のペイロード
   */
  private analyzePayloadStructure(payload: unknown): Record<string, unknown> {
    if (typeof payload !== "object" || payload === null) {
      return { type: typeof payload };
    }

    const record = payload as Record<string, unknown>;
    const analysis: Record<string, unknown> = {
      type: "object",
      keys: Object.keys(record),
    };

    // serverContentの詳細分析
    if (record.serverContent) {
      analysis.hasServerContent = true;
      if (typeof record.serverContent === "object" && record.serverContent !== null) {
        const serverContent = record.serverContent as Record<string, unknown>;
        analysis.serverContentKeys = Object.keys(serverContent);
        analysis.serverContentFlags = {
          generationComplete: serverContent.generationComplete === true,
          turnComplete: serverContent.turnComplete === true,
        };
      }
    }

    // その他の重要なフィールド
    if (record.event) analysis.event = record.event;
    if (record.serverComplete !== undefined) analysis.serverComplete = record.serverComplete;
    if (record.server_complete !== undefined) analysis.server_complete = record.server_complete;

    return analysis;
  }
}
