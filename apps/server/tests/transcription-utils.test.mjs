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

test("extractTranscript selects longest candidate", async () => {
  const { extractTranscript } = await loadModule();
  const payload = {
    outputs: [
      { text: "？" },
      { text: "おはようございます。" },
      { text: "お" },
    ],
  };
  const transcript = extractTranscript(payload);
  assert.equal(transcript, "おはようございます。");
});

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

test("inspectTranscriptPayload summarizes candidates", async () => {
  const { inspectTranscriptPayload } = await loadModule();
  const payload = {
    outputs: [
      { text: "？" },
      { text: "おはようございます。" },
      { text: "おはよう" },
    ],
  };
  const diagnostics = inspectTranscriptPayload(payload);
  assert.ok(diagnostics);
  assert.equal(diagnostics.bestCandidate, "おはようございます。");
  assert.ok(diagnostics.candidates.length >= 2);
});
