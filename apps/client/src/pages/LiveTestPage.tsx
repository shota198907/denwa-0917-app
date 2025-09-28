import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveAudioSession } from "../lib/ws-audio";
import { useVAD } from "../hooks/useVAD";
import { useSilencePrompt } from "../hooks/useSilencePrompt";
import { useConversation } from "../hooks/useConversation";
import { AUDIO_ONLY_LABEL } from "../lib/caption-helpers";
import {
  SessionLogSummarizer,
  type SummaryLogEntryPayload,
  type SummaryLogImportance,
} from "../lib/log-summary";
import DualCaptions from "../components/DualCaptions";

const LOCAL_FLAG_KEY = "__denwaFeatureFlags";

interface FeatureFlagDraft {
  ttsPrefixDedupeEnabled: boolean;
  ttsExclusivePlaybackEnabled: boolean;
  playerFlushBargeInOnly: boolean;
  playerFlushOnStartMicLegacy: boolean;
  playerSupersedePrefixEnabled: boolean;
  ttsTextDebounceMs: number;
  playerInitialQueueMs: number;
  playerStartLeadMs: number;
  playerTrimGraceMs: number;
  playerSentencePauseMs: number;
  playerArmSupersedeQuietMs: number;
  playerCommitGuardMs: number;
}

const FLAG_DEFAULTS: FeatureFlagDraft = {
  ttsPrefixDedupeEnabled: false,
  ttsExclusivePlaybackEnabled: false,
  playerFlushBargeInOnly: true,
  playerFlushOnStartMicLegacy: false,
  playerSupersedePrefixEnabled: false,
  ttsTextDebounceMs: 600,
  playerInitialQueueMs: 1100,
  playerStartLeadMs: 0,
  playerTrimGraceMs: 450,
  playerSentencePauseMs: 40,
  playerArmSupersedeQuietMs: 600,
  playerCommitGuardMs: 300,
};

const UI_MIN_INITIAL_QUEUE_MS = 50;
const UI_MAX_INITIAL_QUEUE_MS = 1500;
const UI_MIN_START_LEAD_MS = 0;
const UI_MAX_START_LEAD_MS = 600;
const UI_MIN_TRIM_GRACE_MS = 0;
const UI_MAX_TRIM_GRACE_MS = 1000;
const UI_MIN_SENTENCE_PAUSE_MS = 0;
const UI_MAX_SENTENCE_PAUSE_MS = 200;
const UI_MIN_ARM_SUPERSEDE_QUIET_MS = 0;
const UI_MAX_ARM_SUPERSEDE_QUIET_MS = 1200;
const UI_MIN_COMMIT_GUARD_MS = 0;
const UI_MAX_COMMIT_GUARD_MS = 1000;

interface LogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly message: string;
}

interface SummaryLogEntry extends SummaryLogEntryPayload {
  readonly id: string;
  readonly timestamp: string;
}

const MAX_LOG_ENTRIES = 50;
const MAX_SUMMARY_LOG_ENTRIES = 60;
const SILENCE_PROMPT_TEXT = "少々お待ちしています。何かお手伝いできることはありますか？";
const TERMINAL_PUNCTUATION = /[。．.？！?!…]$/;
const CAPTION_PENDING_LABEL = "（応答生成中…）";

const fmtTime = (date: Date): string => date.toISOString();

const makeWsUrl = (backendUrl: string | undefined): string | null => {
  if (!backendUrl) return null;
  const trimmed = backendUrl.replace(/\/$/, "");
  if (!/^https?:/i.test(trimmed)) return null;
  return `${trimmed.replace(/^http/i, "ws")}/ws-proxy`;
};

export const LiveTestPage: React.FC = () => {
  const backendUrl = import.meta.env.VITE_BACKEND_URL as string | undefined;
  const wsUrl = useMemo(() => makeWsUrl(backendUrl), [backendUrl]);
  const sessionRef = useRef<LiveAudioSession | null>(null);
  const summaryRef = useRef<SessionLogSummarizer | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [summaryLogs, setSummaryLogs] = useState<SummaryLogEntry[]>([]);
  const [logView, setLogView] = useState<"summary" | "raw">("summary");
  const [pendingText, setPendingText] = useState<string>("");
  const [flagDraft, setFlagDraft] = useState<FeatureFlagDraft>(FLAG_DEFAULTS);
  const [flagsLoaded, setFlagsLoaded] = useState(false);

  // 新しい会話状態管理
  const {
    conversationState,
    startUserSpeaking,
    updateUserText,
    endUserSpeaking,
    startAssistantSpeaking,
    updateAssistantText,
    endAssistantSpeaking,
    commitAssistantTurn,
    clearHistory,
    setTranscriptionDisabled,
    setUserTranscriptionEnabled,
    handleInterruption,
    updateAudioStatus,
  } = useConversation();

  const summaryColorMap: Record<SummaryLogImportance, string> = useMemo(
    () => ({ info: "#0c5a4d", warn: "#7a4a00", error: "#7a0022" }),
    []
  );
  const summaryBackgroundMap: Record<SummaryLogImportance, string> = useMemo(
    () => ({ info: "#f1faf8", warn: "#fff6e5", error: "#ffe8ed" }),
    []
  );

  /**
   * UIログとサマリーログへ書き込む。生ログは保持しつつ、サマリーはノイズを除去して整形する。
   */
  const pushLog = useCallback((message: string) => {
    const timestamp = fmtTime(new Date());
    const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setLogs((prev) => {
      const entry: LogEntry = {
        id: logId,
        timestamp,
        message,
      };
      return [entry, ...prev].slice(0, MAX_LOG_ENTRIES);
    });

    const summarizer = summaryRef.current ?? new SessionLogSummarizer();
    summaryRef.current = summarizer;
    const summary = summarizer.summarize(message);
    if (summary) {
      setSummaryLogs((prev) => {
        const entry: SummaryLogEntry = {
          id: `${logId}-summary`,
          timestamp,
          ...summary,
        };
        return [entry, ...prev].slice(0, MAX_SUMMARY_LOG_ENTRIES);
      });
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const draft: FeatureFlagDraft = { ...FLAG_DEFAULTS };
    const mutableDraft = draft as unknown as Record<string, boolean | number>;
    const apply = (source: Record<string, unknown>) => {
      for (const key of Object.keys(draft) as (keyof FeatureFlagDraft)[]) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        if (typeof value === "boolean") {
          mutableDraft[key] = value;
        } else if (typeof value === "number" && Number.isFinite(value)) {
          mutableDraft[key] = value;
        } else if (typeof value === "string" && value.trim().length > 0) {
          if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
            mutableDraft[key] = value.toLowerCase() === "true";
          } else {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) {
              mutableDraft[key] = numeric;
            }
          }
        }
      }
    };

    try {
      const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_FLAG_KEY) : null;
      if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      apply(parsed);
      }
    } catch (error) {
      console.warn("[flags] failed to parse localStorage", error);
    }

    if (window.__denwaFeatureFlags) {
      apply(window.__denwaFeatureFlags as Record<string, unknown>);
    }

    setFlagDraft(draft);
    setFlagsLoaded(true);
  }, []);

  const handleBooleanFlagChange = useCallback(
    (key: keyof FeatureFlagDraft) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const checked = event.target.checked;
      setFlagDraft((prev) => ({ ...prev, [key]: checked }));
    },
    []
  );

  const handleNumericFlagChange = useCallback(
    (key: keyof FeatureFlagDraft) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      setFlagDraft((prev) => ({ ...prev, [key]: Number.isFinite(value) ? value : prev[key] }));
    },
    []
  );

  const applyFlagDraft = useCallback(() => {
    if (typeof window === "undefined") return;
    const payload: FeatureFlagDraft = { ...flagDraft };
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(LOCAL_FLAG_KEY, JSON.stringify(payload));
      }
    } catch (error) {
      console.warn("[flags] failed to persist", error);
    }
    (window as typeof window & { __denwaFeatureFlags?: Partial<FeatureFlagDraft> }).__denwaFeatureFlags = {
      ...payload,
    };
    window.location.reload();
  }, [flagDraft]);

  const resetFlags = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(LOCAL_FLAG_KEY);
      }
    } catch (error) {
      console.warn("[flags] failed to reset", error);
    }
    delete (window as typeof window & { __denwaFeatureFlags?: Partial<FeatureFlagDraft> }).__denwaFeatureFlags;
    window.location.reload();
  }, []);

  const ensureSession = useCallback(() => {
    if (!wsUrl) {
      pushLog("[error] VITE_BACKEND_URL is not configured");
      return null;
    }
    if (!sessionRef.current) {
      sessionRef.current = new LiveAudioSession(wsUrl, {
        onOpen: () => {
          setIsConnecting(false);
          setIsConnected(true);
        },
        onClose: () => {
          setIsConnecting(false);
          setIsConnected(false);
          setIsMicActive(false);
        },
        onError: (details) => pushLog(`[error] ${details}`),
        onLog: (message) => pushLog(message),
        onTranscript: (snapshot) => {
          // アシスタントの発言として処理
          const sentences = snapshot.turns.flatMap((turn) => turn.sentences.map((sentence) => sentence.text));
          if (sentences.length > 0) {
            const latest = sentences[sentences.length - 1];
            
            // 新しいターンが開始された場合
            const latestTurn = snapshot.turns[snapshot.turns.length - 1];
            if (latestTurn && latestTurn.turnId) {
              startAssistantSpeaking(latestTurn.turnId);
              updateAssistantText(latest);
              
              // ターンが確定した場合（鐘が来た場合）は発言を確定
              if (latestTurn.finalized) {
                commitAssistantTurn();
              }
            }
          }
        },
        onCaption: (text) => {
          const trimmed = text.trim();
          
          // 無効なテキストは無視
          if (trimmed === "?" || !trimmed) {
            return;
          }
          
          // 音声のみの場合は特別処理
          if (trimmed === AUDIO_ONLY_LABEL) {
            startAssistantSpeaking();
            updateAssistantText("（音声のみ）");
            commitAssistantTurn();
            return;
          }
          
          // 応答生成中の場合は一時的な表示
          if (trimmed === CAPTION_PENDING_LABEL) {
            startAssistantSpeaking();
            updateAssistantText("（応答生成中…）");
            return;
          }
          
          // アシスタントの発言として蓄積（鐘で確定されるまで）
          startAssistantSpeaking();
          updateAssistantText(trimmed);
        },
        onModelText: (text, isComplete, turnId) => {
          // モデルの発話テキストを処理
          if (isComplete) {
            // 鐘が来た場合：発言を確定
            startAssistantSpeaking(turnId);
            updateAssistantText(text);
            commitAssistantTurn();
          } else {
            // 途中のテキスト：蓄積
            startAssistantSpeaking(turnId);
            updateAssistantText(text);
          }
        },
      });
    }
    return sessionRef.current;
  }, [pushLog, wsUrl, startAssistantSpeaking, updateAssistantText, commitAssistantTurn, handleInterruption]);

  const { isSpeech, energy, attach, detach } = useVAD({
    onSpeechStart: () => {
      pushLog("[vad] speech detected (client)");
      sessionRef.current?.interruptPlayback("barge-in");
      
      // 割り込み処理：アシスタントの発言をいったん確定
      handleInterruption();
      
      // ユーザーの発言開始
      startUserSpeaking();
      updateAudioStatus(true, false);
    },
    onSpeechEnd: () => {
      pushLog("[vad] speech ended");
      
      // ユーザーの発言終了
      endUserSpeaking(true);
      updateAudioStatus(false, false);
    },
  });

  const { shouldPrompt, acknowledge, reset: resetSilencePrompt } = useSilencePrompt(isSpeech);

  useEffect(() => {
    if (!shouldPrompt) return;
    pushLog("[prompt] 5s silence detected; sending prompt text");
    const session = sessionRef.current;
    if (session && session.isConnected()) {
      session.sendText(SILENCE_PROMPT_TEXT);
    }
    acknowledge();
  }, [acknowledge, pushLog, shouldPrompt]);

  const connect = useCallback(async () => {
    const session = ensureSession();
    if (!session) return;
    if (session.isConnected()) {
      pushLog("[info] already connected");
      return;
    }
    setIsConnecting(true);
    try {
      await session.connect();
      setIsConnected(true);
    } catch (error) {
      setIsConnecting(false);
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`[error] connect failed: ${message}`);
    }
  }, [ensureSession, pushLog]);

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    detach();
    resetSilencePrompt();
    setIsConnected(false);
    setIsConnecting(false);
    setIsMicActive(false);
    
    // 会話状態をリセット
    endUserSpeaking(true);
    endAssistantSpeaking(true);
    updateAudioStatus(false, false);
  }, [detach, resetSilencePrompt, endUserSpeaking, endAssistantSpeaking, updateAudioStatus]);

  const sendText = useCallback(() => {
    const text = pendingText.trim();
    if (!text) return;
    const session = ensureSession();
    if (!session || !session.isConnected()) {
      pushLog("[warn] cannot send text: not connected");
      return;
    }
    
    // テキスト送信をユーザーの発言として記録
    startUserSpeaking();
    updateUserText(text);
    endUserSpeaking(true);
    updateAudioStatus(false, true); // アシスタントが応答開始
    
    session.sendText(text);
    setPendingText("");
  }, [ensureSession, pendingText, pushLog, startUserSpeaking, updateUserText, endUserSpeaking, updateAudioStatus]);

  const startMic = useCallback(async () => {
    const session = ensureSession();
    if (!session) return;
    try {
      const stream = await session.startMic();
      const context = await session.getAudioContext();
      attach({ stream, audioContext: context });
      resetSilencePrompt();
      setIsMicActive(true);
      
      // 文字起こし機能が無効な場合の表示
      setTranscriptionDisabled();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`[error] mic start failed: ${message}`);
    }
  }, [attach, ensureSession, pushLog, resetSilencePrompt, setTranscriptionDisabled, setUserTranscriptionEnabled]);

  const stopMic = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.stopMic();
    detach();
    resetSilencePrompt();
    setIsMicActive(false);
  }, [detach, resetSilencePrompt]);

  useEffect(() => {
    return () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      detach();
      resetSilencePrompt();
      
      // 会話状態をリセット
      endUserSpeaking(true);
      endAssistantSpeaking(true);
      updateAudioStatus(false, false);
    };
  }, [detach, resetSilencePrompt, endUserSpeaking, endAssistantSpeaking, updateAudioStatus, handleInterruption]);

  useEffect(() => {
    if (!wsUrl) {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      detach();
      resetSilencePrompt();
      setIsConnected(false);
      setIsConnecting(false);
      
      // 会話状態をリセット
      endUserSpeaking(true);
      endAssistantSpeaking(true);
      updateAudioStatus(false, false);
    }
  }, [detach, resetSilencePrompt, wsUrl, endUserSpeaking, endAssistantSpeaking, updateAudioStatus, handleInterruption]);

  const summaryMode = logView === "summary";

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.8rem", marginBottom: 16 }}>Live Test Console</h1>
      <section style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8 }}>
          <strong>Status:</strong> {isConnected ? "Connected" : isConnecting ? "Connecting…" : "Disconnected"}
        </div>
        <div style={{ marginBottom: 8 }}>
          <strong>VAD:</strong> {isSpeech ? "Speaking" : "Silent"} (energy {energy.toFixed(3)})
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={connect} disabled={isConnecting || isConnected}>
            Connect
          </button>
          <button onClick={disconnect} disabled={!isConnected && !isConnecting}>
            Disconnect
          </button>
          <button onClick={startMic} disabled={!isConnected || isMicActive}>
            Mic Start
          </button>
          <button onClick={stopMic} disabled={!isConnected || !isMicActive}>
            Mic Stop
          </button>
        </div>
      </section>

      <section
        style={{
          marginBottom: 16,
          border: "1px solid #ddd",
          borderRadius: 4,
          padding: 12,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Playback Flags (A/B)</h2>
          <small style={{ color: "#666" }}>{flagsLoaded ? "Ready" : "Loading…"}</small>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={flagDraft.ttsPrefixDedupeEnabled}
              onChange={handleBooleanFlagChange("ttsPrefixDedupeEnabled")}
              disabled={!flagsLoaded}
            />
            Prefix dedupe
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={flagDraft.ttsExclusivePlaybackEnabled}
              onChange={handleBooleanFlagChange("ttsExclusivePlaybackEnabled")}
              disabled={!flagsLoaded}
            />
            Exclusive playback
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={flagDraft.playerFlushBargeInOnly}
              onChange={handleBooleanFlagChange("playerFlushBargeInOnly")}
              disabled={!flagsLoaded}
            />
            Flush on barge-in only
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={flagDraft.playerFlushOnStartMicLegacy}
              onChange={handleBooleanFlagChange("playerFlushOnStartMicLegacy")}
              disabled={!flagsLoaded}
            />
            Legacy start-mic flush
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={flagDraft.playerSupersedePrefixEnabled}
              onChange={handleBooleanFlagChange("playerSupersedePrefixEnabled")}
              disabled={!flagsLoaded}
            />
            Enable prefix supersede
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Debounce (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              value={flagDraft.ttsTextDebounceMs}
              onChange={handleNumericFlagChange("ttsTextDebounceMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Initial queue (ms)</span>
            <input
              type="number"
              min={UI_MIN_INITIAL_QUEUE_MS}
              max={UI_MAX_INITIAL_QUEUE_MS}
              step={20}
              value={flagDraft.playerInitialQueueMs}
              onChange={handleNumericFlagChange("playerInitialQueueMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Start lead (ms)</span>
            <input
              type="number"
              min={UI_MIN_START_LEAD_MS}
              max={UI_MAX_START_LEAD_MS}
              step={20}
              value={flagDraft.playerStartLeadMs}
              onChange={handleNumericFlagChange("playerStartLeadMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Trim grace (ms)</span>
            <input
              type="number"
              min={UI_MIN_TRIM_GRACE_MS}
              max={UI_MAX_TRIM_GRACE_MS}
              step={50}
              value={flagDraft.playerTrimGraceMs}
              onChange={handleNumericFlagChange("playerTrimGraceMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Sentence pause (ms)</span>
            <input
              type="number"
              min={UI_MIN_SENTENCE_PAUSE_MS}
              max={UI_MAX_SENTENCE_PAUSE_MS}
              step={10}
              value={flagDraft.playerSentencePauseMs}
              onChange={handleNumericFlagChange("playerSentencePauseMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Arm quiet (ms)</span>
            <input
              type="number"
              min={UI_MIN_ARM_SUPERSEDE_QUIET_MS}
              max={UI_MAX_ARM_SUPERSEDE_QUIET_MS}
              step={10}
              value={flagDraft.playerArmSupersedeQuietMs}
              onChange={handleNumericFlagChange("playerArmSupersedeQuietMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>Commit guard (ms)</span>
            <input
              type="number"
              min={UI_MIN_COMMIT_GUARD_MS}
              max={UI_MAX_COMMIT_GUARD_MS}
              step={10}
              value={flagDraft.playerCommitGuardMs}
              onChange={handleNumericFlagChange("playerCommitGuardMs")}
              disabled={!flagsLoaded}
              style={{ padding: "6px 8px" }}
            />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={applyFlagDraft} disabled={!flagsLoaded}>
            Apply & Reload
          </button>
          <button onClick={resetFlags} disabled={!flagsLoaded}>
            Reset Flags
          </button>
        </div>
        <small style={{ color: "#666" }}>
          フラグは `localStorage.{LOCAL_FLAG_KEY}` に保存されます。Applyでページを再読み込みし、新しい設定を反映します。
        </small>
      </section>

      <section style={{ marginBottom: 16 }}>
        <label htmlFor="live-test-text" style={{ display: "block", marginBottom: 4 }}>
          Send text prompt
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="live-test-text"
            value={pendingText}
            onChange={(event) => setPendingText(event.target.value)}
            placeholder="テストです。応答できますか？"
            style={{ flex: 1, padding: "6px 8px" }}
          />
          <button onClick={sendText} disabled={!isConnected}>
            Send
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ fontSize: "1.2rem", margin: 0 }}>💬 会話字幕</h2>
          <button 
            onClick={clearHistory}
            style={{
              fontSize: '0.8rem',
              padding: '4px 8px',
              background: '#f0f0f0',
              border: '1px solid #ccc',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            履歴クリア
          </button>
        </div>
        <DualCaptions conversationState={conversationState} />
      </section>

      <section>
        <h2 style={{ fontSize: "1.2rem", marginBottom: 4 }}>Logs</h2>
        <div
          style={{
            border: "1px solid #ccc",
            borderRadius: 4,
            padding: 12,
            background: summaryMode ? "#f8f9fa" : "#111",
            color: summaryMode ? "#1f2a2a" : "#0f0",
            fontFamily: summaryMode ? "sans-serif" : "monospace",
            fontSize: summaryMode ? "0.9rem" : "0.85rem",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: summaryMode ? "#4a5a58" : "#aaa" }}>
              {summaryMode ? `サマリー ${summaryLogs.length}件` : `詳細ログ ${logs.length}件`}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setLogView("summary")} disabled={summaryMode}>
                Summary
              </button>
              <button onClick={() => setLogView("raw")} disabled={!summaryMode}>
                Raw
              </button>
            </div>
          </div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {summaryMode ? (
              summaryLogs.length === 0 ? (
                <div style={{ color: "#6b7c7a" }}>サマリーログなし</div>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                  {summaryLogs.map((log) => (
                    <li
                      key={log.id}
                      style={{
                        borderLeft: `4px solid ${summaryColorMap[log.importance]}`,
                        borderRadius: "4px",
                        background: summaryBackgroundMap[log.importance],
                        padding: "6px 8px",
                        color: "#1f2a2a",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: "0.78rem",
                          color: "#4a5a58",
                          marginBottom: 4,
                        }}
                      >
                        <span>[{log.timestamp}]</span>
                        <strong style={{ fontSize: "0.8rem", color: summaryColorMap[log.importance] }}>
                          {log.category}
                        </strong>
                      </div>
                      <div style={{ fontSize: "0.92rem", lineHeight: 1.4 }}>{log.message}</div>
                    </li>
                  ))}
                </ul>
              )
            ) : logs.length === 0 ? (
              <div style={{ color: "#666" }}>ログなし</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {logs.map((log) => (
                  <li key={log.id} style={{ marginBottom: 4 }}>
                    <span style={{ color: "#777" }}>[{log.timestamp}]</span> {log.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default LiveTestPage;
