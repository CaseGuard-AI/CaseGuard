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

function parseWith<T extends z.ZodType>(s: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = s.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (see .env.example):\n${issues}`);
  }
  return result.data;
}
