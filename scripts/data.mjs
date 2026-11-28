#!/usr/bin/env node
// Routes the corpus data commands (docs/engineering/data-storage.md §7) to the service that owns
// them, so everyone types the same pnpm command on Windows, macOS and Linux:
//
//   pnpm data:push   -- --snapshot <partition> [--no-upload] [--yes]          services/collector (#152)
//   pnpm data:pull   -- --snapshot <partition> [--date D] [--with-files]      services/collector (#152)
//   pnpm data:pull   -- --dump latest|<date>[-N]|eval-frozen-<n> [--yes]      services/ai (#154)
//   pnpm data:status                                                          both: the repo, then the loaded corpus
//
// --dry-run prints the command(s) instead of running them.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = ["run", "--directory", "services/collector", "python", "-m", "snapshots"];
const AI = ["run", "--directory", "services/ai", "python"];
// The corpus loaded in the local AI database, from services/ai's own summary (#154).
const LOADED_CORPUS = [
  "from sqlalchemy import create_engine",
  "from caseguard_ai.config import DatabaseSettings",
  "from caseguard_ai.ingest.dump import corpus_summary, describe",
  "try:",
  "    engine = create_engine(DatabaseSettings().sqlalchemy_url, connect_args={'connect_timeout': 5})",
  "    with engine.connect() as conn:",
  "        print('loaded corpus:', describe(corpus_summary(conn)))",
  "except Exception as exc:",
  "    print(f'loaded corpus: unknown ({type(exc).__name__}: is the database up and migrated?)')",
].join("\n");

const [command, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run");
const args = rest.filter((a) => a !== "--" && a !== "--dry-run");
const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

function usage(message) {
  if (message) console.error(`data.mjs: ${message}`);
  console.error(
    [
      "usage:",
      "  pnpm data:push -- --snapshot <partition> [--no-upload] [--yes]",
      "  pnpm data:pull -- --snapshot <partition> [--date D] [--with-files] [--yes]",
      "  pnpm data:pull -- --dump latest|<date>|eval-frozen-<n> [--yes]",
      "  pnpm data:status",
    ].join("\n"),
  );
  process.exit(2);
}

function uv(uvArgs) {
  if (dryRun) {
    console.log(["uv", ...uvArgs].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "));
    return 0;
  }
  // No shell: arguments reach uv exactly as typed (on Windows too, where uv is uv.exe on PATH).
  const result = spawnSync("uv", uvArgs, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(
      result.error.code === "ENOENT"
        ? "uv not found on PATH: install it (docs/engineering/local-setup.md)"
        : String(result.error),
    );
    return 1;
  }
  return result.status ?? 1;
}

let code;
switch (command) {
  case "push":
    if (!has("--snapshot")) usage("data:push needs --snapshot <partition> (dumps: pnpm data:dump)");
    code = uv([...COLLECTOR, "push", ...args]);
    break;
  case "pull":
    if (has("--snapshot") && has("--dump")) usage("pass --snapshot or --dump, not both");
    if (has("--snapshot")) code = uv([...COLLECTOR, "pull", ...args]);
    else if (has("--dump")) code = uv([...AI, "-m", "caseguard_ai.ingest.pull", ...args]);
    else usage("data:pull needs --snapshot <partition> or --dump <which>");
    break;
  case "dump":
    code = uv([...AI, "-m", "caseguard_ai.ingest.dump", ...args]);
    break;
  case "status": {
    const repo = uv([...COLLECTOR, "status", ...args]);
    const loaded = uv([...AI, "-c", LOADED_CORPUS]);
    code = repo || loaded;
    break;
  }
  default:
    usage(command ? `unknown command ${command}` : "no command");
}
process.exit(code);
