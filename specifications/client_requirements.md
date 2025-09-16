# クライアント要件定義書 (音声対話Webアプリ / v4.0 / 2025-09-16)

---

## 1. アーキテクチャ（クライアント）

* **クライアント**：React + Web Audio API

  * AudioWorkletでPCM16エンコード（16kHz/mono）
  * Safari/iOSでAudioContext解放はユーザ操作に依存
  * 古環境のみScriptProcessorNodeをフォールバック（非推奨・注意書きあり）

---

## 3. 音声入出力（ブラウザ）

* **録音**：`getUserMedia({ echoCancellation:true, noiseSuppression:true, autoGainControl:true })`

  * AudioWorkletでFloat32→PCM16変換
  * Base64エンコードし、`realtimeInput.audio`として送信

* **再生**：24kHz PCMをリングバッファで再生

  * Safariでの再生開始はユーザ操作必須
  * バージイン時はバッファを即フラッシュ

---

## 4. 会話制御（VAD・無音・割り込み）

* **VAD**

  * `START_SENSITIVITY_HIGH` / `END_SENSITIVITY_HIGH`
  * `prefixPaddingMs=300`, `silenceDurationMs=800`
  * `activityHandling=START_OF_ACTIVITY_INTERRUPTS`（割り込み可）

* **無音促し**

  * APIには自動機能なし
  * クライアント側で5秒無音→促し文を送信
  * 連続での促しは回避する制御を追加

---

## 10. テスト計画 & 受け入れ基準（クライアント関連）

* 音声1往復（AUDIO＋字幕）
* 割り込み時、再生停止≤150ms
* 5秒無音で促し送出（UI側）
* Safari/Chrome/Firefox/Edgeでマイク・再生テスト
* 平均遅延≤600ms（5ターン連続の計測で）

---

## 12. 非対象（MVP, クライアント関連）

* ユーザー認証UI
* 課金機能
* 会話保存・検索
* マルチユーザー管理
