import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const loadModule = async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(currentDir, "../src/lib/transcription-utils.ts");
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const encoded = Buffer.from(transpiled, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
};

test("extractTranscript prefers direct outputTranscription", async () => {
  const { extractTranscript } = await loadModule();
  const payload = {
    serverContent: {
      outputTranscription: { text: "優先テキスト" },
    },
    outputs: [{ text: "fallback" }],
  };
  const transcript = extractTranscript(payload);
  assert.equal(transcript, "優先テキスト");
});

test("extractTranscript resolves nested modelTurn outputTranscription", async () => {
  const { extractTranscript } = await loadModule();
  const payload = {
    modelTurn: [
      {
        generation: {
          output: {
            outputTranscription: { text: "ネストされたテキスト。" },
          },
        },
      },
    ],
  };
  const transcript = extractTranscript(payload);
  assert.equal(transcript, "ネストされたテキスト。");
});
