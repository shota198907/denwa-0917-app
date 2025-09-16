# バックエンド要件定義書 (音声対話Webアプリ / v4.0 / 2025-09-16)

---

## 1. アーキテクチャ（バックエンド）

* **バックエンド**：Cloud Run

  * 最小1インスタンス稼働（コールドスタート回避）
  * concurrency=1（1セッション=1コンテナ）
  * APIキー管理（開発）、本番はトークンサーバで**エフェメラルトークン**発行

---

## 2. モデル & モダリティ

* **既定モデル**：`gemini-live-2.5-flash-preview`（低遅延）

* **代替モデル**：`gemini-2.5-flash-preview-native-audio-dialog`（高音質）

* **制約**：TEXTかAUDIOの1種のみ指定可

  * 字幕が必要な場合：`response_modalities=["AUDIO"]` + `output_audio_transcription`
  * 入力字幕：`input_audio_transcription`

* **入出力仕様**

  * 入力：16bit LE PCM / 16kHz / mono
  * 出力：16bit LE PCM / 24kHz

---

## 5. セッション & 再接続

* **Live API会話セッション**

  * 既定10分、終了60秒前に`goAway`通知
  * **8〜9分ごとに計画再接続**、`sessionResumption`で引き継ぎ

* **音声セッション寿命**

  * 音声のみ＝15分
  * `contextWindowCompression`で長時間対話拡張

* **Cloud Run制約**

  * WS接続最大60分

---

## 7. 通信仕様（例）

### `setup`

```json
{
  "setup": {
    "model": "gemini-live-2.5-flash-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": {
        "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } }
      }
    },
    "systemInstruction": "あなたは親切な日本語アシスタントです。",
    "realtimeInputConfig": {
      "automaticActivityDetection": {
        "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
        "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
        "prefixPaddingMs": 300,
        "silenceDurationMs": 800
      },
      "activityHandling": "START_OF_ACTIVITY_INTERRUPTS"
    },
    "outputAudioTranscription": {},
    "sessionResumption": { "transparent": true },
    "contextWindowCompression": { "triggerTokens": 32000 }
  }
}
```

---

## 8. エラー処理 & レート制御

* **切断**：指数バックオフ再接続（計画再接続を優先）
* **429**：音声チャンクサイズ・送信間隔を調整
* **音声処理失敗**：入力→テキスト代替、出力→字幕のみ
* **セッション満了**：`goAway`ハンドリング、事前再接続

---

## 9. セキュリティ（バックエンド関連）

* **開発**：APIキーはサーバ保管、クライアントへ非露出
* **本番**：トークンサーバで**エフェメラルトークン発行**
* **CORS**：許可オリジンのみ
* **ログ**：PIIを除去、匿名化

---

## 10. テスト計画 & 受け入れ基準（バックエンド関連）

* 8〜9分で計画再接続し、文脈維持確認
* 15分セッション境界で正常継続
* 平均遅延≤600ms（5ターン連続の計測で）
