const INPUT_SAMPLE_RATE = 24000; // 入力PCMは24kHz (PCM16)
const START_PLAYBACK_MS = 500;
const MAX_BUFFER_MS = 8000;
const DEFAULT_BUFFER_SECONDS = 3;

const EDGE_WINDOW_MS = 8;
const ZERO_CROSSING_SEARCH_MS = 6;
const PENDING_TAIL_FLUSH_SECONDS = 0.12;

const BASE_CROSSFADE_MS = 20;
const MIN_CROSSFADE_MS = 12;
const CROSSFADE_RMS_THRESHOLD = 0.02;
const CROSSFADE_RMS_MAX = 0.12;
const CROSSFADE_WARMUP_JOINS = 2;

const FADE_IN_MS = 80;
const QUEUE_LOW_THRESHOLD_MS = 220;

const EDGE_WINDOW_SAMPLES = Math.max(1, Math.floor((EDGE_WINDOW_MS / 1000) * INPUT_SAMPLE_RATE));
const ZERO_CROSSING_SEARCH_SAMPLES = Math.max(
  1,
  Math.floor((ZERO_CROSSING_SEARCH_MS / 1000) * INPUT_SAMPLE_RATE)
);
const BASE_CROSSFADE_SAMPLES = Math.max(1, Math.floor((BASE_CROSSFADE_MS / 1000) * INPUT_SAMPLE_RATE));
const MIN_CROSSFADE_SAMPLES = Math.max(1, Math.floor((MIN_CROSSFADE_MS / 1000) * INPUT_SAMPLE_RATE));

const EDGE_CURVES = createRaisedCosineCurves(EDGE_WINDOW_SAMPLES);

/**
 * raised-cosine窓を生成するユーティリティ。
 * @param {number} length サンプル長
 * @returns {{fadeIn: Float32Array, fadeOut: Float32Array}}
 */
function createRaisedCosineCurves(length) {
  const safeLength = Math.max(1, length);
  const fadeIn = new Float32Array(safeLength);
  const fadeOut = new Float32Array(safeLength);
  if (safeLength === 1) {
    fadeIn[0] = 1;
    fadeOut[0] = 1;
    return { fadeIn, fadeOut };
  }
  for (let i = 0; i < safeLength; i += 1) {
    const progress = i / (safeLength - 1);
    const gain = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    fadeIn[i] = gain;
    fadeOut[i] = 1 - gain;
  }
  return { fadeIn, fadeOut };
}

/**
 * raised-cosine 窓を即時生成する。
 * @param {number} length サンプル数
 */
function createDynamicRaisedCosine(length) {
  const safeLength = Math.max(1, length);
  const fadeIn = new Float32Array(safeLength);
  const fadeOut = new Float32Array(safeLength);
  if (safeLength === 1) {
    fadeIn[0] = 1;
    fadeOut[0] = 1;
    return { fadeIn, fadeOut };
  }
  for (let i = 0; i < safeLength; i += 1) {
    const progress = i / (safeLength - 1);
    const gain = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    fadeIn[i] = gain;
    fadeOut[i] = 1 - gain;
  }
  return { fadeIn, fadeOut };
}

/**
 * RMS(二乗平均平方根)を計算する。
 * @param {ArrayLike<number>} values 対象波形
 * @returns {number} RMS値
 */
function computeRms(values) {
  if (!values || values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const sample = values[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / values.length);
}

/**
 * 波形のピーク値(最大振幅)を求める。
 * @param {ArrayLike<number>} values 対象波形
 * @returns {number} 0〜1 の振幅
 */
function computePeak(values) {
  if (!values || values.length === 0) return 0;
  let peak = 0;
  for (let i = 0; i < values.length; i += 1) {
    const magnitude = Math.abs(values[i]);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return peak;
}

/**
 * 直近のゼロクロッシング位置を探索する。
 * @param {Float32Array} data 波形
 * @returns {number} シフトすべきサンプルオフセット
 */
function findZeroCrossingOffset(data) {
  const limit = Math.min(ZERO_CROSSING_SEARCH_SAMPLES, Math.max(0, data.length - 1));
  for (let i = 1; i <= limit; i += 1) {
    const prev = data[i - 1];
    const next = data[i];
    if ((prev <= 0 && next >= 0) || (prev >= 0 && next <= 0)) {
      return i;
    }
  }
  return 0;
}

/**
 * 単純な浮動小数リングバッファ。リアルタイム再生用の最低限の機能のみ保持。
 */
class FloatRingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity);
    this.storage = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
  }

  push(data) {
    if (!data || data.length === 0) return;
    for (let i = 0; i < data.length; i += 1) {
      const value = Number.isFinite(data[i]) ? data[i] : 0;
      if (this.available >= this.capacity) {
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.available -= 1;
      }
      this.storage[this.writeIndex] = value;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.available += 1;
    }
  }

  consume(count) {
    if (count <= 0) return;
    const clamped = Math.min(count, this.available);
    this.readIndex = (this.readIndex + clamped) % this.capacity;
    this.available -= clamped;
  }

  peek(offset = 0) {
    if (this.available === 0) return 0;
    const clampedOffset = Math.min(offset, this.available - 1);
    const index = (this.readIndex + clampedOffset) % this.capacity;
    return this.storage[index];
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
  }
}

/**
 * リアルタイム再生用プレーヤー。
 */
class Pcm24PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const bufferCapacity = Math.ceil(INPUT_SAMPLE_RATE * DEFAULT_BUFFER_SECONDS);
    this.ringBuffer = new FloatRingBuffer(bufferCapacity);
    this.consumeFraction = 0;

    this.lastDiagnosticSentAt = 0;
    this.playbackArmed = false;
    this.initialQueueMs = START_PLAYBACK_MS;
    this.minBufferSamples = Math.max(
      1,
      Math.floor((this.initialQueueMs / 1000) * INPUT_SAMPLE_RATE)
    );
    this.rearmMinSamples = Math.max(1, Math.floor((80 / 1000) * INPUT_SAMPLE_RATE));
    this.maxBufferSamples = Math.floor((MAX_BUFFER_MS / 1000) * INPUT_SAMPLE_RATE);

    this.currentEpoch = 0;
    this.totalDropped = 0;
    this.lastDiagnosticDropped = 0;
    this.lastVoiceCount = 0;
    this.joinCount = 0;
    this.hasPlayed = false;
    this.firstPlaybackAt = null;
    this.firstPlaybackQueueMs = null;
    this.firstPlaybackLeadMs = null;
    this.trimGraceMs = 0;
    this.trimGraceAccepts = 0;
    this.startLeadMs = 0;
    this.pendingLeadSamples = 0;
    this.sentencePauseMs = 0;
    this.sentencePauseSamples = 0;
    this.armSupersedeQuietMs = 0;
    this.lastSupersedeTime = null;
    this.pendingTail = null;
    this.pendingTailTimestamp = null;
    this.lastJoinStrategy = "crossfade";

    this.crossfadeMaxSamples = BASE_CROSSFADE_SAMPLES;
    this.crossfadeMinSamples = MIN_CROSSFADE_SAMPLES;
    this.fadeInSamplesTotal = Math.max(1, Math.floor((FADE_IN_MS / 1000) * sampleRate));
    this.fadeInSamplesRemaining = this.fadeInSamplesTotal;
    this.queueLowThresholdMs = QUEUE_LOW_THRESHOLD_MS;
    this.queueLowThresholdSamples = Math.max(
      1,
      Math.floor((this.queueLowThresholdMs / 1000) * INPUT_SAMPLE_RATE)
    );
    this.queueLowActive = false;
    this.underrunActive = false;
    this.resampleRatio = INPUT_SAMPLE_RATE / sampleRate;

    this.port.onmessage = (event) => {
      const { data } = event;
      if (!data || typeof data !== "object") return;
      if (data.type === "push" && data.buffer instanceof ArrayBuffer) {
        this.handlePushMessage(data);
        return;
      }
      if (data.type === "flush" || data.type === "clear" || data.type === "soft_flush") {
        this.flush();
        return;
      }
      if (data.type === "epoch" && typeof data.epoch === "number") {
        this.applyEpoch(
          Number(data.epoch),
          typeof data.contextTime === "number" ? Number(data.contextTime) : undefined
        );
        return;
      }
      if (data.type === "config") {
        this.applyConfig(data);
      }
    };

    this.port.postMessage({
      type: "context_info",
      detail: {
        sampleRate: sampleRate,
        inputSampleRate: INPUT_SAMPLE_RATE,
        resampleRatio: this.resampleRatio,
        fadeWindowMs: EDGE_WINDOW_MS,
        crossfadeMinMs: MIN_CROSSFADE_MS,
      },
    });
  }

  flush() {
    this.ringBuffer.clear();
    this.consumeFraction = 0;
    this.playbackArmed = false;
    this.hasPlayed = false;
    this.firstPlaybackAt = null;
    this.pendingLeadSamples = 0;
    this.firstPlaybackQueueMs = null;
    this.firstPlaybackLeadMs = null;
    this.pendingTail = null;
    this.pendingTailTimestamp = null;
    this.joinCount = 0;
    this.fadeInSamplesRemaining = 0; // フェードインは初回再生のみ適用
    this.queueLowActive = false;
    this.underrunActive = false;
  }

  handlePushMessage(message) {
    const buffer = message.buffer;
    if (!(buffer instanceof ArrayBuffer)) return;
    const messageEpoch = typeof message.epoch === "number" ? Number(message.epoch) : this.currentEpoch;
    const behind = this.currentEpoch - messageEpoch;
    if (behind > 0) {
      if (!this.hasPlayed && behind <= 1) {
        this.trimGraceAccepts += 1;
      } else {
        this.totalDropped += 1;
        return;
      }
    }
    if (messageEpoch > this.currentEpoch) {
      this.applyEpoch(messageEpoch, currentTime);
    }
    this.enqueuePcmBuffer(buffer);
  }

  applyEpoch(epoch, contextTime) {
    if (!Number.isFinite(epoch)) return;
    if (epoch === this.currentEpoch) return;
    if (this.ringBuffer.available > 0) {
      this.totalDropped += 1;
    }
    this.currentEpoch = epoch;
    this.lastSupersedeTime = typeof contextTime === "number" ? contextTime : currentTime;
    this.flush();
  }

  enqueuePcmBuffer(buffer) {
    const floats = this.convertPcm16ToFloat32(buffer);
    if (floats.length === 0) {
      this.port.postMessage({ type: "enqueue_empty" });
      return;
    }
    const offset = findZeroCrossingOffset(floats);
    const aligned = offset > 0 ? floats.subarray(offset) : floats;
    this.applyEdgeWindow(aligned);
    const peak = computePeak(aligned);
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
    this.port.postMessage({
      type: "chunk_metrics",
      detail: {
        samples: aligned.length,
        peak,
        peakDb,
        resampleRatio: this.resampleRatio,
        sampleRate,
        equalPowerFadeMs: (this.crossfadeMinSamples / INPUT_SAMPLE_RATE) * 1000,
      },
    });
    this.processChunk(aligned);
    this.postDiagnostic();
  }

  convertPcm16ToFloat32(buffer) {
    const view = new DataView(buffer);
    const sampleCount = Math.floor(buffer.byteLength / 2);
    const floats = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      const int16 = view.getInt16(i * 2, true);
      floats[i] = int16 / 32768;
    }
    return floats;
  }

  applyEdgeWindow(chunk) {
    if (!chunk || chunk.length === 0) return;
    const headCount = Math.min(EDGE_WINDOW_SAMPLES, chunk.length);
    const tailCount = Math.min(EDGE_WINDOW_SAMPLES, chunk.length);
    const headOffset = EDGE_CURVES.fadeIn.length - headCount;
    for (let i = 0; i < headCount; i += 1) {
      chunk[i] *= EDGE_CURVES.fadeIn[headOffset + i];
    }
    const tailOffset = EDGE_CURVES.fadeOut.length - tailCount;
    const start = chunk.length - tailCount;
    for (let i = 0; i < tailCount; i += 1) {
      chunk[start + i] *= EDGE_CURVES.fadeOut[tailOffset + i];
    }
  }

  processChunk(chunk) {
    if (!chunk || chunk.length === 0) {
      this.port.postMessage({ type: "enqueue_empty" });
      return;
    }

    let offset = 0;
    if (this.pendingTail && this.pendingTail.length > 0) {
      const maxCrossfade = Math.min(this.pendingTail.length, this.crossfadeMaxSamples, chunk.length);
      const strategy = this.computeJoinStrategy(this.pendingTail, chunk, maxCrossfade);

      if (strategy.mode === "crossfade" && strategy.length > 0) {
        const tailSlice = this.pendingTail.subarray(this.pendingTail.length - strategy.length);
        const headSlice = chunk.subarray(0, strategy.length);
        const blended = this.buildCrossfade(tailSlice, headSlice);
        this.enqueueSamples(blended);
        offset = strategy.length;
        this.emitJoinMetrics(strategy.label, strategy.length, strategy.rmsBefore, strategy.rmsAfter, strategy.rmsDelta);
      } else {
        // クロスフェードなしで保留分をそのまま出力
        this.enqueueSamples(this.pendingTail);
        offset = 0;
        this.emitJoinMetrics(strategy.label, 0, strategy.rmsBefore, strategy.rmsAfter, strategy.rmsDelta);
      }
      this.joinCount += 1;
      this.pendingTail = null;
      this.pendingTailTimestamp = null;
    }

    const remaining = chunk.length - offset;
    if (remaining <= 0) {
      return;
    }

    const tailLength = Math.min(this.crossfadeMaxSamples, remaining);
    const bodyLength = remaining - tailLength;
    if (bodyLength > 0) {
      const body = chunk.subarray(offset, offset + bodyLength);
      this.enqueueSamples(body);
    }

    if (tailLength > 0) {
      const tailStart = chunk.length - tailLength;
      const tailView = chunk.subarray(tailStart);
      this.pendingTail = new Float32Array(tailView.length);
      this.pendingTail.set(tailView);
      this.pendingTailTimestamp = currentTime;
    } else {
      this.pendingTail = null;
      this.pendingTailTimestamp = null;
    }
  }

  buildCrossfade(tailSlice, headSlice) {
    const length = Math.min(tailSlice.length, headSlice.length);
    if (length <= 0) return new Float32Array(0);
    if (length === EDGE_CURVES.fadeIn.length) {
      const blended = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        blended[i] = tailSlice[i] * EDGE_CURVES.fadeOut[i] + headSlice[i] * EDGE_CURVES.fadeIn[i];
      }
      return blended;
    }
    const { fadeIn, fadeOut } = createDynamicRaisedCosine(length);
    const blended = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      blended[i] = tailSlice[i] * fadeOut[i] + headSlice[i] * fadeIn[i];
    }
    return blended;
  }

  computeJoinStrategy(tail, head, maxSamples) {
    const metricsSamples = Math.max(1, Math.min(maxSamples > 0 ? maxSamples : BASE_CROSSFADE_SAMPLES, tail.length, head.length));
    const tailMetrics = tail.subarray(tail.length - metricsSamples);
    const headMetrics = head.subarray(0, metricsSamples);
    const rmsBefore = computeRms(tailMetrics);
    const rmsAfter = computeRms(headMetrics);
    const rmsDelta = rmsAfter - rmsBefore;

    let length = 0;
    let label = "low_delta";

    if (this.joinCount < CROSSFADE_WARMUP_JOINS) {
      label = `warmup_${this.joinCount + 1}`;
    } else {
      const deltaAbs = Math.abs(rmsDelta);
      if (deltaAbs >= CROSSFADE_RMS_THRESHOLD) {
        const normalized = Math.min(deltaAbs / CROSSFADE_RMS_MAX, 1);
        const targetMs = MIN_CROSSFADE_MS + (BASE_CROSSFADE_MS - MIN_CROSSFADE_MS) * normalized;
        length = Math.max(this.crossfadeMinSamples, Math.floor((targetMs / 1000) * INPUT_SAMPLE_RATE));
        length = Math.min(length, Math.min(maxSamples, tail.length, head.length));
        label = "crossfade";
      }
    }

    return {
      mode: length > 0 ? "crossfade" : "append",
      length,
      label,
      rmsBefore,
      rmsAfter,
      rmsDelta,
    };
  }

  enqueueSamples(view) {
    if (!view || view.length === 0) {
      this.port.postMessage({ type: "enqueue_empty" });
      return;
    }
    this.ringBuffer.push(view);
    this.ensurePlaybackReadiness();
  }

  ensurePlaybackReadiness() {
    const availableMs = (this.ringBuffer.available / INPUT_SAMPLE_RATE) * 1000;
    const requiredForArm = this.hasPlayed
      ? Math.min(this.minBufferSamples, this.rearmMinSamples)
      : this.minBufferSamples;
    if (!this.playbackArmed && this.ringBuffer.available >= requiredForArm) {
      if (this.armSupersedeQuietMs > 0 && this.lastSupersedeTime !== null) {
        const sinceSupersedeMs = Math.max(0, (currentTime - this.lastSupersedeTime) * 1000);
        if (sinceSupersedeMs < this.armSupersedeQuietMs) {
          this.port.postMessage({
            type: "arm_blocked",
            detail: {
              sinceSupersedeMs,
              requiredMs: this.armSupersedeQuietMs,
              queuedMs: availableMs,
            },
          });
          return;
        }
      }
      this.playbackArmed = true;
      this.pendingLeadSamples = Math.max(0, Math.floor((this.startLeadMs / 1000) * sampleRate));
      if (this.hasPlayed && this.sentencePauseSamples > 0) {
        this.pendingLeadSamples += this.sentencePauseSamples;
        this.port.postMessage({
          type: "pause_inserted",
          detail: { ms: this.sentencePauseMs, reason: "rearm" },
        });
      }
      if (this.firstPlaybackQueueMs === null) {
        this.firstPlaybackQueueMs = (this.ringBuffer.available / INPUT_SAMPLE_RATE) * 1000;
      }
      if (this.firstPlaybackLeadMs === null) {
        this.firstPlaybackLeadMs = this.startLeadMs;
      }
      this.port.postMessage({ type: "playback_armed" });
    }

    if (
      this.hasPlayed &&
      this.playbackArmed &&
      this.ringBuffer.available > 0 &&
      availableMs <= this.queueLowThresholdMs
    ) {
      if (!this.queueLowActive) {
        this.queueLowActive = true;
        this.port.postMessage({
          type: "queue_low",
          detail: {
            queuedMs: availableMs,
            samples: this.ringBuffer.available,
            epoch: this.currentEpoch,
          },
        });
      }
    } else if (this.queueLowActive && availableMs > this.queueLowThresholdMs) {
      this.queueLowActive = false;
    }

    if (!this.hasPlayed && availableMs < this.initialQueueMs) {
      return;
    }

    const nowMs = currentTime * 1000;
    const overflow = this.ringBuffer.available - this.maxBufferSamples;
    if (overflow > 0) {
      const withinGrace =
        !this.hasPlayed ||
        (this.trimGraceMs > 0 && this.firstPlaybackAt !== null && nowMs - this.firstPlaybackAt <= this.trimGraceMs);
      if (withinGrace) {
        this.trimGraceAccepts += 1;
        return;
      }
      this.ringBuffer.consume(overflow);
      const droppedMs = (overflow / INPUT_SAMPLE_RATE) * 1000;
      this.port.postMessage({
        type: "buffer_trimmed",
        detail: { droppedSamples: overflow, droppedMs },
      });
    }
  }

  emitJoinMetrics(label, samples, rmsBefore, rmsAfter, rmsDelta) {
    const xfadeMs = (samples / INPUT_SAMPLE_RATE) * 1000;
    this.port.postMessage({
      type: "join_metrics",
      detail: {
        label,
        xfadeMs,
        rmsBefore,
        rmsAfter,
        rmsDelta,
      },
    });
  }

  flushPendingTailIfExpired() {
    if (!this.pendingTail || this.pendingTail.length === 0) return;
    if (this.pendingTailTimestamp === null) return;
    const elapsed = currentTime - this.pendingTailTimestamp;
    const queueLow = this.ringBuffer.available <= this.crossfadeMaxSamples * 2;
    if (elapsed < PENDING_TAIL_FLUSH_SECONDS && !queueLow) return;

    const length = this.pendingTail.length;
    const fadeOffset = EDGE_CURVES.fadeOut.length - length;
    const flushed = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const fade = EDGE_CURVES.fadeOut[fadeOffset + i];
      flushed[i] = this.pendingTail[i] * fade;
    }
    this.enqueueSamples(flushed);
    this.emitJoinMetrics("flush", length, computeRms(this.pendingTail), computeRms(flushed), computeRms(flushed) - computeRms(this.pendingTail));
    this.pendingTail = null;
    this.pendingTailTimestamp = null;
  }

  postDiagnostic() {
    const now = currentTime;
    if (now - this.lastDiagnosticSentAt < 0.25) return;
    this.lastDiagnosticSentAt = now;
    const queuedMs = (this.ringBuffer.available / INPUT_SAMPLE_RATE) * 1000;
    const voiceCount = this.playbackArmed && this.ringBuffer.available > 0 ? 1 : 0;
    const droppedSinceLast = this.totalDropped - this.lastDiagnosticDropped;
    this.lastDiagnosticDropped = this.totalDropped;
    this.lastVoiceCount = voiceCount;
    this.port.postMessage({
      type: "diagnostic",
      detail: {
        queuedMs,
        availableSamples: this.ringBuffer.available,
        capacitySamples: this.ringBuffer.capacity,
        voiceCount,
        epoch: this.currentEpoch,
        droppedBuffers: this.totalDropped,
        droppedSinceLast,
        hasPlayed: this.hasPlayed,
        firstPlaybackAt: this.firstPlaybackAt,
        trimGraceAccepts: this.trimGraceAccepts,
        startLeadMs: this.startLeadMs,
        initialQueueMs: this.initialQueueMs,
        trimGraceMs: this.trimGraceMs,
        firstPlaybackQueueMs: this.firstPlaybackQueueMs,
        firstPlaybackLeadMs: this.firstPlaybackLeadMs,
      },
    });
  }

  process(_inputs, outputs) {
    const output = outputs?.[0]?.[0];
    if (!output) return true;

    this.flushPendingTailIfExpired();

    if (!this.playbackArmed) {
      const requiredForArm = this.hasPlayed
        ? Math.min(this.minBufferSamples, this.rearmMinSamples)
        : this.minBufferSamples;
      if (this.ringBuffer.available >= requiredForArm) {
        this.playbackArmed = true;
        this.pendingLeadSamples = Math.max(0, Math.floor((this.startLeadMs / 1000) * sampleRate));
        if (this.firstPlaybackQueueMs === null) {
          this.firstPlaybackQueueMs = (this.ringBuffer.available / INPUT_SAMPLE_RATE) * 1000;
        }
        if (this.firstPlaybackLeadMs === null) {
          this.firstPlaybackLeadMs = this.startLeadMs;
        }
        this.port.postMessage({ type: "playback_armed" });
      } else {
        output.fill(0);
        return true;
      }
    }

    const step = INPUT_SAMPLE_RATE / sampleRate;
    let fraction = this.consumeFraction;
    const renderTimeMs = currentTime * 1000;

    for (let i = 0; i < output.length; i += 1) {
      if (this.pendingLeadSamples > 0) {
        output[i] = 0;
        this.pendingLeadSamples -= 1;
        continue;
      }

      if (this.ringBuffer.available === 0) {
        output[i] = 0;
        this.playbackArmed = false;
        fraction = 0;
        if (!this.underrunActive) {
          this.underrunActive = true;
          this.port.postMessage({
            type: "underrun",
            detail: {
              epoch: this.currentEpoch,
              renderTimeMs,
            },
          });
        }
        continue;
      }

      if (this.underrunActive) {
        this.underrunActive = false;
      }

      const currentSample = this.ringBuffer.peek(0);
      const nextSample = this.ringBuffer.available > 1 ? this.ringBuffer.peek(1) : currentSample;
      let value = currentSample + (nextSample - currentSample) * fraction;

      if (!this.hasPlayed && this.fadeInSamplesRemaining > 0) {
        const progress = (this.fadeInSamplesTotal - this.fadeInSamplesRemaining + 1) / this.fadeInSamplesTotal;
        value *= Math.min(progress, 1);
        this.fadeInSamplesRemaining -= 1;
      }

      output[i] = value;

      fraction += step;
      while (fraction >= 1 && this.ringBuffer.available > 0) {
        fraction -= 1;
        this.ringBuffer.consume(1);
      }

      if (!this.hasPlayed) {
        this.hasPlayed = true;
        this.firstPlaybackAt = renderTimeMs;
        if (this.firstPlaybackQueueMs === null) {
          this.firstPlaybackQueueMs = (this.ringBuffer.available / INPUT_SAMPLE_RATE) * 1000;
        }
        if (this.firstPlaybackLeadMs === null) {
          this.firstPlaybackLeadMs = this.startLeadMs;
        }
      }
    }

    this.consumeFraction = fraction;
    if (this.ringBuffer.available === 0) {
      this.playbackArmed = false;
      this.consumeFraction = 0;
    } else if (this.underrunActive) {
      this.underrunActive = false;
    }
    return true;
  }

  applyConfig(message) {
    const clamp = (value, min, max, fallback) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
      return Math.min(Math.max(value, min), max);
    };
    if (message.playerTrimGraceMs !== undefined) {
      this.trimGraceMs = clamp(message.playerTrimGraceMs, 0, 1000, this.trimGraceMs);
    }
    if (message.playerInitialQueueMs !== undefined) {
      this.initialQueueMs = clamp(message.playerInitialQueueMs, 0, 1500, this.initialQueueMs);
      this.minBufferSamples = Math.max(1, Math.floor((this.initialQueueMs / 1000) * INPUT_SAMPLE_RATE));
    }
    if (message.playerStartLeadMs !== undefined) {
      this.startLeadMs = clamp(message.playerStartLeadMs, 0, 600, this.startLeadMs);
    }
    if (message.playerSentencePauseMs !== undefined) {
      this.sentencePauseMs = clamp(message.playerSentencePauseMs, 0, 200, this.sentencePauseMs);
      this.sentencePauseSamples = Math.max(
        0,
        Math.floor((this.sentencePauseMs / 1000) * INPUT_SAMPLE_RATE)
      );
    }
    if (message.playerArmSupersedeQuietMs !== undefined) {
      this.armSupersedeQuietMs = clamp(
        message.playerArmSupersedeQuietMs,
        0,
        1200,
        this.armSupersedeQuietMs
      );
    }
  }
}

registerProcessor("pcm24-player", Pcm24PlayerProcessor);
