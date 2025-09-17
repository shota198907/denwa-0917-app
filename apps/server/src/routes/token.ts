import crypto from "node:crypto";
import { Router } from "express";

interface TokenResponse {
  readonly token: string;
  readonly expiresInSec: number;
  readonly mode: "development" | "ephemeral";
  readonly geminiApiKeyLoaded: boolean;
}

const createDevToken = (): TokenResponse => {
  const token = `dev-${crypto.randomBytes(12).toString("hex")}`;
  return {
    token,
    expiresInSec: 600,
    mode: "development",
    geminiApiKeyLoaded: typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0,
  };
};

export const tokenRouter = Router();

// Placeholder: swap with ephemeral token issuance once IAM-based flow is ready.
tokenRouter.get("/", (_req, res) => {
  const response = createDevToken();
  res.json(response);
});
