import { Request, Response, NextFunction } from "express";
import { env } from "../env";

export const corsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  res.header("Access-Control-Allow-Origin", env.allowedOrigin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
};
