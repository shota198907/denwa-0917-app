# Client Detection Report

- **Tooling**: Vite 5 + React 18 (`apps/client/package.json`, `vite.config.ts`).
- **Entry point**: `apps/client/src/main.tsx` renders `<App />` directly to `#root`.
- **Routing strategy**: No router in place; single `App.tsx` renders the entire UI. New views must be added by branching inside `App` or by mounting alternate trees when `location.pathname === "/live-test"`.
- **Key scripts**: `pnpm dev`, `pnpm build`, and `pnpm preview` defined in `apps/client/package.json`.
- **Environment**: Backend base URL read from `import.meta.env.VITE_BACKEND_URL` (already used in `App.tsx`).
