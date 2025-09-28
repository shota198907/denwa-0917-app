import React, { useMemo } from "react";
import LiveTestPage from "./pages/LiveTestPage";

const detectPathname = (): string => {
  if (typeof window === "undefined") return "/";
  return window.location.pathname || "/";
};

export default function App(): React.ReactElement {
  const pathname = useMemo(detectPathname, []);
  if (pathname === "/live-test") {
    return <LiveTestPage />;
  }
  return (
    <div style={{ padding: 32, fontFamily: "sans-serif", lineHeight: 1.6, maxWidth: 800 }}>
      <h1>Voice Dialog Client</h1>
      <p>
        開発サーバ起動後、<code>http://localhost:5173/live-test</code> を開いてください。
      </p>
      <p>
        必要な環境変数: <code>VITE_BACKEND_URL</code>（<code>apps/client/.env.local</code> に設定）。
      </p>
    </div>
  );
}
