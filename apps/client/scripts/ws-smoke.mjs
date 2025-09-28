#!/usr/bin/env node
import WebSocket from "ws";

const usage = () => {
  console.error("Usage: pnpm smoke -- <wss-url> [text]");
  console.error("Example: pnpm smoke -- wss://example.run.app/ws-proxy テストです。応答できますか？");
  process.exit(1);
};

const [, , urlArg, ...textParts] = process.argv;
if (!urlArg) usage();

const text = textParts.length > 0 ? textParts.join(" ") : "テストです。応答できますか？";

const ws = new WebSocket(urlArg);

ws.on("open", () => {
  console.log("OPEN", urlArg);
  const payload = { realtimeInput: { text } };
  ws.send(JSON.stringify(payload));
});

ws.on("message", (data) => {
  let printable = data;
  if (data instanceof Buffer) {
    printable = data.toString();
  }
  console.log("MSG", printable);
});

ws.on("close", (code, reason) => {
  console.log("CLOSE", code, reason.toString());
  process.exit(0);
});

ws.on("error", (error) => {
  console.error("ERROR", error.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  ws.close(1000, "client_abort");
  process.exit(0);
});
