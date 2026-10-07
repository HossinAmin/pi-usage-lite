/**
 * Usage Extension
 *
 * Shows provider usage/quota in the footer. Currently supports Kimi for
 * Coding (5-hour + weekly quotas), OpenAI Codex (its available rate-limit
 * windows), Claude Code Bridge (Claude plan windows), and OpenCode Zen credits.
 * The status only appears while the active
 * model belongs to a supported provider. `/usage-all` shows quota information
 * for every supported plan currently connected to pi.
 *
 * Updates after every prompt completion (agent_settled) and every 60s.
 *
 * To add more providers later, push another entry into USAGE_PROVIDERS.
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "usage";
const REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "?";
	if (ms <= 0) return "now";
	const m = Math.floor(ms / 60000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24}h`;
}

function fmtCountdown(resetIso: string): string {
	return fmtDuration(new Date(resetIso).getTime() - Date.now());
}

// ---------------------------------------------------------------------------
// Provider handlers
// ---------------------------------------------------------------------------

interface UsageProvider {
	/** Provider id used to resolve authentication. */
	providerId: string;
	/** Short label shown in the footer and command output. */
	label: string;
	/** Return true if this handler serves the given provider id. */
	matches(provider: string): boolean;
	/** Optional custom connection check for providers with extra credentials. */
	connected?(ctx: ExtensionContext): Promise<boolean>;
	/** Fetch and format the usage text, or undefined on failure. */
	fetch(ctx: ExtensionContext): Promise<string | undefined>;
}

async function isConnected(handler: UsageProvider, ctx: ExtensionContext): Promise<boolean> {
	if (handler.connected) return handler.connected(ctx);
	const result = await ctx.modelRegistry.getProviderAuth(handler.providerId);
	if (result?.auth?.apiKey) return true;
	return Object.keys(result?.auth?.headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

interface KimiQuotaDetail {
	limit?: string;
	used?: string;
	remaining?: string;
	resetTime?: string;
}

interface KimiUsagesResponse {
	usage?: KimiQuotaDetail; // weekly quota
	limits?: Array<{
		window?: { duration?: number; timeUnit?: string };
		detail?: KimiQuotaDetail; // session (5-hour) window
	}>;
}

const kimiCoding: UsageProvider = {
	providerId: "kimi-coding",
	label: "kimi",
	matches: (provider) => /kimi/i.test(provider),
	async fetch(ctx) {
		const result = await ctx.modelRegistry.getProviderAuth("kimi-coding");
		const apiKey = result?.auth?.apiKey;
		const authHeaders = result?.auth?.headers ?? {};
		const hasAuthorization = Object.keys(authHeaders).some((key) => key.toLowerCase() === "authorization");
		if (!apiKey && !hasAuthorization) return undefined;

		const base = (result?.auth?.baseUrl ?? "https://api.kimi.com/coding").replace(/\/+$/, "");
		const res = await fetch(`${base}/v1/usages`, {
			headers: {
				"User-Agent": "KimiCLI/1.5",
				...authHeaders,
				// OAuth providers (including Kimi) supply Authorization in authHeaders.
				// API-key providers use the fallback below.
				...(hasAuthorization || !apiKey ? {} : { Authorization: `Bearer ${apiKey}` }),
			},
		});
		if (!res.ok) return undefined;

		const data = (await res.json()) as KimiUsagesResponse;
		const session = data.limits?.[0]?.detail; // 5-hour session window
		const weekly = data.usage; // weekly quota

		const parts: string[] = [];
		if (session?.used != null && session?.limit != null) {
			parts.push(`5h ${session.used}/${session.limit} ↻${fmtCountdown(session.resetTime ?? "")}`);
		}
		if (weekly?.used != null && weekly?.limit != null) {
			parts.push(`wk ${weekly.used}/${weekly.limit} ↻${fmtCountdown(weekly.resetTime ?? "")}`);
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	},
};

interface CodexUsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface CodexUsageResponse {
	rate_limit?: {
		primary_window?: CodexUsageWindow | null;
		secondary_window?: CodexUsageWindow | null;
	};
}

function codexWindowLabel(seconds?: number): string {
	if (seconds == null) return "limit";
	if (seconds >= 6 * 24 * 60 * 60) return "wk";
	if (seconds >= 20 * 60 * 60 && seconds <= 28 * 60 * 60) return "day";
	if (seconds >= 4 * 60 * 60 && seconds <= 6 * 60 * 60) return "5h";
	const hours = Math.round(seconds / 3600);
	return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

function progressBar(percent: number, width = 8): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatCodexWindow(window: CodexUsageWindow | null | undefined): string | undefined {
	if (typeof window?.used_percent !== "number") return undefined;
	const reset = typeof window.reset_after_seconds === "number"
		? fmtDuration(window.reset_after_seconds * 1000)
		: typeof window.reset_at === "number"
			? fmtDuration(window.reset_at * 1000 - Date.now())
			: "?";
	const percent = Math.round(window.used_percent);
	return `${codexWindowLabel(window.limit_window_seconds)} ${progressBar(percent)} ${percent}% ↻${reset}`;
}

function codexAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
		};
		const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

const openaiCodex: UsageProvider = {
	providerId: "openai-codex",
	label: "codex",
	matches: (provider) => provider === "openai-codex",
	async fetch(ctx) {
		const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
		const token = result?.auth?.apiKey;
		const accountId = token ? codexAccountId(token) : undefined;
		if (!token || !accountId) return undefined;

		const base = (result.auth.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
		const res = await fetch(`${base}/wham/usage`, {
			headers: {
				...result.auth.headers,
				Authorization: `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": "pi",
			},
		});
		if (!res.ok) return undefined;

		const data = (await res.json()) as CodexUsageResponse;
		const parts = [
			formatCodexWindow(data.rate_limit?.primary_window),
			formatCodexWindow(data.rate_limit?.secondary_window),
		].filter((part): part is string => part !== undefined);
		return parts.length > 0 ? parts.join(" · ") : undefined;
	},
};

interface ClaudeCodeCredentials {
	claudeAiOauth?: { accessToken?: string };
}

interface ClaudeUsageWindow {
	utilization?: number;
	resets_at?: string | null;
}

interface ClaudeUsageResponse {
	five_hour?: ClaudeUsageWindow | null;
	seven_day?: ClaudeUsageWindow | null;
	seven_day_opus?: ClaudeUsageWindow | null;
	seven_day_sonnet?: ClaudeUsageWindow | null;
	extra_usage?: {
		is_enabled?: boolean;
		used_credits?: number | null;
		monthly_limit?: number | null;
		currency?: string | null;
	};
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CACHE_MS = 5 * 60_000;
let claudeUsageCache: { fetchedAt: number; data: ClaudeUsageResponse } | undefined;

function claudeCredentialsPath(): string {
	const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	return join(configDir, ".credentials.json");
}

async function loadClaudeAccessToken(): Promise<string | undefined> {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	try {
		const credentials = JSON.parse(await readFile(claudeCredentialsPath(), "utf8")) as ClaudeCodeCredentials;
		return credentials.claudeAiOauth?.accessToken;
	} catch {
		return undefined;
	}
}

function formatClaudeWindow(label: string, window: ClaudeUsageWindow | null | undefined): string | undefined {
	if (typeof window?.utilization !== "number") return undefined;
	const percent = Math.round(window.utilization);
	const reset = window.resets_at ? fmtCountdown(window.resets_at) : "?";
	return `${label} ${progressBar(percent)} ${percent}% ↻${reset}`;
}

function formatClaudeUsage(data: ClaudeUsageResponse): string | undefined {
	const parts = [
		formatClaudeWindow("5h", data.five_hour),
		formatClaudeWindow("wk", data.seven_day),
		formatClaudeWindow("opus", data.seven_day_opus),
		formatClaudeWindow("sonnet", data.seven_day_sonnet),
	].filter((part): part is string => part !== undefined);

	if (data.extra_usage?.is_enabled) {
		const used = data.extra_usage.used_credits;
		const limit = data.extra_usage.monthly_limit;
		const currency = data.extra_usage.currency ?? "USD";
		parts.push(
			typeof used === "number" && typeof limit === "number"
				? `extra ${used.toFixed(2)}/${limit.toFixed(2)} ${currency}`
				: "extra enabled",
		);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

const claudeCodeBridge: UsageProvider = {
	// Claude Code owns authentication; claude-bridge does not expose it through
	// pi's model registry.
	providerId: "claude-bridge",
	label: "claude",
	matches: (provider) => provider === "claude-bridge",
	async connected() {
		return Boolean(await loadClaudeAccessToken());
	},
	async fetch() {
		if (claudeUsageCache && Date.now() - claudeUsageCache.fetchedAt < CLAUDE_CACHE_MS) {
			return formatClaudeUsage(claudeUsageCache.data);
		}

		const token = await loadClaudeAccessToken();
		if (!token) return undefined;
		const res = await fetch(CLAUDE_USAGE_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "claude-code/usage-extension",
			},
		});
		if (!res.ok) return claudeUsageCache ? formatClaudeUsage(claudeUsageCache.data) : undefined;

		const data = (await res.json()) as ClaudeUsageResponse;
		claudeUsageCache = { fetchedAt: Date.now(), data };
		return formatClaudeUsage(data);
	},
};

interface ZenDashboardConfig {
	workspaceId: string;
	authCookie: string;
	serverId?: string;
	serverInstance?: string;
}

interface ZenCreditsResponse {
	data?: {
		total_credits?: number;
		used_credits?: number;
		remaining_credits?: number;
	};
}

const ZEN_CONFIG_PATH = join(getAgentDir(), "usage-zen.json");
const ZEN_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const ZEN_SERVER_INSTANCE = "server-fn:2";
const ZEN_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
let zenCreditsApiSupported: boolean | undefined;

async function loadZenConfig(): Promise<ZenDashboardConfig | undefined> {
	const envWorkspace = process.env.OPENCODE_ZEN_WORKSPACE_ID;
	const envCookie = process.env.OPENCODE_ZEN_AUTH_COOKIE;
	if (envWorkspace && envCookie) return { workspaceId: envWorkspace, authCookie: envCookie };
	try {
		const config = JSON.parse(await readFile(ZEN_CONFIG_PATH, "utf8")) as Partial<ZenDashboardConfig>;
		if (typeof config.workspaceId !== "string" || typeof config.authCookie !== "string") return undefined;
		return config as ZenDashboardConfig;
	} catch {
		return undefined;
	}
}

function zenCookieHeader(cookie: string): string {
	return cookie.trim().startsWith("auth=") ? cookie.trim() : `auth=${cookie.trim()}`;
}

function microCentsToDollars(value: number): number {
	return value / 100_000_000;
}

function parseZenDashboardResponse(body: string): string | undefined {
	const balance = body.match(/\bbalance:\s*(-?\d+)/)?.[1];
	if (balance == null) return undefined;
	const parts = [`balance $${microCentsToDollars(Number(balance)).toFixed(2)}`];
	const monthlyUsage = body.match(/\bmonthlyUsage:\s*(-?\d+)/)?.[1];
	if (monthlyUsage != null) parts.push(`mo $${microCentsToDollars(Number(monthlyUsage)).toFixed(2)}`);
	const reload = body.match(/\breload:\s*(true|false|null)/)?.[1];
	const reloadAmount = body.match(/\breloadAmount:\s*(\d+(?:\.\d+)?)/)?.[1];
	const reloadTrigger = body.match(/\breloadTrigger:\s*(\d+(?:\.\d+)?)/)?.[1];
	if (reload === "true" && reloadAmount && reloadTrigger) {
		parts.push(`auto $${reloadAmount} @ $${reloadTrigger}`);
	}
	return parts.join(" · ");
}

async function fetchZenDashboard(config: ZenDashboardConfig): Promise<string | undefined> {
	const serverId = config.serverId ?? ZEN_SERVER_ID;
	const serverInstance = config.serverInstance ?? ZEN_SERVER_INSTANCE;
	const args = JSON.stringify({
		t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: config.workspaceId }], o: 0 },
		f: 31,
		m: [],
	});
	const headers = {
		Accept: "*/*",
		Cookie: zenCookieHeader(config.authCookie),
		Referer: `https://opencode.ai/workspace/${config.workspaceId}`,
		"User-Agent": ZEN_USER_AGENT,
		"x-server-id": serverId,
		"x-server-instance": serverInstance,
	};

	const endpoint = new URL("https://opencode.ai/_server");
	endpoint.searchParams.set("id", serverId);
	endpoint.searchParams.set("args", args);
	const direct = await fetch(endpoint, { headers });
	if (direct.ok) {
		const usage = parseZenDashboardResponse(await direct.text());
		if (usage) return usage;
	}

	// The server-function hash can change after a Zen deployment. The workspace
	// page is slower but exposes the same billing object in its SSR hydration.
	const page = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(config.workspaceId)}`, {
		headers: {
			Accept: "text/html",
			Cookie: zenCookieHeader(config.authCookie),
			"User-Agent": ZEN_USER_AGENT,
		},
	});
	return page.ok ? parseZenDashboardResponse(await page.text()) : undefined;
}

async function fetchZenCreditsApi(ctx: ExtensionContext): Promise<string | undefined> {
	if (zenCreditsApiSupported === false) return undefined;
	const result = await ctx.modelRegistry.getProviderAuth("opencode");
	const apiKey = result?.auth?.apiKey;
	if (!apiKey) return undefined;
	const res = await fetch("https://api.opencode.ai/v1/credits", {
		headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) return undefined;
	if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
		zenCreditsApiSupported = false;
		return undefined;
	}
	zenCreditsApiSupported = true;
	const data = ((await res.json()) as ZenCreditsResponse).data;
	if (typeof data?.total_credits !== "number" || typeof data.used_credits !== "number") return undefined;
	const total = data.total_credits;
	const used = data.used_credits;
	const remaining = typeof data.remaining_credits === "number" ? data.remaining_credits : total - used;
	const percent = total > 0 ? Math.round((used / total) * 100) : 0;
	return `${remaining.toFixed(2)}/${total.toFixed(2)} credits · ${progressBar(percent)} ${percent}%`;
}

const openCodeZen: UsageProvider = {
	providerId: "opencode",
	label: "zen",
	matches: (provider) => provider === "opencode",
	async connected(ctx) {
		if (await loadZenConfig()) return true;
		const result = await ctx.modelRegistry.getProviderAuth("opencode");
		return Boolean(result?.auth?.apiKey);
	},
	async fetch(ctx) {
		const official = await fetchZenCreditsApi(ctx);
		if (official) return official;
		const config = await loadZenConfig();
		return config ? fetchZenDashboard(config) : undefined;
	},
};

// Add more provider handlers here later.
const USAGE_PROVIDERS: UsageProvider[] = [kimiCoding, openaiCodex, claudeCodeBridge, openCodeZen];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let visible = false;
	const succeededProviders = new Set<string>();

	function handlerFor(ctx: ExtensionContext): UsageProvider | undefined {
		const provider = ctx.model?.provider;
		if (!provider) return undefined;
		return USAGE_PROVIDERS.find((p) => p.matches(provider));
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		const handler = handlerFor(ctx);
		if (!handler) {
			if (visible) {
				ctx.ui.setStatus(STATUS_ID, undefined);
				visible = false;
			}
			return;
		}

		try {
			const text = await handler.fetch(ctx);
			const model = ctx.model?.id ?? "";
			const provider = ctx.model?.provider ?? "";
			if (text) {
				ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${handler.label} ${model} · ${text}`));
				succeededProviders.add(provider);
			} else if (!succeededProviders.has(provider)) {
				// Never fetched successfully for this provider: show that the extension is alive.
				ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${handler.label} ${model} · usage n/a`));
			}
			// On later failures: keep the last known values on screen.
			visible = true;
		} catch {
			// Network/auth errors: keep the last known values on screen.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
		// Keep values and renewal countdowns fresh.
		timer = setInterval(() => {
			void refresh(ctx);
		}, REFRESH_MS);
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	// Refresh after every prompt completes.
	pi.on("agent_settled", async (_event, ctx) => {
		await refresh(ctx);
	});

	// Show/hide when the active model changes.
	pi.on("model_select", async (_event, ctx) => {
		await refresh(ctx);
	});

	// Manual refresh: /usage
	pi.registerCommand("usage", {
		description: "Refresh the usage display in the footer",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			ctx.ui.notify("Usage refreshed", "info");
		},
	});

	pi.registerCommand("usage-all", {
		description: "Show credits for all connected plans",
		handler: async (_args, ctx) => {
			const results = await Promise.all(
				USAGE_PROVIDERS.map(async (handler) => {
					try {
						if (!(await isConnected(handler, ctx))) return undefined;
						const usage = await handler.fetch(ctx);
						return `${handler.label}: ${usage ?? "usage unavailable"}`;
					} catch {
						return `${handler.label}: usage unavailable`;
					}
				}),
			);
			const connected = results.filter((result): result is string => result !== undefined);
			if (connected.length === 0) {
				ctx.ui.notify("No supported usage plans are connected", "warning");
				return;
			}
			ctx.ui.notify(connected.join("\n"), "info");
		},
	});
}
