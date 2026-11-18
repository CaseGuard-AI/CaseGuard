import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Real environment variables win, then apps/api/.env, then the repo-root .env
// (dotenv never overwrites a variable that is already set).
for (const rel of ["../../.env", "../../../../.env"]) {
  const path = fileURLToPath(new URL(rel, import.meta.url));
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

// `KEY=` in .env means unset, not an empty value.
const blankAsUnset = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

/** Whether `value` is standard base64 that decodes to exactly 32 bytes (an AES-256 key). */
export function isBase64Key32(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  return Buffer.from(value, "base64").length === 32;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_DATABASE_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  AI_SERVICE_TOKEN: z.string().min(16, "AI_SERVICE_TOKEN must be at least 16 characters"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Email (#61). Unset SMTP_HOST disables sending: the API starts, and every send fails.
  SMTP_HOST: blankAsUnset,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: blankAsUnset,
  SMTP_PASSWORD: blankAsUnset,
  MAIL_FROM: z.string().min(3).default("CaseGuard <no-reply@caseguard.local>"),
  // The web page that password reset emails link to (#53, #62); the token goes in ?token=.
  RESET_URL_BASE: z.string().url().default("http://localhost:3000/reset-password"),
  // AES-256-GCM key for user API keys (FR-SET-2, SEC-4, ADR-0009): base64 of 32 random bytes.
  // Unset means saving a key answers 503; listing and deleting keys still work.
  KEY_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .refine(isBase64Key32, "KEY_ENCRYPTION_KEY must be base64 that decodes to exactly 32 bytes")
      .optional(),
  ),
  // Uploads (#101, data-storage §6). Only the `fs` driver exists so far; `s3` comes with the
  // hosted demo. Native runs default to the git-ignored /uploads folder at the repo root.
  STORAGE_DRIVER: z.enum(["fs"]).default("fs"),
  UPLOADS_DIR: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .min(1)
      .default(fileURLToPath(new URL("../../../../uploads", import.meta.url))),
  ),
  // The contract caps uploads at 25 MB (FR-DOC-1), so a deployment may only lower it.
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(25).default(25),
  // Processing attempts per run, automatic retries included (NFR-13, ADR-0010).
  DOCUMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Runs the pg-boss workers (document ingest and purge) in this process.
  WORKERS_ENABLED: z.stringbool().default(true),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseWith(schema, source);
}

// The migration CLI needs only the database, not the AI or JWT secrets.
const dbSchema = schema.pick({ NODE_ENV: true, API_DATABASE_URL: true, LOG_LEVEL: true });

export function parseDbEnv(source: NodeJS.ProcessEnv = process.env): z.infer<typeof dbSchema> {
  return parseWith(dbSchema, source);
}

// `pnpm mail:check` needs only the SMTP settings (#116).
const mailSchema = schema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  SMTP_HOST: true,
  SMTP_PORT: true,
  SMTP_SECURE: true,
  SMTP_USER: true,
  SMTP_PASSWORD: true,
  MAIL_FROM: true,
});

export function parseMailEnv(source: NodeJS.ProcessEnv = process.env): z.infer<typeof mailSchema> {
  return parseWith(mailSchema, source);
}

function parseWith<T extends z.ZodType>(s: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = s.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (see .env.example):\n${issues}`);
  }
  return result.data;
}
