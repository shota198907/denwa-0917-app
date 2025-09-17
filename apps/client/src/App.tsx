import React, { useState } from "react";

export default function App() {
  const [status, setStatus] = useState("(未実行)");

  async function ping() {
    const url = `${import.meta.env.VITE_BACKEND_URL}/health`;
    const res = await fetch(url, { mode: "cors" });
    const json = await res.json();
    setStatus(JSON.stringify(json));
  }

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Health Check</h1>
      <button onClick={ping} style={{ padding: "8px 12px" }}>
        /health を呼ぶ
      </button>
      <pre style={{ marginTop: 12 }}>{status}</pre>
    </div>
  );
}
