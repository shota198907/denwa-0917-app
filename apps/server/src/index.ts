import http from "node:http";
import { URL } from "node:url";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { env } from "./env";
import { corsMiddleware } from "./middleware/cors";
import { requestLoggingMiddleware } from "./middleware/logging";
import { healthRouter } from "./routes/health";
import { tokenRouter } from "./routes/token";
import { registerWsProxy } from "./routes/ws-proxy";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(requestLoggingMiddleware);
app.use(corsMiddleware);

app.use("/health", healthRouter);
app.use("/token", tokenRouter);

const server = http.createServer(app);

const proxyWss = new WebSocketServer({ noServer: true });
const echoWss = new WebSocketServer({ noServer: true });

echoWss.on("connection", (socket: WebSocket) => {
  socket.send(JSON.stringify({ hello: "ws", time: Date.now() }));
  socket.on("message", (data, isBinary) => {
    try {
      socket.send(data, { binary: isBinary });
    } catch (error) {
      console.error("echo ws send failed", error);
    }
  });
});

registerWsProxy(proxyWss);

server.on("upgrade", (req, socket, head) => {
  const host = req.headers.host ?? `localhost:${env.port}`;
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
  } catch (error) {
    console.error("Failed to parse upgrade URL", error);
  }

  if (pathname === "/ws-proxy") {
    proxyWss.handleUpgrade(req, socket, head, (ws) => {
      proxyWss.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/echo") {
    echoWss.handleUpgrade(req, socket, head, (ws) => {
      echoWss.emit("connection", ws, req);
    });
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

server.listen(env.port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${env.port}`);
});

const gracefulShutdown = () => {
  proxyWss.close();
  echoWss.close();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
