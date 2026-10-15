// Headless simulation of the ToolExecutionComponent renderer contract against
// the quiet-tools extension. Run: EXT_PATH=... node --experimental-strip-types quiet-tools-smoke.mjs
import { pathToFileURL } from "node:url";

const captured = {};
const fakePi = {
	registerToolRenderer: (resolver) => { captured.resolver = resolver; },
	registerShortcut: (key, opts) => { captured.shortcut = { key, ...opts }; },
	registerCommand: (name, opts) => { captured.command = { name, ...opts }; },
};

await import(pathToFileURL(process.env.EXT_PATH).href).then((m) => m.default(fakePi));

if (!captured.resolver) throw new Error("resolver not registered");
if (captured.shortcut.key !== "ctrl+shift+o") throw new Error("shortcut key wrong: " + captured.shortcut.key);
if (captured.command.name !== "quiet-tools") throw new Error("command missing");

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const theme = { fg: (c, t) => (c === "dim" ? dim(t) : c === "error" ? red(t) : t) };

// fake built-in base renderer (like read's): reuses lastComponent, reads result.content
function makeBaseRenderer() {
	return {
		calls: 0,
		renderCall(args, theme2, context) {
			this.calls++;
			const t = context.lastComponent ?? { text: "" };
			t.text = `read ${args.path}`;
			return { render: () => [t.text] };
		},
		renderResult(result, options, theme2, context) {
			const t = context.lastComponent ?? { text: "" };
			const text = (result.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
			t.text = options.expanded ? `FULL:${text}` : `PREVIEW:${text}`;
			return { render: () => [t.text] };
		},
	};
}

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const mustBeQuietPart = (c) => { ok(c && c.render, "expected stateful part"); return c; };
const ctx = (isError = false, args = { path: "a.ts" }) => ({ args, toolCallId: "t1", lastComponent: undefined, isError, cwd: "/x" });
const notify = (m) => console.log("notify:", m);
const cycle = () => captured.shortcut.handler({ mode: "tui", ui: { notify } });

// ============ ROW 1: read tool, base renderer available ============
const base = makeBaseRenderer();
const renderers = captured.resolver("read", () => base);
ok(renderers.renderShell === "self", "renderShell should be self");

// update 1: call arrives (no result yet); default mode = name
const callPart = mustBeQuietPart(renderers.renderCall({ path: "a.ts" }, theme, ctx()));
let lines = callPart.render(80);
console.log("name/call:", JSON.stringify(lines));
ok(lines.length === 1 && lines[0].includes("Reading a.ts..."), "name call = verb label");
ok(base.calls === 0, "name mode must not delegate");

// frame re-render without host update: stable, still no delegation
callPart.render(80);
ok(base.calls === 0, "frame re-render must not delegate");

// update 2: success result arrives → silent in name mode
const resultPart = mustBeQuietPart(renderers.renderResult({ content: [{ type: "text", text: "hello" }] }, { expanded: false, isPartial: false }, theme, ctx()));
ok(resultPart.render(80).length === 0, "name result silent");

// update 3: row errors → red line visible
renderers.renderResult({ content: [{ type: "text", text: "boom\nline2" }] }, { expanded: false, isPartial: false }, theme, ctx(true));
lines = resultPart.render(80);
console.log("name/error:", JSON.stringify(lines));
ok(lines.length === 1 && lines[0].includes("✗ read: boom"), "error line visible in name mode");

// → none: error still visible
cycle(); // none
ok(callPart.render(80).length === 0, "none call silent");
ok(resultPart.render(80).length === 1 && resultPart.render(80)[0].includes("✗"), "error stays visible in none");

// update 4: retried, success now
renderers.renderResult({ content: [{ type: "text", text: "hello" }] }, { expanded: false, isPartial: false }, theme, ctx());
ok(resultPart.render(80).length === 0, "none silent again after success");

// → collapsed: delegation starts, then cached across frames
cycle(); // collapsed
lines = callPart.render(80);
console.log("collapsed/call:", JSON.stringify(lines));
ok(base.calls === 1, "collapsed delegates call once");
ok(callPart.render(80).length === 1 && base.calls === 1, "second frame reuses delegated component");
lines = resultPart.render(80);
console.log("collapsed/result:", JSON.stringify(lines));
ok(lines[0].includes("PREVIEW:hello"), "collapsed result shows preview");

// ctrl+o: host re-calls renderResult with expanded:true → expansion
renderers.renderResult({ content: [{ type: "text", text: "hello" }] }, { expanded: true, isPartial: false }, theme, ctx());
ok(resultPart.render(80)[0].includes("FULL:hello"), "ctrl+o in collapsed expands");

// → full: forced expansion even without host update
cycle(); // full
ok(resultPart.render(80)[0].includes("FULL:hello"), "full forces expansion");
ok(callPart.render(80).length === 1, "full keeps call line");

// → name again: quiet, then none: silent
cycle(); // name
ok(callPart.render(80).length === 1 && resultPart.render(80).length === 0, "name quiet again");
cycle(); // none
ok(callPart.render(80).length === 0 && resultPart.render(80).length === 0, "none silent");

// ============ ROW 2: same tool, different execution → fresh parts ============
const renderers2 = captured.resolver("read", () => makeBaseRenderer());
const callPart2 = mustBeQuietPart(renderers2.renderCall({ path: "b.ts" }, theme, ctx()));
ok(callPart2 !== callPart, "rows must not share parts");

// ============ exempt tool passthrough ============
const exempt = captured.resolver("subagent", () => ({ renderCall: () => ({ render: () => ["card"] }) }));
ok(exempt && exempt.renderCall && !exempt.renderShell, "exempt tools pass through untouched");

// ============ no base renderer fallback ============
const bare = captured.resolver("mcp/thing", () => ({}));
const bareCall = mustBeQuietPart(bare.renderCall({ q: 1 }, theme, ctx()));
cycle(); cycle(); // none → collapsed
const bareLines = bareCall.render(80);
console.log("fallback/call:", JSON.stringify(bareLines));
ok(bareLines[0].includes("mcp/thing"), "fallback call shows name + args");

// command sets level directly
captured.command.handler("collapsed", { mode: "tui", ui: { notify: () => {} } });
ok(callPart.render(80)[0].includes("read a.ts"), "command-set collapsed delegates");

// ============ verb labels (name level) ============
captured.command.handler("name", { mode: "tui", ui: { notify: () => {} } });
const editCall = mustBeQuietPart(captured.resolver("edit", () => makeBaseRenderer()).renderCall({ path: "/deep/dir/foo.test.ts" }, theme, ctx(false, { path: "/deep/dir/foo.test.ts" })));
ok(editCall.render(80)[0].includes("Editing foo.test.ts..."), "edit label uses basename only");
const bashCall = mustBeQuietPart(captured.resolver("bash", () => makeBaseRenderer()).renderCall({ command: "npm test\nsecond line" }, theme, ctx(false, { command: "npm test\nsecond line" })));
ok(bashCall.render(80)[0].includes("Running npm test") && !bashCall.render(80)[0].includes("second"), "bash label = first line only");
const longCall = mustBeQuietPart(captured.resolver("bash", () => makeBaseRenderer()).renderCall({ command: "y".repeat(60) }, theme, ctx(false, { command: "y".repeat(60) })));
ok(longCall.render(80)[0].includes("..."), "long bash command truncated");
const unknownCall = mustBeQuietPart(captured.resolver("mystery_tool", () => makeBaseRenderer()).renderCall({}, theme, ctx()));
ok(unknownCall.render(80)[0].includes("mystery_tool"), "unknown tools fall back to bare name");
const lsCall = mustBeQuietPart(captured.resolver("ls", () => makeBaseRenderer()).renderCall({}, theme, ctx()));
ok(lsCall.render(80)[0].includes("Listing"), "ls without path lists");

// ============ width clipping (the pi-tui crash guard) ============
const { visibleWidth } = await import("@earendil-works/pi-tui");
for (const width of [119, 40, 20]) {
	for (const part of [editCall, bashCall, longCall, unknownCall]) {
		for (const line of part.render(width)) {
			ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
		}
	}
}
// error lines clip too (both crashes were exactly this)
renderers.renderResult({ content: [{ type: "text", text: "E".repeat(200) }] }, { expanded: false, isPartial: false }, theme, ctx(true));
for (const width of [119, 40, 20]) {
	for (const line of resultPart.render(width)) {
		ok(visibleWidth(line) <= width, `error line exceeds width ${width}`);
	}
}
// delegated lines clip (indent + long unbreakable tokens)
captured.command.handler("collapsed", { mode: "tui", ui: { notify: () => {} } });
const wideBase = {
	renderCall: () => ({ render: () => ["z".repeat(200)] }),
	renderResult: () => ({ render: () => ["w".repeat(200)] }),
};
const wideRenderers = captured.resolver("read", () => wideBase);
const wideCall = mustBeQuietPart(wideRenderers.renderCall({ path: "a.ts" }, theme, ctx()));
const wideResult = mustBeQuietPart(wideRenderers.renderResult({ content: [{ type: "text", text: "w".repeat(200) }] }, { expanded: false, isPartial: false }, theme, ctx()));
for (const width of [119, 40]) {
	for (const line of [...wideCall.render(width), ...wideResult.render(width)]) {
		ok(visibleWidth(line) <= width, `delegated line exceeds width ${width}`);
	}
}
captured.command.handler("name", { mode: "tui", ui: { notify: () => {} } });

// ============ MouseRegion contract: invalidate() must exist ============
// The host wraps renderer components in MouseRegion, whose invalidate() calls
// child.invalidate() unconditionally — a missing method crashes /reload.
ok(typeof resultPart.invalidate === "function", "parts must define invalidate()");

// in a delegating mode: frame reuse holds, invalidate() forces one re-delegate
captured.command.handler("collapsed", { mode: "tui", ui: { notify: () => {} } });
callPart.render(80); // warm (re-delegates or reuses a still-valid cache)
const cachedCalls = base.calls;
callPart.render(80);
ok(base.calls === cachedCalls, "frame reuse holds between host updates");
const region = { child: callPart, invalidate() { this.child.invalidate(); } };
region.invalidate(); // must not throw
callPart.render(80);
ok(base.calls === cachedCalls + 1, "invalidate forces one re-delegate");

// ============ /reload: fresh module instance ============
// Old parts must follow the new module's level (globalThis persistence).
captured.command.handler("none", { mode: "tui", ui: { notify: () => {} } }); // leave at none
const reloaded = await import(pathToFileURL(process.env.EXT_PATH).href + "?reload=1");
const captured2 = {};
reloaded.default({
	registerToolRenderer: (r) => { captured2.resolver = r; },
	registerShortcut: (k, o) => { captured2.shortcut = { key: k, ...o }; },
	registerCommand: (n, o) => { captured2.command = { name: n, ...o }; },
});
ok(captured2.resolver, "reloaded module registers resolver");
ok(callPart.render(80).length === 0, "old row obeys reloaded module's level (none)");
captured2.command.handler("name", { mode: "tui", ui: { notify: () => {} } });
ok(callPart.render(80).length === 1 && callPart.render(80)[0].includes("Reading a.ts..."), "old row follows new level (name)");

console.log("\nALL QUIET-TOOLS SMOKE CHECKS PASSED");
