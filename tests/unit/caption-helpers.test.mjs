import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../apps/client/src/lib');
const sourcePath = path.join(projectRoot, 'caption-helpers.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const typescript = require(path.join(projectRoot, '..', '..', 'node_modules', 'typescript'));

const transpiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
});

const moduleExports = {};
const context = {
  module: { exports: moduleExports },
  exports: moduleExports,
  require,
  console,
};

vm.runInNewContext(transpiled.outputText, context, { filename: 'caption-helpers.js' });

const { guardCaption, extractCaption, AUDIO_ONLY_LABEL } = context.module.exports;

test('guardCaption allows typical text', () => {
  const result = guardCaption(' こんにちは。 ');
  assert.equal(result.sanitized, 'こんにちは。');
  assert.equal(result.reason, undefined);
});

test('guardCaption blocks placeholder symbol', () => {
  const result = guardCaption('?');
  assert.equal(result.sanitized, null);
  assert.equal(result.reason, 'placeholder');
});

test('guardCaption blocks prohibited phrase', () => {
  const result = guardCaption('マイクが設定されていません');
  assert.equal(result.sanitized, null);
  assert.ok(result.reason?.startsWith('pattern'));
});

test('extractCaption prefers server transcription', () => {
  const payload = {
    serverContent: {
      outputTranscription: {
        text: '最終文です。',
      },
    },
  };
  assert.equal(extractCaption(payload), '最終文です。');
});

test('extractCaption falls back to nested candidates', () => {
  const payload = {
    modelResponse: {
      outputs: [
        { content: [{ parts: [{ text: '途中経過' }] }] },
        { content: [{ parts: [{ text: '最終回答です。' }] }] },
      ],
    },
  };
  assert.equal(extractCaption(payload), '最終回答です。');
});

test('audio only label constant is stable', () => {
  assert.equal(AUDIO_ONLY_LABEL, '（音声のみ）');
});
