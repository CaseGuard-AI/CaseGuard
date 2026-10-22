import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/db/schema.ts against drizzle/ and writes the next migration.
// Every generated NNNN_<tag>.sql needs a hand-written NNNN_<tag>.down.sql (ADR-0007).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["app"],
  migrations: { schema: "app" },
  dbCredentials: { url: process.env.API_DATABASE_URL ?? "" },
});
