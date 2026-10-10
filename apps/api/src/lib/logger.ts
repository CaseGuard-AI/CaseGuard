import { pino } from "pino";

// Never log secrets, tokens or document contents (CONTRIBUTING, SEC-4).
export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
