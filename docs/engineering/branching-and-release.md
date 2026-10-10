# Branching, review and release

This is the source-control model for the CaseGuard monorepo. It is a simplified Git Flow: one integration branch (`staging`) and one release branch (`main`).

```
 main      ●──────────────────────●───────────────●──────►   (releases only, tagged vX.Y.Z)
            \                    ↗ release PR      ↑ hotfix PR
 staging     ●──●──────●───●────●──────────●───────●──────►   (integration, always deployable to the staging env)
                 \    ↗     \  ↗            ↖ sync PR (main → staging after hotfix)
 feature/*        ●──●       ●●
```

## 1. Long-lived branches

| Branch | Purpose | Who merges | How | Protection |
|---|---|---|---|---|
| `main` | Released, demo-ready code. Every commit on `main` is a tagged release. | Release PR from `staging`, or a `hotfix/*` PR | **Merge commit** (keeps release history) | PR required, ≥1 approval, all CI checks green, no direct push, no force push, no deletion, conversation resolution required |
| `staging` | Integration branch. All feature work lands here first and auto-deploys to the staging environment (once one exists). | Feature PRs | **Squash merge** (one commit per PR, titled with a Conventional Commit) | PR required, ≥1 approval, all CI checks green, branch up to date before merge, no direct push, no force push |

No one commits directly to `main` or `staging`, including admins. Protection is applied by [`scripts/setup-branch-protection.sh`](../../scripts/setup-branch-protection.sh).

## 2. Short-lived branches

Create these from `staging` (except `hotfix/*`), and keep them short: aim to merge within 2–4 days. Split big features behind a flag or into stacked PRs rather than keeping a long-running branch.

| Prefix | Use | Branch from | Merge into |
|---|---|---|---|
| `feature/` | New functionality | `staging` | `staging` |
| `fix/` | Bug fix found on `staging` | `staging` | `staging` |
| `chore/` | Tooling, deps, CI, config | `staging` | `staging` |
| `docs/` | Documentation only | `staging` | `staging` |
| `refactor/` | Behaviour-preserving change | `staging` | `staging` |
| `test/` | Tests only | `staging` | `staging` |
| `hotfix/` | Urgent fix to a release | `main` | `main`, then sync `main → staging` |
| `release/` *(optional)* | Stabilise a release candidate when `staging` must keep moving | `staging` | `main` |

**Naming:** `<prefix>/<area>-<short-description>`, lowercase and kebab-case. Add the issue number when there is one.

```
feature/web-research-hub
feature/ai-citation-existence-check
fix/api-refresh-token-expiry
chore/infra-compose-pgvector
feature/42-collector-scp-probe
```

**Areas** (also used as commit scopes and CI path filters): `web`, `api`, `ai`, `collector`, `contracts`, `infra`, `docs`, `eval`.

## 3. Daily workflow

```bash
git switch staging && git pull
git switch -c feature/ai-rrf-fusion
# ... commit in small steps (Conventional Commits) ...
git fetch origin && git rebase origin/staging        # keep up to date; never merge staging into your branch
git push -u origin feature/ai-rrf-fusion
# open PR → base: staging, fill the template, request review
```

- Rebase your *own* branch freely. Never rebase or force-push a shared branch.
- Once the PR is squash-merged, the branch is deleted automatically.

## 4. Commits and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/). The **PR title** becomes the squash commit on `staging`, so CI enforces the format on PR titles.

```
<type>(<area>): <imperative summary>

feat(ai): add reciprocal rank fusion to hybrid retriever
fix(api): reject uploads above 25 MB before buffering
docs(prd): resolve TBD-13 review window
chore(infra): pin pgvector image to pg17
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`. A breaking contract change adds `!` (for example `feat(contracts)!: …`) and needs approval from both the producing and the consuming streams.

## 5. Pull request rules

- **Base:** `staging`. Only release PRs and hotfixes target `main`.
- **Size:** aim for under ~400 changed lines (excluding generated files and lockfiles).
- **Template:** fill every section of [the PR template](../../.github/PULL_REQUEST_TEMPLATE.md), including the PRD requirement IDs the PR implements.
- **Review:** at least one approval from a teammate who did not write the code. A PR that touches `packages/contracts` needs a reviewer from each stream that consumes the changed contract.
- **CI must pass:** lint, type-check, tests and build for the changed areas, PR-title lint, and secret scan.
- **Definition of done:** the acceptance criteria of the referenced requirements pass, tests are added, docs are updated, and there are no TODOs without an issue link.

## 6. Releases

Versioning follows [SemVer](https://semver.org/). Milestones map to minor versions: M1 → `v0.1.0`, M2 → `v0.2.0`, M3 → `v0.3.0` (December demo), and the final submission → `v1.0.0`.

1. Freeze `staging` (announce in the team channel) and make sure the staging environment passes the demo script.
2. Update `CHANGELOG.md` under the new version (a `docs/` PR into `staging`).
3. Open a PR **`staging → main`** titled `release: vX.Y.Z`. The body is the changelog section.
4. After approval, merge with a **merge commit**, then tag it:
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```
5. Create the GitHub Release from the tag.

## 7. Hotfixes

1. `git switch main && git pull && git switch -c hotfix/<area>-<desc>`
2. Fix, then open a PR to `main` titled `fix(<area>): …`. Merge it, then tag a patch release `vX.Y.(Z+1)`.
3. Immediately open a **sync PR `main → staging`** so the fix isn't lost.

## 8. Repository settings

These are applied by the setup script, or set them by hand in GitHub → Settings:

- Default branch: **`staging`**, so PRs target it by default. `main` holds releases.
- Allow squash merge **and** merge commits. Disable rebase merge.
- Squash commit message: PR title + description.
- Automatically delete head branches after merge.
- Dependabot alerts and security updates on. Secret scanning and push protection on.
