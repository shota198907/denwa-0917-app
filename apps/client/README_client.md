# Live Test Client (Vite + React)

This client provides a `/live-test` console for driving the Gemini Live backend over WebSocket.

## Prerequisites

- Node.js 18+
- `pnpm` (uses the workspace root lockfile)
- A deployed backend URL exposed via HTTP(s) (e.g. Cloud Run)

## Setup

```bash
cd apps/client
pnpm install
cp .env.local.example .env.local
# edit .env.local and set VITE_BACKEND_URL=https://<your-backend-host>
```

## Development server

```bash
pnpm dev
# Open http://localhost:5173/live-test for the new console
```

## Production build

```bash
pnpm build
```

## Type check

```bash
pnpm typecheck
```

## WebSocket smoke test

```bash
pnpm smoke -- wss://<your-backend-host>/ws-proxy "テストです。応答できますか？"
```

The script prints `OPEN` when the socket is ready and emits each upstream message as `MSG ...` lines.

## Live test flow

1. Navigate to `http://localhost:5173/live-test`.
2. Click **Connect** to open a WebSocket to `${VITE_BACKEND_URL.replace(/^http/, "ws")}/ws-proxy`.
3. Use **Send** to push text prompts, or **Mic Start** to stream audio (after granting microphone access).
4. Captions from `serverContent.outputTranscription.text` appear in the captions panel; logs retain the 50 most recent entries.
