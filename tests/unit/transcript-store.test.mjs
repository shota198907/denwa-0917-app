import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const clientLibDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/client/src/lib');
const ts = require(path.resolve(clientLibDir, '..', '..', 'node_modules', 'typescript'));

const compileModule = (relativePath) => {
  const sourcePath = path.join(clientLibDir, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
    },
  });
  const sandboxExports = {};
  const context = {
    module: { exports: sandboxExports },
    exports: sandboxExports,
    require,
    console,
  };
  vm.runInNewContext(result.outputText, context, { filename: relativePath.replace(/\.ts$/, '.js') });
  return context.module.exports;
};

const { TranscriptStore } = compileModule('transcript-store.ts');

let store;

beforeEach(() => {
  store = new TranscriptStore();
});

test('commitSegment accumulates sentence timings', () => {
  const firstSnapshot = store.commitSegment({
    segmentId: '1-0',
    turnId: 1,
    index: 0,
    text: 'こんにちは。',
    durationMs: 320,
  });

  assert.equal(firstSnapshot.turns.length, 1);
  const firstSentence = firstSnapshot.turns[0].sentences[0];
  assert.equal(firstSentence.startMs, 0);
  assert.equal(firstSentence.endMs, 320);

  const secondSnapshot = store.commitSegment({
    segmentId: '1-1',
    turnId: 1,
    index: 1,
    text: 'よろしくお願いします。',
    durationMs: 640,
  });

  const turn = secondSnapshot.turns[0];
  assert.equal(turn.sentences.length, 2);
  const secondSentence = turn.sentences[1];
  assert.equal(secondSentence.startMs, 320);
  assert.equal(secondSentence.endMs, 960);
  assert.equal(secondSnapshot.displayText, 'こんにちは。\nよろしくお願いします。');
});

test('finalizeTurn marks turn as complete and keeps display text', () => {
  store.commitSegment({
    segmentId: '2-0',
    turnId: 2,
    index: 0,
    text: '最初の文です。',
    durationMs: 400,
  });
  store.commitSegment({
    segmentId: '2-1',
    turnId: 2,
    index: 1,
    text: '次の文です。',
    durationMs: 400,
  });

  const snapshot = store.finalizeTurn({
    turnId: 2,
    finalText: '最初の文です。次の文です。',
    segmentCount: 2,
  });

  assert.equal(snapshot.turns[0].finalized, true);
  assert.equal(snapshot.displayText, '最初の文です。\n次の文です。');
});

test('finalizeTurn inserts fallback sentence when no segments exist', () => {
  const snapshot = store.finalizeTurn({
    turnId: 3,
    finalText: '',
    segmentCount: 0,
    fallbackText: '（音声のみ）',
  });

  assert.equal(snapshot.turns.length, 1);
  const turn = snapshot.turns[0];
  assert.equal(turn.sentences.length, 1);
  assert.equal(turn.sentences[0].text, '（音声のみ）');
  assert.equal(snapshot.displayText, '（音声のみ）');
});
