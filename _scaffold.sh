#!/usr/bin/env bash
set -euo pipefail

# sentinel
: > gemini_DENWA

# ---- directories ----
dirs=(
  apps apps/client apps/client/public apps/client/src
  apps/client/src/assets apps/client/src/audio apps/client/src/audio/worklets
  apps/client/src/components apps/client/src/hooks apps/client/src/state
  apps/client/src/utils apps/client/src/config apps/client/src/styles
  apps/client/src/types apps/client/tests apps/client/src/lib
  apps/server apps/server/src apps/server/src/routes apps/server/src/lib
  apps/server/src/middleware apps/server/src/types apps/server/tests
  apps/server/src/observability
  packages packages/shared packages/shared/src
  packages/schemas packages/schemas/src
  packages/configs packages/configs/eslint packages/configs/ts
  docs docs/diagrams docs/adr
  tests tests/e2e tests/fixtures/audio
  scripts .github .github/workflows
  infra infra/terraform infra/terraform/modules/cloud_run
  infra/terraform/envs/dev infra/terraform/envs/prod
  apps/token-server apps/token-server/src
)

# ---- files (empty placeholders) ----
files=(
  README.md LICENSE package.json pnpm-workspace.yaml tsconfig.base.json
  .editorconfig .gitignore .nvmrc .prettierrc .eslintrc.cjs .env.example

  apps/client/package.json apps/client/tsconfig.json apps/client/vite.config.ts
  apps/client/index.html apps/client/.env.example
  apps/client/public/manifest.webmanifest
  apps/client/public/favicon.svg
  apps/client/public/icons/icon-192.png
  apps/client/public/icons/icon-512.png

  apps/client/src/main.tsx apps/client/src/App.tsx
  apps/client/src/styles/global.css
  apps/client/src/audio/index.ts
  apps/client/src/audio/audio-context.ts
  apps/client/src/audio/recorder.ts
  apps/client/src/audio/player.ts
  apps/client/src/audio/ring-buffer.ts
  apps/client/src/audio/pcm24k-resampler.ts
  apps/client/src/audio/worklets/pcm16-encoder.worklet.ts
  apps/client/src/audio/worklets/fallback-scriptprocessor.ts
  apps/client/src/audio/clock.ts
  apps/client/src/hooks/useVAD.ts
  apps/client/src/hooks/useLiveSession.ts
  apps/client/src/hooks/useSilencePrompt.ts
  apps/client/src/utils/ws-client.ts
  apps/client/src/config/gemini.ts
  apps/client/src/types/live-api.ts
  apps/client/src/components/MicButton.tsx
  apps/client/src/components/AudioDeviceSelector.tsx
  apps/client/src/components/StatusBar.tsx
  apps/client/src/components/LatencyMeter.tsx
  apps/client/src/components/Subtitles.tsx
  apps/client/src/components/InterruptionBadge.tsx
  apps/client/src/state/session-store.ts
  apps/client/src/utils/metrics.ts
  apps/client/src/utils/logger.ts
  apps/client/tests/app.spec.ts
  apps/client/vite.plugins.ts
  apps/client/src/lib/compat.ts
  apps/client/src/env.d.ts

  apps/server/package.json apps/server/tsconfig.json apps/server/.env.example
  apps/server/Dockerfile apps/server/cloudrun.yaml
  apps/server/src/index.ts
  apps/server/src/routes/health.ts
  apps/server/src/routes/ws-proxy.ts
  apps/server/src/routes/token.ts
  apps/server/src/lib/gemini-live.ts
  apps/server/src/lib/backoff.ts
  apps/server/src/lib/rate-limit.ts
  apps/server/src/middleware/cors.ts
  apps/server/src/middleware/logging.ts
  apps/server/src/types/index.ts
  apps/server/tests/ws-proxy.spec.ts
  apps/server/src/observability/metrics.ts
  apps/server/src/observability/tracing.ts
  apps/server/src/env.ts

  packages/shared/package.json
  packages/shared/tsconfig.json
  packages/shared/src/index.ts
  packages/shared/src/types.ts
  packages/shared/src/constants.ts
  packages/shared/src/audio.ts

  packages/schemas/package.json
  packages/schemas/src/index.ts
  packages/configs/package.json
  packages/configs/ts/tsconfig.base.json
  packages/configs/eslint/index.cjs
  packages/configs/prettier.json

  docs/architecture.md docs/operations.md docs/testing.md docs/api.md
  docs/security.md docs/runbook.md docs/latency.md
  docs/diagrams/architecture.mmd
  docs/diagrams/sequence-live.mmd
  docs/adr/0001-monorepo.md

  tests/e2e/playwright.config.ts
  tests/e2e/specs/basic-call.spec.ts
  tests/e2e/specs/audio-latency.spec.ts
  tests/fixtures/audio/hello-16k-mono.pcm

  scripts/dev.sh scripts/format.sh scripts/deploy-cloudrun.sh
  .github/workflows/ci.yml

  infra/terraform/modules/cloud_run/main.tf
  infra/terraform/modules/cloud_run/variables.tf
  infra/terraform/envs/dev/main.tf
  infra/terraform/envs/prod/main.tf
  infra/terraform/README.md

  apps/token-server/package.json
  apps/token-server/src/index.ts
)

mkdir -p "${dirs[@]}"
for f in "${files[@]}"; do
  mkdir -p "$(dirname "$f")"
  : > "$f"
done

echo "Scaffold complete."
# 確認用（treeが無ければfindで代用）
if command -v tree >/dev/null 2>&1; then
  tree -a -I 'node_modules|.git'
else
  find . -not -path '*/node_modules/*' -not -path '*/.git/*' | sort
fi
