import { useCallback, useEffect, useRef, useState } from "react";

export interface VadAttachOptions {
  readonly stream: MediaStream;
  readonly audioContext: AudioContext;
}

export interface VadOptions {
  readonly speechThreshold?: number;
  readonly silenceThreshold?: number;
  readonly activationDelayMs?: number;
  readonly deactivationDelayMs?: number;
  readonly analyserFftSize?: number;
  readonly energySmoothing?: number;
  readonly onSpeechStart?: () => void;
  readonly onSpeechEnd?: () => void;
}

export interface VadControls {
  readonly isSpeech: boolean;
  readonly energy: number;
  readonly attach: (options: VadAttachOptions) => void;
  readonly detach: () => void;
}

const DEFAULTS = {
  speechThreshold: 0.018,
  silenceThreshold: 0.012,
  activationDelayMs: 120,
  deactivationDelayMs: 450,
  analyserFftSize: 1024,
  energySmoothing: 0.6,
} as const;

export const useVAD = (options: VadOptions = {}): VadControls => {
  const {
    speechThreshold = DEFAULTS.speechThreshold,
    silenceThreshold = DEFAULTS.silenceThreshold,
    activationDelayMs = DEFAULTS.activationDelayMs,
    deactivationDelayMs = DEFAULTS.deactivationDelayMs,
    analyserFftSize = DEFAULTS.analyserFftSize,
    energySmoothing = DEFAULTS.energySmoothing,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const [isSpeech, setIsSpeech] = useState(false);
  const [energy, setEnergy] = useState(0);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const frameBufferRef = useRef<Float32Array | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const smoothedEnergyRef = useRef(0);
  const lastEnergyEmitRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const lastAboveThresholdRef = useRef(0);
  const lastBelowThresholdRef = useRef(performance.now());

  const cleanup = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (_error) {
        // ignore disconnect errors during teardown
      }
      sourceRef.current = null;
    }
    frameBufferRef.current = null;
    smoothedEnergyRef.current = 0;
  }, []);

  const detach = useCallback(() => {
    cleanup();
    setIsSpeech(false);
    setEnergy(0);
    isSpeakingRef.current = false;
    lastAboveThresholdRef.current = 0;
    lastBelowThresholdRef.current = performance.now();
  }, [cleanup]);

  const analyseFrame = useCallback(() => {
    const analyser = analyserRef.current;
    const buffer = frameBufferRef.current;
    if (!analyser || !buffer) return;

    const target = new Float32Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.length);
    analyser.getFloatTimeDomainData(target);

    let sumSquares = 0;
    for (let i = 0; i < target.length; i += 1) {
      const value = target[i];
      sumSquares += value * value;
    }

    const rms = Math.sqrt(sumSquares / target.length);
    const smoothed =
      energySmoothing * smoothedEnergyRef.current + (1 - energySmoothing) * rms;
    smoothedEnergyRef.current = smoothed;

    const now = performance.now();

    if (smoothed >= speechThreshold) {
      lastAboveThresholdRef.current = now;
      if (!isSpeakingRef.current && now - lastBelowThresholdRef.current >= activationDelayMs) {
        isSpeakingRef.current = true;
        setIsSpeech(true);
        if (onSpeechStart) onSpeechStart();
      }
    } else if (smoothed <= silenceThreshold) {
      if (isSpeakingRef.current && now - lastAboveThresholdRef.current >= deactivationDelayMs) {
        isSpeakingRef.current = false;
        setIsSpeech(false);
        if (onSpeechEnd) onSpeechEnd();
      }
      lastBelowThresholdRef.current = now;
    }

    if (now - lastEnergyEmitRef.current >= 100) {
      lastEnergyEmitRef.current = now;
      setEnergy(smoothed);
    }

    rafIdRef.current = requestAnimationFrame(analyseFrame);
  }, [activationDelayMs, deactivationDelayMs, energySmoothing, onSpeechEnd, onSpeechStart, silenceThreshold, speechThreshold]);

  const attach = useCallback(
    ({ stream, audioContext }: VadAttachOptions) => {
      if (!stream) return;
      detach();

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.smoothingTimeConstant = 0; // manual smoothing
      analyser.fftSize = analyserFftSize;

      source.connect(analyser);

      analyserRef.current = analyser;
      sourceRef.current = source;
      frameBufferRef.current = new Float32Array(analyser.fftSize);
      lastEnergyEmitRef.current = performance.now();
      lastBelowThresholdRef.current = performance.now();
      isSpeakingRef.current = false;
      smoothedEnergyRef.current = 0;

      rafIdRef.current = requestAnimationFrame(analyseFrame);
    },
    [analyseFrame, analyserFftSize, detach]
  );

  useEffect(() => detach, [detach]);

  return { isSpeech, energy, attach, detach };
};
