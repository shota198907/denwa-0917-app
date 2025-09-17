interface TracePayload {
  readonly event: string;
  readonly data?: Record<string, unknown>;
}

const shouldLog = (): boolean => process.env.NODE_ENV !== "production";

export const trace = (payload: TracePayload): void => {
  if (!shouldLog()) return;
  const now = new Date().toISOString();
  console.log(JSON.stringify({ level: "debug", timestamp: now, ...payload }));
};
