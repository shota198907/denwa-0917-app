import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverLibDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/server/src/lib');
const ts = require(path.resolve(serverLibDir, '..', '..', 'node_modules', 'typescript'));

const compileModule = (relativePath, mocks = {}) => {
  const sourcePath = path.join(serverLibDir, relativePath);
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
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier];
      }
      return require(specifier);
    },
    console,
    Buffer,
  };
  vm.runInNewContext(result.outputText, context, { filename: relativePath.replace(/\.ts$/, '.js') });
  return context.module.exports;
};

const transcriptionUtils = compileModule('transcription-utils.ts');
const { LiveSegmenter } = compileModule('live-segmenter.ts', {
  './transcription-utils': transcriptionUtils,
});

const createChunk = (values) => {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => {
    buffer.writeInt16LE(value, index * 2);
  });
  return buffer;
};

const ACTIVE_SAMPLE = 8000;
const SILENT_SAMPLE = 0;

let segmenter;

beforeEach(() => {
  segmenter = new LiveSegmenter({
    sampleRate: 24000,
    silenceThreshold: 600,
    silenceDurationMs: 300,
    maxPendingSegments: 4,
  });
});

test('segmenter emits SEGMENT_COMMIT when transcript and audio are aligned', () => {
  const speech = Array(2400).fill(ACTIVE_SAMPLE);
  const silence = Array(7200).fill(SILENT_SAMPLE);
  const audioBuffer = createChunk([...speech, ...silence]);

  const { events } = segmenter.handleUpstreamPayload(
    { serverContent: { outputTranscription: { text: 'こんにちは。' } } },
    [{ buffer: audioBuffer, mimeType: 'audio/pcm;rate=24000' }]
  );

  assert.equal(events.length, 1);
  const commit = events[0];
  assert.equal(commit.event, 'SEGMENT_COMMIT');
  assert.equal(commit.text, 'こんにちは。');
  assert.ok(commit.audio.length > 0);
  assert.ok(commit.nominalDurationMs >= 300);
  assert.equal(commit.audioSamples, Math.floor(commit.audioBytes / 2));
});

test('segmenter emits TURN_COMMIT on generationComplete', () => {
  const speech = Array(2400).fill(ACTIVE_SAMPLE);
  const silence = Array(7200).fill(SILENT_SAMPLE);
  const audioBuffer = createChunk([...speech, ...silence]);

  const initialResult = segmenter.handleUpstreamPayload(
    { serverContent: { outputTranscription: { text: '了解しました。' } } },
    [{ buffer: audioBuffer, mimeType: 'audio/pcm;rate=24000' }]
  );
  assert.equal(initialResult.events.length, 1);
  assert.equal(initialResult.events[0].event, 'SEGMENT_COMMIT');

  segmenter.handleUpstreamPayload(
    { generationComplete: true, serverContent: { outputTranscription: { text: '了解しました。' } } },
    []
  );

  const result = segmenter.finalizeTurn({ force: true });
  assert.equal(result.events.length, 1);
  const [turnCommit] = result.events;
  assert.equal(turnCommit.event, 'TURN_COMMIT');
  assert.equal(turnCommit.finalText, '了解しました。');
  assert.equal(turnCommit.segmentCount, 1);
});

test('segmenter suppresses empty TURN_COMMIT when no transcript is present', () => {
  segmenter.handleUpstreamPayload({ generationComplete: true }, []);
  const result = segmenter.finalizeTurn({ force: true });
  assert.equal(result.events.length, 0);
});

test('forceCompleteTurn flushes residual partial text', () => {
  const speech = Array(2400).fill(ACTIVE_SAMPLE);
  const audioBuffer = createChunk([...speech]);

  segmenter.handleUpstreamPayload(
    { serverContent: { outputTranscription: { text: 'テ' } } },
    [{ buffer: audioBuffer, mimeType: 'audio/pcm;rate=24000' }]
  );

  const result = segmenter.forceCompleteTurn();
  assert.equal(result.events.length, 2);
  const [segment, turn] = result.events;
  assert.equal(segment.event, 'SEGMENT_COMMIT');
  assert.equal(segment.text, 'テ');
  assert.equal(turn.event, 'TURN_COMMIT');
  assert.equal(turn.finalText, 'テ');
  assert.equal(turn.segmentCount, 1);
});

test('transcription utils split partial sentences correctly', () => {
  const { parseSentences } = transcriptionUtils;
  const result = parseSentences('最初の文です。次の文の途');
  assert.deepStrictEqual(Array.from(result.complete), ['最初の文です。']);
  assert.equal(result.partial, '次の文の途');
});
