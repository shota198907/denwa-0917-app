import { useCallback, useEffect, useRef, useState } from "react";

export interface SilencePromptOptions {
  readonly silenceMs?: number;
}

export interface SilencePromptControls {
  readonly shouldPrompt: boolean;
  readonly acknowledge: () => void;
  readonly reset: () => void;
}

const DEFAULT_SILENCE_MS = 5_000;

export const useSilencePrompt = (
  isSpeech: boolean,
  options: SilencePromptOptions = {}
): SilencePromptControls => {
  const { silenceMs = DEFAULT_SILENCE_MS } = options;

  const [shouldPrompt, setShouldPrompt] = useState(false);

  const timerRef = useRef<number | null>(null);
  const armedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const acknowledge = useCallback(() => {
    setShouldPrompt(false);
  }, []);

  const reset = useCallback(() => {
    armedRef.current = true;
    acknowledge();
    clearTimer();
  }, [acknowledge, clearTimer]);

  useEffect(() => {
    if (isSpeech) {
      armedRef.current = true;
      acknowledge();
      clearTimer();
      return () => {};
    }

    if (!armedRef.current || timerRef.current !== null) {
      return () => {};
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      armedRef.current = false;
      setShouldPrompt(true);
    }, silenceMs);

    return clearTimer;
  }, [acknowledge, clearTimer, isSpeech, silenceMs]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { shouldPrompt, acknowledge, reset };
};
