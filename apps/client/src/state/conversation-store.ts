/**
 * 会話状態管理ストア
 * あなたと相手の発言を区別し、確定タイミングを管理する
 */

export interface ConversationMessage {
  readonly id: string;
  readonly speaker: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp: Date;
  readonly isFinal: boolean;
  readonly turnId?: number;
}

export interface ConversationState {
  readonly messages: readonly ConversationMessage[];
  readonly currentUserText: string;
  readonly currentAssistantText: string;
  readonly isUserSpeaking: boolean;
  readonly isAssistantSpeaking: boolean;
  readonly lastActivity: Date;
}

export class ConversationStore {
  private messages: ConversationMessage[] = [];
  private currentUserText = '';
  private currentAssistantText = '';
  private isUserSpeaking = false;
  private isAssistantSpeaking = false;
  private lastActivity = new Date();
  private currentUserTurnId?: number;
  private currentAssistantTurnId?: number;

  /**
   * 現在の会話状態を取得
   */
  public getState(): ConversationState {
    return {
      messages: [...this.messages],
      currentUserText: this.currentUserText,
      currentAssistantText: this.currentAssistantText,
      isUserSpeaking: this.isUserSpeaking,
      isAssistantSpeaking: this.isAssistantSpeaking,
      lastActivity: this.lastActivity,
    };
  }

  /**
   * ユーザーの発言開始
   */
  public startUserSpeaking(turnId?: number): void {
    this.isUserSpeaking = true;
    this.currentUserText = '';
    this.currentUserTurnId = turnId;
    this.lastActivity = new Date();
  }

  /**
   * ユーザーの発言更新（リアルタイム文字起こし）
   */
  public updateUserText(text: string): void {
    if (!this.isUserSpeaking) {
      this.startUserSpeaking();
    }
    
    const trimmed = text.trim();
    
    // 切れ端対策：1-2文字だけは確定しない
    if (trimmed.length <= 2 && !this.isShortValidWord(trimmed)) {
      this.currentUserText = trimmed;
      return;
    }

    this.currentUserText = trimmed;
    this.lastActivity = new Date();
  }

  /**
   * ユーザーの発言終了
   */
  public endUserSpeaking(forceCommit = false): void {
    if (!this.isUserSpeaking) return;

    const shouldCommit = forceCommit || this.shouldCommitUserText();
    
    if (shouldCommit && this.currentUserText.length > 0) {
      this.commitUserMessage();
    }

    this.isUserSpeaking = false;
    this.currentUserText = '';
    this.currentUserTurnId = undefined;
    this.lastActivity = new Date();
  }

  /**
   * アシスタントの発言開始
   */
  public startAssistantSpeaking(turnId?: number): void {
    this.isAssistantSpeaking = true;
    this.currentAssistantText = '';
    this.currentAssistantTurnId = turnId;
    this.lastActivity = new Date();
  }

  /**
   * アシスタントの発言更新
   */
  public updateAssistantText(text: string): void {
    if (!this.isAssistantSpeaking) {
      this.startAssistantSpeaking();
    }

    const trimmed = text.trim();
    
    // アシスタントの場合は切れ端でも確定（音声が鳴っているため）
    if (trimmed.length > 0) {
      this.currentAssistantText = trimmed;
      this.lastActivity = new Date();
    }
  }

  /**
   * アシスタントの発言確定
   */
  public commitAssistantMessage(): void {
    if (!this.isAssistantSpeaking || this.currentAssistantText.length === 0) return;

    const message: ConversationMessage = {
      id: this.generateMessageId(),
      speaker: 'assistant',
      text: this.currentAssistantText,
      timestamp: new Date(),
      isFinal: true,
      turnId: this.currentAssistantTurnId,
    };

    this.messages.push(message);
    this.isAssistantSpeaking = false;
    this.currentAssistantText = '';
    this.currentAssistantTurnId = undefined;
    this.lastActivity = new Date();
  }

  /**
   * アシスタントの発言終了
   */
  public endAssistantSpeaking(forceCommit = false): void {
    if (!this.isAssistantSpeaking) return;

    if (forceCommit || this.currentAssistantText.length > 0) {
      this.commitAssistantMessage();
    }

    this.isAssistantSpeaking = false;
    this.currentAssistantText = '';
    this.currentAssistantTurnId = undefined;
    this.lastActivity = new Date();
  }

  /**
   * 会話履歴をクリア
   */
  public clearHistory(): void {
    this.messages = [];
    this.currentUserText = '';
    this.currentAssistantText = '';
    this.isUserSpeaking = false;
    this.isAssistantSpeaking = false;
    this.currentUserTurnId = undefined;
    this.currentAssistantTurnId = undefined;
    this.lastActivity = new Date();
  }

  /**
   * ユーザーテキストの確定判定
   */
  private shouldCommitUserText(): boolean {
    if (this.currentUserText.length === 0) return false;

    // 短い有効な単語は確定
    if (this.isShortValidWord(this.currentUserText)) {
      return true;
    }

    // 3文字以上で句読点で終わる場合は確定
    if (this.currentUserText.length >= 3 && this.endsWithTerminalPunctuation(this.currentUserText)) {
      return true;
    }

    // 5文字以上の場合は確定
    if (this.currentUserText.length >= 5) {
      return true;
    }

    return false;
  }

  /**
   * 短い有効な単語かどうか判定
   */
  private isShortValidWord(text: string): boolean {
    const shortValidWords = [
      'はい', 'いいえ', 'OK', 'ok', 'うん', 'ううん', 'ええ', 'いえ',
      'はい', 'ハイ', 'YES', 'yes', 'NO', 'no', 'いいえ', 'イイエ',
      'わかった', 'わからない', 'そう', 'そうでない', 'そうですね',
      'ありがとう', 'すみません', 'ごめんなさい', 'はいはい',
      'なるほど', 'そうか', 'そうですね', 'そうです', 'そうじゃない'
    ];
    
    return shortValidWords.includes(text);
  }

  /**
   * 句読点で終わるかどうか判定
   */
  private endsWithTerminalPunctuation(text: string): boolean {
    const terminalPunctuation = /[。．.？！?!…]$/;
    return terminalPunctuation.test(text);
  }

  /**
   * ユーザーメッセージの確定
   */
  private commitUserMessage(): void {
    const message: ConversationMessage = {
      id: this.generateMessageId(),
      speaker: 'user',
      text: this.currentUserText,
      timestamp: new Date(),
      isFinal: true,
      turnId: this.currentUserTurnId,
    };

    this.messages.push(message);
  }

  /**
   * メッセージIDを生成
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 文字起こし機能が無効な場合の表示
   */
  public setTranscriptionDisabled(): void {
    if (this.isUserSpeaking) {
      this.currentUserText = '文字起こしオフ';
      this.lastActivity = new Date();
    }
  }

  /**
   * 音声状態の更新
   */
  public updateAudioStatus(userSpeaking: boolean, assistantSpeaking: boolean): void {
    this.isUserSpeaking = userSpeaking;
    this.isAssistantSpeaking = assistantSpeaking;
    this.lastActivity = new Date();
  }
}
