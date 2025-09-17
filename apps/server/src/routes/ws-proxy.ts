import { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { handleGeminiProxyConnection } from "../lib/gemini-live";

export const registerWsProxy = (wss: WebSocketServer): void => {
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    handleGeminiProxyConnection(socket, request);
  });
};
