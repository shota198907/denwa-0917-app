import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationStore, ConversationState } from '../state/conversation-store';

/**
 * 会話状態管理フック
 */
export const useConversation = () => {
  const [conversationState, setConversationState] = useState<ConversationState>(() => ({
    messages: [],
    currentUserText: '',
    currentAssistantText: '',
    isUserSpeaking: false,
    isAssistantSpeaking: false,
    lastActivity: new Date(),
  }));

  const storeRef = useRef<ConversationStore>(new ConversationStore());
  const timeoutRef = useRef<NodeJS.Timeout>();

  /**
   * 会話状態を更新
   */
  const updateState = useCallback(() => {
    setConversationState(storeRef.current.getState());
  }, []);

  /**
   * ユーザーの発言開始
   */
  const startUserSpeaking = useCallback((turnId?: number) => {
    storeRef.current.startUserSpeaking(turnId);
    updateState();
  }, [updateState]);

  /**
   * ユーザーの発言更新（リアルタイム文字起こし）
   */
  const updateUserText = useCallback((text: string) => {
    storeRef.current.updateUserText(text);
    updateState();
  }, [updateState]);

  /**
   * ユーザーの発言終了
   */
  const endUserSpeaking = useCallback((forceCommit = false) => {
    storeRef.current.endUserSpeaking(forceCommit);
    updateState();
  }, [updateState]);

  /**
   * アシスタントの発言開始
   */
  const startAssistantSpeaking = useCallback((turnId?: number) => {
    storeRef.current.startAssistantSpeaking(turnId);
    updateState();
  }, [updateState]);

  /**
   * アシスタントの発言更新
   */
  const updateAssistantText = useCallback((text: string) => {
    storeRef.current.updateAssistantText(text);
    updateState();
  }, [updateState]);

  /**
   * アシスタントの発言終了
   */
  const endAssistantSpeaking = useCallback((forceCommit = false) => {
    storeRef.current.endAssistantSpeaking(forceCommit);
    updateState();
  }, [updateState]);

  /**
   * 鐘（ターン終了）によるアシスタント発言の確定
   */
  const commitAssistantTurn = useCallback(() => {
    storeRef.current.commitAssistantTurn();
    updateState();
  }, [updateState]);

  /**
   * 会話履歴をクリア
   */
  const clearHistory = useCallback(() => {
    storeRef.current.clearHistory();
    updateState();
  }, [updateState]);

  /**
   * 文字起こし機能が無効な場合の表示
   */
  const setTranscriptionDisabled = useCallback(() => {
    storeRef.current.setTranscriptionDisabled();
    updateState();
  }, [updateState]);

  /**
   * 音声状態の更新
   */
  const updateAudioStatus = useCallback((userSpeaking: boolean, assistantSpeaking: boolean) => {
    storeRef.current.updateAudioStatus(userSpeaking, assistantSpeaking);
    updateState();
  }, [updateState]);

  /**
   * タイムアウトによる自動確定処理
   */
  useEffect(() => {
    const checkTimeout = () => {
      const state = storeRef.current.getState();
      const now = new Date();
      const timeSinceActivity = now.getTime() - state.lastActivity.getTime();

      // 3秒以上経過した場合は発言を終了
      if (timeSinceActivity > 3000) {
        if (state.isUserSpeaking) {
          storeRef.current.endUserSpeaking(true);
          updateState();
        }
        if (state.isAssistantSpeaking) {
          storeRef.current.endAssistantSpeaking(true);
          updateState();
        }
      }
    };

    timeoutRef.current = setInterval(checkTimeout, 1000);

    return () => {
      if (timeoutRef.current) {
        clearInterval(timeoutRef.current);
      }
    };
  }, [updateState]);

  return {
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
    updateAudioStatus,
  };
};
