import React, { useEffect, useRef } from 'react';
import { ConversationMessage, ConversationState } from '../state/conversation-store';

interface DualCaptionsProps {
  conversationState: ConversationState;
  className?: string;
}

interface AudioStatusProps {
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  lastActivity: Date;
}

/**
 * 音声状態表示コンポーネント（字幕とは分離）
 */
const AudioStatus: React.FC<AudioStatusProps> = ({ 
  isUserSpeaking, 
  isAssistantSpeaking, 
  lastActivity 
}) => {
  const now = new Date();
  const timeSinceActivity = now.getTime() - lastActivity.getTime();
  const isStale = timeSinceActivity > 10000; // 10秒以上経過

  if (!isUserSpeaking && !isAssistantSpeaking && !isStale) {
    return null;
  }

  return (
    <div style={{
      position: 'absolute',
      top: 8,
      right: 8,
      fontSize: '0.75rem',
      color: '#666',
      background: 'rgba(255, 255, 255, 0.9)',
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #ddd',
      zIndex: 10,
    }}>
      {isUserSpeaking && <span style={{ color: '#0066cc' }}>🎤 あなたが話しています</span>}
      {isAssistantSpeaking && <span style={{ color: '#cc6600' }}>🔊 相手が話しています</span>}
      {isStale && !isUserSpeaking && !isAssistantSpeaking && (
        <span style={{ color: '#999' }}>⏸️ 音声待機中</span>
      )}
    </div>
  );
};

/**
 * 会話メッセージ表示コンポーネント
 */
const ConversationMessageDisplay: React.FC<{ message: ConversationMessage }> = ({ message }) => {
  const timeStr = message.timestamp.toLocaleTimeString('ja-JP', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });

  return (
    <div style={{
      marginBottom: '8px',
      padding: '8px 12px',
      borderRadius: '8px',
      fontSize: '0.9rem',
      lineHeight: 1.4,
      position: 'relative',
    }}>
      <div style={{
        fontSize: '0.7rem',
        color: '#888',
        marginBottom: '4px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>
          {message.speaker === 'user' ? '👤 あなた' : '🤖 相手'}
          {message.turnId && ` (Turn ${message.turnId})`}
        </span>
        <span>{timeStr}</span>
      </div>
      <div style={{ 
        color: message.speaker === 'user' ? '#0066cc' : '#cc6600',
        fontWeight: message.isFinal ? 500 : 400,
      }}>
        {message.text}
      </div>
    </div>
  );
};

/**
 * 現在の発言表示コンポーネント（リアルタイム）
 */
const CurrentSpeechDisplay: React.FC<{
  text: string;
  speaker: 'user' | 'assistant';
  isActive: boolean;
}> = ({ text, speaker, isActive }) => {
  if (!isActive || !text) return null;

  const speakerInfo = speaker === 'user' ? '👤 あなた' : '🤖 相手';
  const color = speaker === 'user' ? '#0066cc' : '#cc6600';

  return (
    <div style={{
      padding: '8px 12px',
      borderRadius: '8px',
      fontSize: '0.9rem',
      lineHeight: 1.4,
      background: isActive ? 'rgba(0, 102, 204, 0.1)' : 'transparent',
      border: isActive ? `2px solid ${color}` : '2px solid transparent',
      color: color,
      fontWeight: 500,
      position: 'relative',
    }}>
      <div style={{
        fontSize: '0.7rem',
        color: '#888',
        marginBottom: '4px',
      }}>
        {speakerInfo} {isActive && '（話し中）'}
      </div>
      <div style={{ 
        color: color,
        opacity: isActive ? 1 : 0.7,
      }}>
        {text}
        {isActive && <span style={{ 
          animation: 'blink 1s infinite',
          marginLeft: '2px',
        }}>|</span>}
      </div>
    </div>
  );
};

/**
 * 2本立て字幕メインコンポーネント
 */
export const DualCaptions: React.FC<DualCaptionsProps> = ({ 
  conversationState, 
  className 
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新しいメッセージが追加されたら自動スクロール
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversationState.messages.length, conversationState.currentUserText, conversationState.currentAssistantText]);

  return (
    <div className={className} style={{
      position: 'relative',
      border: '1px solid #ddd',
      borderRadius: '8px',
      background: '#fafafa',
      height: '400px',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <AudioStatus 
        isUserSpeaking={conversationState.isUserSpeaking}
        isAssistantSpeaking={conversationState.isAssistantSpeaking}
        lastActivity={conversationState.lastActivity}
      />
      
      <div style={{
        padding: '12px',
        borderBottom: '1px solid #eee',
        background: '#f8f9fa',
        fontSize: '0.8rem',
        color: '#666',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>💬 会話履歴</span>
        <span>{conversationState.messages.length}件のメッセージ</span>
      </div>

      <div 
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* 確定済みメッセージ */}
        {conversationState.messages.map((message) => (
          <ConversationMessageDisplay key={message.id} message={message} />
        ))}

        {/* 現在の発言（リアルタイム） */}
        <CurrentSpeechDisplay
          text={conversationState.currentUserText}
          speaker="user"
          isActive={conversationState.isUserSpeaking}
        />
        
        <CurrentSpeechDisplay
          text={conversationState.currentAssistantText}
          speaker="assistant"
          isActive={conversationState.isAssistantSpeaking}
        />

        {/* 空状態の表示 */}
        {conversationState.messages.length === 0 && 
         !conversationState.currentUserText && 
         !conversationState.currentAssistantText && (
          <div style={{
            textAlign: 'center',
            color: '#999',
            fontSize: '0.9rem',
            padding: '40px 20px',
            lineHeight: 1.5,
          }}>
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>💬</div>
            <div>会話を開始してください</div>
            <div style={{ fontSize: '0.8rem', marginTop: '8px' }}>
              あなたの発言と相手の返答が<br />
              ここに表示されます
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};

export default DualCaptions;
