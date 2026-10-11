# AGENTS.md

## Project overview

`pi-usage-lite` is a single-file Pi Coding Agent extension. The extension entrypoint is `src/index.ts`; there is no runtime build step because Pi loads TypeScript through Jiti.

Keep the package lightweight. Do not add runtime dependencies unless they are essential. Development-only dependencies are allowed for validation.

## Package manager

Use **Bun** for dependency and script management.

```bash
bun install
bun run typecheck
bun pm pack --dry-run
```

Do not commit npm artifacts such as `package-lock.json`. The Bun lockfile is `bun.lock`.

## Git workflow

- Develop on `dev` or a feature branch created from `dev`.
- Do not commit directly on `main`.
- Do not commit or push without explicit user approval.
- Use prefixed commit messages:
  - `feat:` for user-facing features
  - `fix:` for bug fixes
  - `chore:` for maintenance
  - `docs:` for documentation-only changes
  - `test:` for test-only changes
  - `ci:` for workflow/CI changes
  - `refactor:` for behavior-preserving code changes
- Before opening a pull request into `main`, bump `package.json` to a new semver version:

```bash
bun pm pkg set version=<next-version>
```

Merging into `main` triggers the GitHub release workflow, which typechecks the extension and creates the matching `v<version>` tag and GitHub Release.

## Provider display conventions

- Quota-window providers use the shared format: label, progress bar, used percentage, reset countdown.
- Kimi must use progress bars like Codex and Claude, not `used/limit` text.
- OpenCode Zen is credit-based, not quota-based. Keep Zen numeric-only and do not use a progress bar for it.

## Security rules

- Never commit API keys, OAuth tokens, cookies, workspace IDs, or credential files.
- `usage-zen.json`, `.env*`, and credential files must remain ignored.
- Do not log or persist provider credentials.
- Review network requests carefully before adding a provider.

## Validation checklist

Before asking for commit approval, run:

```bash
bun run typecheck
bun pm pack --dry-run
git diff --check
git status --short --branch
```

Report the proposed commit message and wait for approval before committing or pushing.
