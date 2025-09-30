import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const loadHelpers = async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(currentDir, "../src/lib/caption-helpers.ts");
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const encoded = Buffer.from(transpiled, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
};

test("extractCaption reads outputTranscription text", async () => {
  const { extractCaption } = await loadHelpers();
  const payload = {
    serverContent: {
      outputTranscription: { text: "直接検出" },
    },
    outputs: [{ text: "短い" }],
  };
  const caption = extractCaption(payload);
  assert.equal(caption, "直接検出");
});

test("extractCaption walks nested modelTurn structures", async () => {
  const { extractCaption } = await loadHelpers();
  const payload = {
    modelTurn: [
      {
        data: {
          outputTranscription: { text: "ネスト検出" },
        },
      },
    ],
  };
  const caption = extractCaption(payload);
  assert.equal(caption, "ネスト検出");
});
