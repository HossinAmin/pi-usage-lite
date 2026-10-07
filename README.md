# pi-usage-lite

A minimal, dependency-free [Pi Coding Agent](https://pi.dev) extension that keeps selected provider usage and quota information visible in the footer.

The extension is intentionally small: one TypeScript file, no runtime npm dependencies, automatic footer refreshes, and two commands.

> **Status:** early release. Some provider usage endpoints are undocumented and may change without notice.

## Features

- Shows usage in Pi's footer for the active model provider.
- Refreshes when a session starts, when the model changes, after each agent run, and every 60 seconds.
- Keeps the last known values visible when a later refresh fails.
- Provides `/usage` to refresh the active provider.
- Provides `/usage-all` to show usage for every supported provider currently connected to Pi.

## Supported providers

| Provider | Information shown |
| --- | --- |
| Kimi for Coding | Five-hour and weekly plan windows |
| OpenAI Codex | Available rate-limit windows and reset times |
| Claude Code Bridge | Five-hour, weekly, Opus, Sonnet, and extra-usage information when available |
| OpenCode Zen | Credits through the official credits API, with an optional dashboard fallback |

Provider data is shown only when Pi has compatible credentials configured.

## Install

Install a GitHub release tag. Pinning a release prevents later changes on `main` or `dev` from affecting your installation unexpectedly:

```bash
pi install git:github.com/HossinAmin/pi-usage-lite@v0.1.0
```

Check [GitHub Releases](https://github.com/HossinAmin/pi-usage-lite/releases) for the newest tag, then restart Pi or run:

```text
/reload
```

To try a release without installing it permanently:

```bash
pi -e git:github.com/HossinAmin/pi-usage-lite@v0.1.0
```

For local development:

```bash
git clone git@github.com:HossinAmin/pi-usage-lite.git
cd pi-usage-lite
pi -e .
```

## Commands

### `/usage`

Refreshes the footer entry for the currently selected model's provider.

### `/usage-all`

Checks every supported provider that appears connected and displays the available usage information in a notification.

## OpenCode Zen dashboard fallback

The extension first tries OpenCode's official credits API using Pi's configured `opencode` provider credentials.

If that API is unavailable, it can use an optional dashboard configuration. Create this file only if you need the fallback:

```text
~/.pi/agent/usage-zen.json
```

Example shape:

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-open-code-auth-cookie"
}
```

The `authCookie` is a sensitive credential. Keep the file private:

```bash
chmod 600 ~/.pi/agent/usage-zen.json
```

Do not commit this file. It is listed in this repository's `.gitignore` in case it is accidentally copied into a checkout.

You can also provide the fallback configuration through environment variables:

```bash
export OPENCODE_ZEN_WORKSPACE_ID="your-workspace-id"
export OPENCODE_ZEN_AUTH_COOKIE="your-open-code-auth-cookie"
```

## Security and privacy

- This repository does not contain provider API keys, OAuth tokens, cookies, or workspace credentials.
- At runtime, the extension reads credentials from Pi's provider authentication, supported environment variables, or the optional local configuration files described above.
- Credentials are used only to request usage information from their corresponding provider endpoints.
- Like every Pi extension, this extension runs with your operating-system user permissions. Review the source before installing it.
- The OpenCode dashboard fallback relies on web-session cookies and undocumented page/server behavior. It is more fragile than the official credits API and may stop working after an OpenCode deployment.

## Compatibility notes

- The extension registers `/usage`. Do not load it alongside another extension that registers the same command.
- Usage endpoints and response formats are provider-controlled and may change.
- The footer displays the last successful value if a refresh fails, so values can be stale until the next successful refresh.
- This project is not affiliated with Pi, OpenAI, Anthropic, Moonshot AI, Kimi, or OpenCode.

## Release workflow

Development happens on the `dev` branch or feature branches. Releases are created from `main`.

1. Make changes on `dev` or a feature branch.
2. Bump `package.json` before opening a pull request into `main`:

   ```bash
   npm version patch --no-git-tag-version
   ```

   Use `minor` or `major` instead of `patch` when appropriate.

3. Merge the pull request into `main`.
4. The [`Release`](./.github/workflows/release.yml) workflow validates the version, creates the matching `vX.Y.Z` tag, and publishes a GitHub Release with generated notes.

The [`Version check`](./.github/workflows/version-check.yml) workflow blocks pull requests into `main` when `package.json` still has the base branch's version. This keeps every merge into `main` releasable.

Users should install release tags such as `@v0.1.0`, not the moving `main` or `dev` branches.

## Development

The extension source is [`src/index.ts`](./src/index.ts).

Useful local commands:

```bash
# Try the package locally
pi -e .

# Inspect the extension source
${EDITOR:-nano} src/index.ts
```

There is no build step; Pi loads the TypeScript source through Jiti.

## License

[MIT](./LICENSE)
