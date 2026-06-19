import type { AgentToolContext } from "@cline/shared";

const MAX_TOOL_HISTORY_SCOPES = 200;
const POLLING_GUIDANCE_THRESHOLD = 3;
const workspaceMutationRevisionByScope = new Map<string, number>();
const pollingCommandCountsByScope = new Map<
	string,
	Map<
		string,
		{
			count: number;
			revision: number;
			label: string;
		}
	>
>();

function getToolHistoryScopeKey(context: AgentToolContext): string | undefined {
	if (context.runId) {
		return `run:${context.runId}`;
	}
	if (context.sessionId) {
		return `session:${context.sessionId}`;
	}
	return undefined;
}

function getScopeMutationRevision(scope: string | undefined): number {
	if (!scope) {
		return 0;
	}
	return workspaceMutationRevisionByScope.get(scope) ?? 0;
}

function bumpScopeMutationRevisionForScope(scope: string | undefined): void {
	if (!scope) {
		return;
	}
	workspaceMutationRevisionByScope.set(
		scope,
		getScopeMutationRevision(scope) + 1,
	);
}

export function recordWorkspaceMutation(context: AgentToolContext): void {
	bumpScopeMutationRevisionForScope(getToolHistoryScopeKey(context));
}

function getScopedPollingCommandMap(
	scope: string | undefined,
): Map<string, { count: number; revision: number; label: string }> | undefined {
	if (!scope) {
		return undefined;
	}
	let commands = pollingCommandCountsByScope.get(scope);
	if (!commands) {
		if (pollingCommandCountsByScope.size >= MAX_TOOL_HISTORY_SCOPES) {
			const oldestScope = pollingCommandCountsByScope.keys().next().value;
			if (oldestScope) {
				pollingCommandCountsByScope.delete(oldestScope);
				workspaceMutationRevisionByScope.delete(oldestScope);
			}
		}
		commands = new Map();
		pollingCommandCountsByScope.set(scope, commands);
	}
	return commands;
}

export function appendToolGuidance(message: string, guidance: string): string {
	if (!message) {
		return `Tool guidance: ${guidance}`;
	}
	return `${message}\n\nTool guidance: ${guidance}`;
}

function normalizePollingCommand(command: string): string {
	return command
		.replace(/^\s*(?:sleep\s+\d+(?:\.\d+)?\s*(?:&&|;)\s*)+/g, "")
		.replace(/\b(tail|head)\s+-(?:[nc]\s*)?\d+\b/g, "$1 -n <n>")
		.replace(/\bps\s+-p\s+\d+\b/g, "ps -p <pid>")
		.replace(/\bgrep\s+\d{2,}\b/g, "grep <id>")
		.replace(/\b\d{4,}\b/g, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

function getPollingCommandInfo(
	command: string,
): { key: string; label: string } | undefined {
	const normalized = normalizePollingCommand(command);
	const lower = normalized.toLowerCase();

	const tailOrHeadMatch = lower.match(
		/\b(?:tail|head)\s+(?:-n\s+<n>\s+)?([/~.$\w][^\s|;&]*)/,
	);
	if (tailOrHeadMatch?.[1]) {
		return {
			key: `log-read:${tailOrHeadMatch[1]}`,
			label: `log reads of ${tailOrHeadMatch[1]}`,
		};
	}

	const wcMatch = lower.match(/\bwc\s+-l\s+([/~.$\w-][^\s|;&]*)/);
	if (wcMatch?.[1]) {
		return {
			key: `line-count:${wcMatch[1]}`,
			label: `line counts of ${wcMatch[1]}`,
		};
	}

	const statMatch = lower.match(
		/\bstat\s+-c\s+['"]?%s['"]?\s+([/~.$\w-][^\s|;&]*)/,
	);
	if (statMatch?.[1]) {
		return {
			key: `size-check:${statMatch[1]}`,
			label: `size checks of ${statMatch[1]}`,
		};
	}

	const findCountMatch = lower.match(
		/\bfind\s+([/~.$\w-][^\s|;&]*).*?\|\s*wc\s+-l/,
	);
	if (findCountMatch?.[1]) {
		return {
			key: `file-count:${findCountMatch[1]}`,
			label: `file counts under ${findCountMatch[1]}`,
		};
	}

	if (/\b(?:ps|pgrep)\b/.test(lower)) {
		return {
			key: `process-check:${normalized}`,
			label: "process status checks",
		};
	}

	if (/^sleep\s+\d+(?:\.\d+)?$/.test(lower)) {
		return {
			key: "sleep-only",
			label: "sleep-only waits",
		};
	}

	return undefined;
}

export function getRunCommandPollingGuidance(
	context: AgentToolContext,
	command: string,
): string | undefined {
	const pollingInfo = getPollingCommandInfo(command);
	if (!pollingInfo) {
		return undefined;
	}
	const scope = getToolHistoryScopeKey(context);
	const pollingCommands = getScopedPollingCommandMap(scope);
	if (!pollingCommands) {
		return undefined;
	}
	const revision = getScopeMutationRevision(scope);
	const previous = pollingCommands.get(pollingInfo.key);
	const count = previous?.revision === revision ? previous.count + 1 : 1;
	pollingCommands.set(pollingInfo.key, {
		count,
		revision,
		label: pollingInfo.label,
	});
	if (count < POLLING_GUIDANCE_THRESHOLD) {
		return undefined;
	}
	return (
		`You have repeated similar ${pollingInfo.label} ${count} times. ` +
		"Avoid short polling loops; use a longer wait/read if needed, inspect the relevant output directly, or proceed/submit if there is enough evidence."
	);
}

export function commandLikelyMutatesWorkspace(command: string): boolean {
	return (
		/(?:^|[;&|({]\s*)(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|install)\b/.test(
			command,
		) ||
		/(?:^|[;&|({]\s*)(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|build|test)\b/.test(
			command,
		) ||
		/(?:^|[;&|({]\s*)(?:make|cmake|ninja|cargo|go|python|python3|pip|pip3)\b/.test(
			command,
		) ||
		/>|>>|\btee\b|\bpatch\b|\bapply_patch\b/.test(command)
	);
}
