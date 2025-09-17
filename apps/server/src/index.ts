import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { WebSocketServer } from "ws";

const app = express();
const port = Number(process.env.PORT) || 8080;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "http://localhost:5173";

app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// 開発用ダミーの /token
app.get("/token", (_req: Request, res: Response) => {
  const hasKey = typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
  const token = "dev-" + crypto.randomBytes(12).toString("hex");
  res.json({ token, dev: true, geminiApiKeyLoaded: hasKey, expiresInSec: 600 });
});

// HTTPサーバで待受（Cloud Run は 0.0.0.0 必須）
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});

// /echo（WebSocketエコー：疎通確認用）
const wss = new WebSocketServer({ server, path: "/echo" });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ hello: "ws", time: Date.now() }));
  socket.on("message", (data) => socket.send(data));
});
