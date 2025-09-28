# Live API 文セグメント・ストリーミング提案書

## 1. 要約
- **目的**: Gemini Live API出力を`SEGMENT_COMMIT`/`TURN_COMMIT`イベントとして配信し、音声と字幕の乖離（欠片・頭欠け・「音声のみ」ラベル）を解消する。
- **結論**: 現行コードベースは本方針に適合済みであり、設計上の大きな阻害要因は確認されない。Codexによる承認後、段階的ロールアウトが推奨される。

## 2. 現状整理
- サーバーはGemini Live APIへのWSプロキシで、音声(PCM)とJSONをそのままクライアントへ中継している (`apps/server/src/lib/gemini-live.ts:520`).
- クライアントは順次到着する音声PCMと字幕候補をヒューリスティックスで同期しようとするが、応答終端検出が不安定で字幕欠けが発生 (`apps/client/src/lib/ws-audio.ts:721`).

## 3. 提案アーキテクチャ
### 3.1 サーバー側
1. Geminiセットアップを`responseModalities: ["AUDIO"]` + `outputAudioTranscription`有効化で開始 (`apps/server/src/lib/gemini-live.ts:240`).
2. 受信したJSONペイロードを`LiveSegmenter`で解析し、
   - テキスト: 文末（。！？…）で確定文を抽出 (`apps/server/src/lib/transcription-utils.ts:68`).
   - 音声: 24kHz PCMを無音しきい値(750)と連続時間(320ms)で分割 (`apps/server/src/lib/live-segmenter.ts:58`).
3. テキストと音声チャンクを1対1でペアリングし、`SEGMENT_COMMIT`イベントを生成 (`apps/server/src/lib/live-segmenter.ts:167`).
4. `generationComplete`などターン終了時に全文を`TURN_COMMIT`として配信し、残差バッファを同期 (`apps/server/src/lib/live-segmenter.ts:192`).

### 3.2 クライアント側
1. WebSocketで`SEGMENT_COMMIT`/`TURN_COMMIT`を受信した場合は既存の暫定処理をバイパスし、
   - `SEGMENT_COMMIT`: 音声バイナリを再生キューへ投入、字幕は最新1文として表示 (`apps/client/src/lib/ws-audio.ts:779`).
   - `TURN_COMMIT`: そのターンの全文表示に置換し、指標を更新 (`apps/client/src/lib/ws-audio.ts:813`).
2. commitモードでは従来の字幕ヒューリスティックスを停止し、重複コミットを防止 (`apps/client/src/lib/ws-audio.ts:1757`).
3. プレイヤー先行バッファ1.2s・最小クロスフェード12msを適用し再生の揺れを抑制 (`apps/client/src/lib/ws-audio.ts:30`, `apps/client/src/audio-worklets/player.worklet.js:11`).

## 4. 実装可能性評価
### 4.1 技術的成立性
- **API互換性**: Live APIは`outputAudioTranscription`でテキスト出力を保証。セグメンターは既存プロキシ内で完結し追加インフラ不要。
- **計算コスト**: 無音検出はO(n)で、24kHz/16bit PCMでもCloud Run (1 vCPU)で十分処理可能。
- **クライアント互換性**: 新イベントは追加情報であり、既存ヒューリスティックも後方互換的に保持可能（フィーチャーフラグ切替）。

### 4.2 リスクと緩和策
| リスク | 内容 | 緩和策 |
| --- | --- | --- |
| 無音境界ズレ | API音声としきい値の差異でペアリング失敗 | しきい値/持続時間を環境変数で調整 (`apps/server/src/env.ts:94`)・ログで監視 |
| バックプレッシャー | セグメント滞留で遅延 | `SEGMENT_MAX_PENDING`でキャップし警告ログ (`apps/server/src/lib/live-segmenter.ts:161`) |
| クライアント既存機能との整合 | 旧UI/ログ機構への影響 | フィーチャーフラグで段階展開 ( `apps/client/src/lib/ws-audio.ts:379` ) |

## 5. 選択肢比較
1. **提案方式** — 音声と字幕が常に一致、再生制御が単純。<br>
2. **ヒューリスティック継続** — 実装コスト0だが改善余地が小さい。<br>
3. **全文確定後に一括配信** — 欠片は消えるが遅延増大。<br>
→ 低遅延と品質の両立を実現できるのは提案方式。

## 6. 検証計画
1. **単体テスト**: `node --test tests/unit/*.test.mjs` によりセグメント生成と文解析の基本ケースを検証済み (`tests/unit/live-segmenter.test.mjs:67`).
2. **結合テスト**: ステージング環境でLive APIと接続し、ログに基づき字幕遅延と`AUDIO_ONLY_LABEL`発生率を計測。
3. **メトリクス**: セグメント長・ターンあたり遅延・フォールバック率 (`apps/client/src/lib/ws-audio.ts:1804`).

## 7. ロールアウト手順案
1. フィーチャーフラグを利用しクローズドβで先行展開。<br>
2. Cloud Runへは既存`Dockerfile`/`cloudbuild.yaml`を用い、環境変数で新パラメータを設定。<br>
3. モニタリング: `trace`/`metrics`でセグメントイベントを計測 (`apps/server/src/lib/gemini-live.ts:675`).

## 8. Codexへの確認事項
- 無音検出パラメータの初期値（閾値750 / 320ms）について推奨値の有無。
- `SEGMENT_COMMIT`に信頼度や音素情報など追加したいメタデータがあるか。
- TURN境界検出に`generationComplete`以外のシグナル（例: API側TURNイベント）を併用すべきか。

---
上記内容での実装は既にコードベースへ適用済みであり、Codexでの技術レビューと承認後、段階的ロールアウトの準備が整っている。ご確認をお願いします。
