# services/collector: legal data collector

**Stream B · Python** · origin: [`CaseGuard-AI/data_collector`](https://github.com/CaseGuard-AI/data_collector)

> Not imported yet. CI skips this service until `pyproject.toml` exists.

## Import with history (first PR: `chore/collector-import`)

```bash
git switch staging && git pull && git switch -c chore/collector-import
git -c core.longpaths=true subtree add --prefix=services/collector \
    https://github.com/CaseGuard-AI/data_collector.git main
```

> **Windows:** enable long paths first (`git config --global core.longpaths true`), because the demo data has very long file names.

Then, in the same PR:

1. Convert `requirements.txt` to `pyproject.toml` + `uv.lock` (`uv init --app && uv add -r requirements.txt`).
2. Point output at the `corpus` schema (`PKLEGAL_DATABASE_URL`, role `caseguard_ai`).
3. Archive the old repository on GitHub with a pointer to this folder.

## P0 work (PRD §15)

- Civil and criminal statute set + amendment acts from Pakistan Code
- SHC judgments filtered to civil and criminal matter types
- SCP `--probe` from the team's network
- Snapshot on content-hash change (temporal record time, PRD §10)
