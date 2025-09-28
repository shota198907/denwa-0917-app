import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

/**
 * TypeScript実装をオンザフライでトランスパイルし、ESMとして読み込む。
 * Node.jsの組み込みテストランナーに合わせた簡易ユーティリティ。
 */
const loadSummarizerModule = async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(currentDir, "../src/lib/log-summary.ts");
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const encoded = Buffer.from(transpiled, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
};

/**
 * サマライザの基本的なカテゴリ変換を検証する。
 */
test("SessionLogSummarizer converts websocket logs", async () => {
  const { SessionLogSummarizer } = await loadSummarizerModule();
  const summarizer = new SessionLogSummarizer();
  const summary = summarizer.summarize("[session=abc] [ws] open");
  assert.ok(summary, "summary should not be null");
  assert.equal(summary.category, "WebSocket");
  assert.equal(summary.importance, "info");
  assert.match(summary.message, /接続/);
});

/**
 * 字幕確定ログに含まれるテキストが欠落しないことを確認する。
 */
test("SessionLogSummarizer keeps caption commit text with spaces", async () => {
  const { SessionLogSummarizer } = await loadSummarizerModule();
  const summarizer = new SessionLogSummarizer();
  const summary = summarizer.summarize(
    "[caption:commit] reason=final text=よろしく お願いします length=8"
  );
  assert.ok(summary);
  assert.equal(summary.category, "字幕確定");
  assert.equal(summary.importance, "info");
  assert.match(summary.message, /text=よろしく お願いします/);
});

/**
 * チャンク系のノイズログはサマリー対象外であることを確認する。
 */
test("SessionLogSummarizer filters chunk-level logs", async () => {
  const { SessionLogSummarizer } = await loadSummarizerModule();
  const summarizer = new SessionLogSummarizer();
  const summary = summarizer.summarize("[session=abc] [player:chunk] size=1024");
  assert.equal(summary, null);
});

/**
 * バイナリサマリーが期待どおりのフィールドを含むことを検証する。
 */
test("SessionLogSummarizer extracts numeric metrics", async () => {
  const { SessionLogSummarizer } = await loadSummarizerModule();
  const summarizer = new SessionLogSummarizer();
  const summary = summarizer.summarize(
    "[session=abc] [binary:summary] reason=interval chunks=5 bytes=4096 span_ms=1200"
  );
  assert.ok(summary);
  assert.equal(summary.category, "音声受信");
  assert.equal(summary.importance, "info");
  assert.match(summary.message, /chunks=5/);
  assert.match(summary.message, /bytes=4096/);
});
