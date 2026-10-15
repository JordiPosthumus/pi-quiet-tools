# pi quiet tools

A display extension for [pi](https://github.com/nicobailon/pi) that tames tool-call noise in the TUI — a 4-way version of the thinking toggle.

## Levels

Cycle with **`ctrl+shift+o`**, or jump directly with `/quiet-tools [level]`:

| level | what you see |
|---|---|
| `name` *(default)* | one dim verb line per call: `Reading foo.ts...`, `Running npm test` |
| `none` | nothing at all (one reserved blank row per tool call — that is the host's floor) |
| `collapsed` | the tool's own default view (call + truncated output) |
| `full` | always-expanded output |

The native `ctrl+o` still toggles output expansion inside `collapsed`; clicking a tool row works too.

**Errors are never hidden.** At the quiet levels a failed tool renders one compact red line (` ✗ edit: message...`), so failures can't scroll past unnoticed.

Tools listed in `EXEMPT_TOOLS` (default: `subagent`) render exactly as their own renderers draw them — useful for dashboards like background-agent progress cards.

## Install

Copy the extension into your personal extensions directory:

```
curl -o ~/.pi/agent/extensions/hide-tool-calls.ts <raw file url>
```

Requires pi 1.2.0+ (uses `registerToolRenderer`). Take effect immediately with `/reload`, or next session.

## Configuration

All knobs are constants at the top of the file:

- `DEFAULT_MODE` — startup level (`"name"`)
- `EXEMPT_TOOLS` — tool names that pass through untouched
- `ARG_LABELS` — the verb lines per tool; unknown tools fall back to the bare tool name
- `MODE_KEY` / keybinding — the `globalThis` slot that keeps your level across `/reload`, and the `pi.registerShortcut(...)` key

## Notes for extension authors

Two pi internals this extension had to respect — worth knowing before writing your own tool renderer:

1. **With `renderShell: "self"` you own line clipping.** The TUI crashes (by design) if any rendered line exceeds the terminal width. Native components get clipping from the padding box; self-shell renderers must call `truncateToWidth()` on every line themselves.
2. **`MouseRegion.invalidate()` calls `child.invalidate()` unconditionally.** The host wraps every renderer component in a MouseRegion, so stateful components must define `invalidate()` — a missing one crashes `/reload`.

## Test

A headless simulation of the host renderer contract lives in [`test/quiet-tools-smoke.mjs`](test/quiet-tools-smoke.mjs):

```
EXT_PATH=./hide-tool-calls.ts node --experimental-strip-types test/quiet-tools-smoke.mjs
```

It covers the four levels, error visibility, delegation caching, per-row isolation, the `MouseRegion` invalidate contract, level persistence across reload, and width clipping at narrow terminal sizes.

## License

MIT
