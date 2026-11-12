import { pino, type DestinationStream } from "pino";

// Never log secrets, tokens or document contents (CONTRIBUTING, SEC-4). Users' provider keys
// (FR-SET-2, ADR-0009) arrive as `apiKey` in PUT /me/keys bodies and travel as
// `credential.apiKey` to services/ai, so every path either can take is censored.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "req.body.apiKey",
  "apiKey",
  "*.apiKey",
  "credential.apiKey",
  "*.credential.apiKey",
];

/** `destination` (tests) writes JSON lines to a stream instead of stdout; not with `pretty`. */
export function createLogger(level: string, pretty: boolean, destination?: DestinationStream) {
  const options = {
    level,
    redact: REDACT_PATHS,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  };
  return destination && !pretty ? pino(options, destination) : pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
