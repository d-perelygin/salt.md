# design/ — the design file and the code, kept in step

`design/salt-md.figcraft` is the source of the design. It is **never** edited by
a script here: the tools read it, render it, and report the places where it and
`web/src` disagree. A person makes the change in the design tool, then runs the
scripts again.

Everything below runs from the repository root with Python 3 (Pillow, numpy and
scipy are needed by `compare.py`; the rest is the standard library) and the
FigCraft CLI at
`~/Library/Application Support/ArtCraft/mcp/cli/figcraft-cli`
(override with `FIGCRAFT_CLI=/path/to/figcraft-cli`).

## The map

| File | What it is |
| --- | --- |
| `salt-md.figcraft` | the design file: pages, components, screens, variables |
| `screens.json` | which frame is which screen, and the wiki screenshot it is compared with |
| `code-map.json` | the join key: tokens → CSS, components → class, screens → source |
| `compare.py` | renders each screen at 2x, diffs it against the reference, writes zones |
| `sync_tokens.py` | exports the variables, writes `generated/tokens.css`, compares with `theme.css` |
| `lint_names.py` | checks that every component and screen carries a description with its code path |
| `generated/variables.json` | the variables as a Figma-shaped document, refreshed by `sync_tokens.py` |
| `generated/tokens.css` | Light in `:root`, Dark in `[data-theme='dark']` — a snapshot for review, **not imported** by the app |
| `report/tokens.md` | every token: match / diff / missing, with both values |
| `report/mismatches.md` | every screen: similarity, and the zones where the pixels differ |
| `report/<id>-side.png`, `<id>-diff.png` | reference above, render below; and the reference with the differing zones in red |

`code-map.json` is the only file edited by hand on a regular basis. Its keys are
stable: the scripts and the reports refer to them.

## The loop

```
edit the design in FigCraft
  → python3 design/compare.py        # where does the canvas differ from the app?
  → python3 design/sync_tokens.py    # where do the tokens differ from theme.css?
  → python3 design/lint_names.py     # does every layer say where its code is?
  → fix the code, or the design, whichever is stale
```

`compare.py` writes `report/mismatches.md`, the queue. A screen is not "close
enough" until its zones are gone; a zone is a real disagreement, not
antialiasing (the threshold is a per-channel Δ of 16 at 2x, and zones below
~30 logical px² are ignored).

`sync_tokens.py --check` exits 1 when any token is `diff` or `missing`, so a
change that moves a token without moving `theme.css` can fail a hook.
`lint_names.py` exits 1 for the same reason: a layer without a description is a
layer the next person cannot find in the code.

Run `compare.py` only when a screen changed: it launches the renderer once per
screen and a full pass takes a while. `sync_tokens.py` is cheap (one CLI call),
`lint_names.py` is one CLI call for all layers.

## Conventions

**Variables** are `Group/Name` in a collection that says what they are for:

- `Color` — one collection with `Light` and `Dark` modes. Light becomes `:root`,
  Dark becomes `[data-theme='dark']`. A colour that only exists in one mode is a
  mistake: `sync_tokens.py` will report the missing side.
- `Space & Radius` — px, single mode: `space/1…9`, `radius/xs…pill`, `size/*`
  for control sizes.
- `Type` — px, single mode: `font/*` for sizes, `weight/*` for weights.

The generated CSS name is derived, not chosen: `Surface/Page` → `--surface-page`,
`radius/md` → `--radius-md`, `font/2xs` → `--font-2xs`. Numbers get `px`, except
`weight/*`, which stays unitless. Never rename a variable to change its CSS
name; rename both sides deliberately.

**Layers** are named the way the code names the thing: `Badge`, `View Tab`,
`Sidebar Item`, `Desktop / Collection · Board`. A component set carries variants
named `Property=Value` (`Type=Primary`, `State=Selected`), which maps one-to-one
onto the modifier classes in `code-map.json` (`Button` → `.btn`, `Type=Primary`
→ `.btn.primary`).

**Descriptions** carry the path to the code, `path#selector`:

```
web/src/styles.css#.prop-chip
web/src/components/CollectionView.tsx
```

The path must exist in the repository and the selector must appear in the file;
`lint_names.py` checks both. A description that says what the layer is for can
follow the path on a second line, but the path comes first, because it is the
part a tool can act on.

## Adding a screen

1. In the design file, put the frame on the `03 · Desktop` page (or `04 · Mobile`,
   `05 · Dark`) and name it `Desktop / <Screen>`, matching the app's own name for
   it. The frame is 1280×800; a mobile frame is 390×844.
2. Give it a description with its source: `web/src/components/<Screen>.tsx`.
3. Catch the reference screenshot: the shot is defined in `wiki/screenshots.json`
   (viewport 1280×800; the PNG lands in `wiki/img/<id>.png` at 2x), and
   `cd web && node scripts/shoot-wiki.mjs <id>` takes it. A screen with no
   reference cannot be compared; it is listed in `code-map.json` with
   `"ref": null` and stays out of `screens.json` until it has one.
4. Add the entry to `screens.json` (`id`, `title`, `node`, `ref`, `source`; add
   `ours_crop` when the design frame is a crop of the app, as for sign-in) and to
   `code-map.json` under `screens`.
5. `python3 design/compare.py` and work through the new screen's zones.

## Adding a component or a token

- Component: after building it on `02 · Components`, add it to
  `code-map.json` → `components` with `node`, `class`, `file`, and `theme` when
  `theme.css` restates it. Variants go in `variants` as `Property=Value` →
  selector. Then describe the layer and run `lint_names.py`.
- Token: add the variable to the matching collection, then add it to
  `code-map.json` → `tokens`. If the code has no counterpart, say so in
  `missing` rather than leaving the token out: the `missing` rows in
  `report/tokens.md` are the honest list of what the design has and the app does
  not. `sync_tokens.py` regenerates `tokens.css` and the report.

## Current gaps, as the tools report them

These are findings, not instructions to fix the design file:

- `Chip/Teal/*` exists in the design and has no tone in `web/src/tags.ts`
  (`TAG_PALETTE` holds nine; teal would be the tenth).
- `State/Success` and `State/Warning` have no CSS token; `styles.css` reads
  `var(--success)` / `var(--warning)` with literal fallbacks at each call site.
- Spacing, control sizes and the type scale are literals in `styles.css`. They
  are listed as `missing` in `report/tokens.md`, which is the case for a scale
  rather than a bug in the script.
- `Badge` and `Property Pill` both resolve to `.prop-chip`; the tone palette
  behind them is `.tag-*`. The design's chip colours and the named tag palette
  differ (see the Δ values in `report/tokens.md`).
- Not one component or screen carries a description yet; `lint_names.py` prints
  the exact string each one needs.
