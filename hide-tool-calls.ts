import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// Quiet tools — 4 display levels for tool rows, cycled with ctrl+shift+o
// (or /quiet-tools), like a 4-way version of the thinking toggle:
//
//   name       one dim line per tool call: just the tool name   (2 rows tall)
//   none       nothing at all                                   (1 blank row — the
//              host reserves one spacer line per tool call; that is the floor)
//   collapsed  the tool's own default view (call + truncated output)
//   full       always-expanded output (ctrl+o still works in collapsed)
//
// Errors stay visible at every level: one compact red line, so a failure can
// never scroll past unnoticed.
//
// How it works: the renderer returns stateful components that re-evaluate the
// current level on every TUI frame, so switching levels repaints existing rows
// immediately. Delegated levels ("collapsed"/"full") call the tool's own
// renderers, so built-in and custom tools keep their native rendering.
//
// The level lives in a globalThis slot, so it survives /reload and applies to
// rows created by earlier extension instances too.
//
// Components implement render() AND invalidate(): the host wraps every
// renderer component in a MouseRegion, whose invalidate() calls through to the
// child unconditionally — a missing invalidate() crashes /reload.
//
// Tools in EXEMPT render exactly as their own renderers draw them (the
// subagent progress cards are the dashboard for background work).

type QuietMode = "name" | "none" | "collapsed" | "full";

const MODES: QuietMode[] = ["name", "none", "collapsed", "full"];
const DEFAULT_MODE: QuietMode = "name";
const EXEMPT_TOOLS = new Set(["subagent"]);
const INDENT = " ";
const MODE_KEY = "__piQuietToolsMode";

function getMode(): QuietMode {
	const value = (globalThis as any)[MODE_KEY];
	return MODES.includes(value) ? value : DEFAULT_MODE;
}

function setMode(next: QuietMode): void {
	(globalThis as any)[MODE_KEY] = next;
}

function cycleMode(): QuietMode {
	const next = MODES[(MODES.indexOf(getMode()) + 1) % MODES.length];
	setMode(next);
	return next;
}

// Minimal structural types (the real ones aren't all exported from the root).
interface ThemeLike {
	fg(color: string, text: string): string;
}
interface RendererContext {
	args: any;
	toolCallId: string;
	[key: string]: any;
}
interface BaseRenderers {
	renderCall?: (args: any, theme: ThemeLike, context: RendererContext) => any;
	renderResult?: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: RendererContext) => any;
}
/** A TUI component: re-evaluated on every frame. */
interface QuietPart {
	render(width: number): string[];
	invalidate(): void;
}

function textOf(result: any): string {
	return (result?.content ?? [])
		.filter((part: any): part is { type: "text"; text: string } => part.type === "text")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function errorLine(toolName: string, result: any, isError: boolean, theme: ThemeLike): string[] {
	if (!isError) return [];
	const first = (textOf(result).split("\n")[0] ?? "tool error").slice(0, 160);
	return [theme.fg("error", `${INDENT}✗ ${toolName}: ${first}`)];
}

function indent(lines: string[]): string[] {
	return lines.map((line) => INDENT + line);
}

// The TUI crashes if any rendered line exceeds the terminal width, and with
// renderShell:"self" clipping is entirely the renderer's job. Every line this
// extension emits goes through here.
function clip(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width));
}

function basename(p: any): string {
	const s = String(p ?? "").replace(/[\\/]+$/, "");
	const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
	return i === -1 ? s : s.slice(i + 1);
}

function firstLine(s: any, max: number): string {
	const line = String(s ?? "").split("\n")[0].trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function verbLabel(verb: string, name: string): string {
	return name ? `${verb} ${name}...` : `${verb}...`;
}

// One-line labels for the "name" level. Unknown tools fall back to the bare
// tool name. Edit freely — this map is the whole feature.
const ARG_LABELS: Record<string, (args: any) => string> = {
	read: (a) => verbLabel("Reading", basename(a?.file_path ?? a?.path)),
	edit: (a) => verbLabel("Editing", basename(a?.file_path ?? a?.path)),
	write: (a) => verbLabel("Writing", basename(a?.file_path ?? a?.path)),
	bash: (a) => `Running ${firstLine(a?.command, 48)}`,
	powershell: (a) => `Running ${firstLine(a?.command, 48)}`,
	grep: (a) => `Searching ${firstLine(a?.pattern, 32)}`,
	find: (a) => `Finding ${firstLine(a?.pattern, 32)}`,
	ls: (a) => {
		const name = basename(a?.path ?? ".");
		return name && name !== "." ? `Listing ${name}` : "Listing";
	},
}

/**
 * Stateful per-slot component. The host caches whatever component the renderer
 * returned and calls render() on every frame, so the current level is read at
 * paint time — that is what makes live level switching work.
 */
function createQuietPart(toolName: string, slot: "call" | "result", base: BaseRenderers | undefined) {
	let theme: ThemeLike | undefined;
	let args: any; // last host-provided call arguments (renderCall's first parameter)
	let ctx: RendererContext | undefined; // last host-provided context (cwd, isError, ...)
	let options: { expanded: boolean; isPartial: boolean } | undefined;
	let result: any;
	let delegated: any; // component produced by the tool's own renderer
	let delegatedKey = "";
	// Identity of the inputs delegated was last built from. Between host updates
	// nothing changes, so frames reuse the delegated component's own caches
	// instead of re-running the tool's renderer every frame.
	let builtFrom: { key: string; ctx: RendererContext; options?: object; result?: any } | undefined;

	function delegate(width: number, forceExpanded: boolean): string[] {
		if (!ctx || !theme) return [];
		const level = getMode();
		const effExpanded = forceExpanded || Boolean(options?.expanded);
		const key = `${level}:${effExpanded ? 1 : 0}`;
		const unchanged = builtFrom && builtFrom.key === key && builtFrom.ctx === ctx && builtFrom.options === options && builtFrom.result === result;
		const effCtx: RendererContext = forceExpanded ? { ...ctx, expanded: true } : ctx;
		try {
			if (!unchanged) {
			if (slot === "call") {
				if (!base?.renderCall) {
					if (key !== delegatedKey) {
						const callArgs = args ?? ctx.args;
						const argsPreview = callArgs ? JSON.stringify(callArgs).slice(0, 100) : "";
							delegated = { render: () => [`${theme!.fg("dim", toolName)} ${theme!.fg("toolOutput", argsPreview)}`.trimEnd()] };
							delegatedKey = key;
						}
					} else {
						delegated = base.renderCall(args ?? ctx.args, theme, { ...effCtx, lastComponent: delegated });
						delegatedKey = key;
					}
				} else {
					if (!base?.renderResult) {
						if (key !== delegatedKey) {
							const lines = textOf(result).split("\n").slice(-20);
							const color = ctx.isError ? "error" : "toolOutput";
							delegated = { render: () => (lines.length ? lines.map((line) => theme!.fg(color, line)) : []) };
							delegatedKey = key;
						}
					} else {
						delegated = base.renderResult(result, { expanded: effExpanded, isPartial: Boolean(options?.isPartial) }, theme, { ...effCtx, lastComponent: delegated });
						delegatedKey = key;
					}
				}
				builtFrom = { key, ctx, options, result };
			}
		} catch {
			return clip(errorLine(toolName, result, Boolean(ctx?.isError), theme!), width);
		}
		try {
			return clip(indent(delegated.render(Math.max(1, width - INDENT.length)) ?? []), width);
		} catch {
			return [];
		}
	}

	const part = {
		__quietToolPart: true as const,
		render(width: number): string[] {
			if (!theme) return [];
			const level = getMode();
			if (slot === "call") {
				if (level === "name") {
					const describe = ARG_LABELS[toolName];
					const text = describe ? describe(args ?? ctx?.args) : toolName;
					return clip([theme.fg("dim", `${INDENT}${text}`)], width);
				}
				if (level === "none") return [];
				return delegate(width, level === "full");
			}
			// result slot: failures stay visible at the quiet levels
			if (level === "name" || level === "none") {
				return clip(errorLine(toolName, result, Boolean(ctx?.isError), theme), width);
			}
			return delegate(width, level === "full");
		},
		// The host (MouseRegion) calls this unconditionally; dropping stale
		// delegated caches is the correct response to "your render is stale".
		invalidate(): void {
			delegated = undefined;
			delegatedKey = "";
			builtFrom = undefined;
		},
	};

	// Called by the host on every tool-row update; refresh captured state and
	// keep the host's lastComponent reuse pattern intact.
	return (renderArgs: {
		theme: ThemeLike;
		context: RendererContext;
		options?: { expanded: boolean; isPartial: boolean };
		result?: any;
	}): QuietPart => {
		theme = renderArgs.theme;
		args = renderArgs.args;
		ctx = renderArgs.context;
		if (renderArgs.options) options = renderArgs.options;
		if (slot === "result") result = renderArgs.result;
		return part;
	};
}

export default function hideToolCalls(pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next?.();

		// Exempt tools pass through untouched (native shell and all).
		if (EXEMPT_TOOLS.has(toolName)) return base;

		const makeCall = createQuietPart(toolName, "call", base);
		const makeResult = createQuietPart(toolName, "result", base);

		return {
			renderShell: "self" as const,
			renderCall(args: any, theme: any, context: any) {
				return makeCall({ theme, context, args });
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				return makeResult({ theme, context, options, result });
			},
		};
	});

	function announce(ctx: any): void {
		if (ctx?.mode === "tui") ctx.ui.notify(`Tool display: ${getMode()}`);
	}

	pi.registerShortcut("ctrl+shift+o", {
		description: "Cycle tool display level (name / none / collapsed / full)",
		handler: (ctx) => {
			cycleMode();
			announce(ctx);
		},
	});

	pi.registerCommand("quiet-tools", {
		description: "Tool display level: name | none | collapsed | full (no argument cycles)",
		handler: async (args, ctx) => {
			const requested = String(args ?? "").trim().toLowerCase() as QuietMode;
			if (requested && MODES.includes(requested)) setMode(requested);
			else cycleMode();
			announce(ctx);
		},
	});
}
