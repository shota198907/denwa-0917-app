import { Request, Response, NextFunction } from "express";

export const requestLoggingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const { method, originalUrl } = req;
    const status = res.statusCode;
    console.log(JSON.stringify({ level: "info", event: "http_request", method, url: originalUrl, status, durationMs }));
  });

  next();
};
