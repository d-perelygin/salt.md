#!/usr/bin/env python3
"""Design tokens → CSS, and design tokens ↔ code.

    python3 design/sync_tokens.py            # write generated files + report
    python3 design/sync_tokens.py --check    # exit 1 when a token is missing or differs

Steps:
  1. `variable.export` (format json) from design/salt-md.figcraft through
     figcraft-cli, saved as design/generated/variables.json: the same
     Figma-shaped document `variable.import` reads, so nothing downstream has to
     know about the CLI.
  2. design/generated/tokens.css: `:root` carries the Light mode,
     `[data-theme='dark']` the Dark mode, names derived from the variable name
     (`Surface/Page` → `--surface-page`). It is a snapshot for review, not an
     import: web/src/theme.css stays the app's source of truth.
  3. design/report/tokens.md: every token against its CSS custom property (or
     class rule) from design/code-map.json, with match / diff / missing and the
     two values side by side.

The comparison resolves alpha: a code token that is an alpha wash is composited
over the page before it is compared with the design's opaque swatch, and the
report says so. Without code-map entries a token is listed as unmapped rather
than silently skipped.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
FILE = DESIGN / "salt-md.figcraft"
MAP = DESIGN / "code-map.json"
GENERATED = DESIGN / "generated"
REPORT = DESIGN / "report"
CLI = Path(os.environ.get("FIGCRAFT_CLI", Path.home() / "Library/Application Support/ArtCraft/mcp/cli/figcraft-cli"))

CSS_FILES = ["web/src/styles.css", "web/src/theme.css"]   # later file wins, as in the app
DARK = ("[data-theme='dark']", '[data-theme="dark"]')
TOLERANCE = 2            # per-channel difference that still counts as a match


# --- figcraft -----------------------------------------------------------------

def cli_result(command: str, params: dict | None = None):
    """Run one read-only command headless and return its result."""
    with tempfile_script([{"command": command, "params": params or {}}]) as script:
        out = subprocess.run(
            [str(CLI), "run", "--in", str(FILE), str(script)],
            cwd=ROOT, check=True, capture_output=True, text=True,
        ).stdout
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        step = json.loads(line)
        if step.get("command") == command:
            if not step.get("ok", True):
                raise SystemExit(f"{command} failed: {step.get('error')}")
            return step["result"]
    raise SystemExit(f"{command}: no result from the CLI")


class tempfile_script:
    """A JSON script file for `figcraft-cli run`, removed afterwards."""

    def __init__(self, steps):
        self.steps = steps

    def __enter__(self):
        GENERATED.mkdir(parents=True, exist_ok=True)
        self.path = GENERATED / ".sync-tokens-script.json"
        self.path.write_text(json.dumps(self.steps))
        return self.path

    def __exit__(self, *exc):
        self.path.unlink(missing_ok=True)


# --- colours ------------------------------------------------------------------

def parse_color(text: str):
    """(r, g, b, a) with 0..255 channels, or None."""
    text = text.strip().rstrip(";")
    m = re.fullmatch(r"#([0-9a-fA-F]{3,8})", text)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 4:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            h += "ff"
        if len(h) != 8:
            return None
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16) / 255)
    m = re.fullmatch(r"rgba?\(([^)]*)\)", text)
    if m:
        parts = [p.strip() for p in re.split(r"[,/ ]+", m.group(1)) if p.strip()]
        alpha = 1.0
        if len(parts) == 4:
            a = parts[3]
            alpha = float(a[:-1]) / 100 if a.endswith("%") else float(a)
        try:
            return tuple(int(float(p)) for p in parts[:3]) + (alpha,)
        except ValueError:
            return None
    m = re.fullmatch(r"hsla?\(([^)]*)\)", text)
    if m:
        parts = [p.strip() for p in re.split(r"[,/ ]+", m.group(1)) if p.strip()]
        if len(parts) < 3:
            return None
        h = float(parts[0].replace("deg", "")) % 360 / 360
        s = float(parts[1].rstrip("%")) / 100
        l = float(parts[2].rstrip("%")) / 100
        a = 1.0
        if len(parts) >= 4:
            a = float(parts[3].rstrip("%")) / (100 if parts[3].endswith("%") else 1)
        r, g, b = _hsl_to_rgb(h, s, l)
        return (r, g, b, a)
    return None


def _hsl_to_rgb(h, s, l):
    def f(n):
        k = (n + h * 12) % 12
        a = s * min(l, 1 - l)
        return round(255 * (l - a * max(-1, min(k - 3, 9 - k, 1))))
    return f(0), f(8), f(4)


def hex_of(rgba):
    r, g, b, a = rgba
    h = "#%02x%02x%02x" % (round(r), round(g), round(b))
    return h if a >= 0.999 else h + "%02x" % round(a * 255)


def over(fg, bg):
    """Composite fg over an opaque bg."""
    fa = fg[3]
    return tuple(round(f * fa + b * (1 - fa)) for f, b in zip(fg[:3], bg[:3])) + (1.0,)


def parse_number(text: str):
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*(px|%)?\s*", text)
    return float(m.group(1)) if m else None


def delta(a, b):
    return max(abs(x - y) for x, y in zip(a[:3], b[:3]))


# --- CSS parsing --------------------------------------------------------------

def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def css_rules(css: str, ctx=()):
    """Yield (context selectors, selector, declarations) for every style rule."""
    out = []
    i, buf = 0, ""
    while i < len(css):
        c = css[i]
        if c == "{":
            depth, j = 0, i
            while j < len(css):
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            inner = css[i + 1:j]
            sel = " ".join(buf.split())
            buf = ""
            if sel.startswith("@"):
                out += css_rules(inner, ctx + (sel,))
            elif "{" in inner:
                out += css_rules(inner, ctx + (sel,))
            else:
                out.append((ctx, sel, inner))
            i = j + 1
        elif c == "}":
            buf, i = "", i + 1
        else:
            buf += c
            i += 1
    return out


def declarations(body: str) -> dict:
    decls = {}
    for chunk in body.split(";"):
        if ":" not in chunk:
            continue
        prop, value = chunk.split(":", 1)
        prop, value = prop.strip(), value.strip()
        if not prop or not value:
            continue
        decls[prop.lower()] = value
    return decls


def load_css():
    """(light declarations by selector, dark declarations by selector)."""
    light, dark = {}, {}
    for rel in CSS_FILES:
        path = ROOT / rel
        if not path.exists():
            continue
        for ctx, sel, body in css_rules(strip_comments(path.read_text())):
            is_dark = any(d in sel or d in " ".join(ctx) for d in DARK)
            target = dark if is_dark else light
            for prop, value in declarations(body).items():
                target.setdefault(sel.replace(DARK[0], "").replace(DARK[1], "").strip() or sel, {})[prop] = value
    return light, dark


def var_value(decls: dict, name: str):
    for sel in (":root", "html", ":root, body"):
        if name in decls.get(sel, {}):
            return decls[sel][name]
    for sel, props in decls.items():
        if name in props:
            return props[name]
    return None


# --- tokens -------------------------------------------------------------------

def export_variables() -> tuple[str, dict]:
    """`variable.export` as JSON: the same document `variable.import` reads, and
    the shape figma-shaped tooling expects (meta.variableCollections/variables)."""
    result = cli_result("variable.export", {"format": "json"})
    text = result.get("text")
    if not text:
        raise SystemExit("variable.export returned no text")
    return text, json.loads(text)


def css_name(name: str) -> str:
    return "--" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def fmt(variable: dict, collection: dict, mode_id: str) -> str:
    raw = variable["valuesByMode"][mode_id]
    if isinstance(raw, dict):
        return hex_of((raw["r"] * 255, raw["g"] * 255, raw["b"] * 255, raw.get("a", 1)))
    n = float(raw)
    return str(int(n)) if n == int(n) else f"{n:g}"


def unit_for(collection: str, name: str) -> str:
    return "" if collection == "Type" and name.startswith("weight/") else "px"


def write_tokens_css(doc: dict) -> None:
    meta = doc["meta"]
    cols = meta["variableCollections"]
    lines = [
        "/* Generated by design/sync_tokens.py from design/salt-md.figcraft.",
        "   A snapshot of the design tokens for review: imports nothing, overrides nothing.",
        "   web/src/theme.css stays the app's source of truth; the mapping to it is in",
        "   design/code-map.json and the differences are in design/report/tokens.md.",
        "   Regenerate: python3 design/sync_tokens.py */",
        "",
    ]

    def block(mode_index: int) -> list[str]:
        out = []
        for col_name in ("Color", "Space & Radius", "Type"):
            col = next((c for c in cols.values() if c["name"] == col_name), None)
            if not col:
                continue
            if mode_index >= len(col["modes"]):
                continue
            mode = col["modes"][mode_index]
            out.append(f"  /* {col_name} · {mode['name']} */")
            for vid in col["variableIds"]:
                var = meta["variables"][vid]
                if mode["modeId"] not in var["valuesByMode"]:
                    continue
                mapped = code_map_tokens().get(var["name"], {}).get("css")
                comment = f"  /* {mapped} */" if mapped else ""
                unit = unit_for(col_name, var["name"]) if var["resolvedType"] == "FLOAT" else ""
                out.append(f"  {css_name(var['name'])}: "
                           f"{fmt(var, col, mode['modeId'])}{unit};{comment}")
            out.append("")
        while out and out[-1] == "":
            out.pop()
        return out

    lines += [":root {"] + block(0) + ["}", ""]
    dark = block(1)
    if dark:
        lines += ["[data-theme='dark'] {"] + dark + ["}", ""]
    (GENERATED / "tokens.css").write_text("\n".join(lines).rstrip() + "\n")



_MAP_CACHE = {}


def code_map_tokens() -> dict:
    if "tokens" not in _MAP_CACHE:
        _MAP_CACHE["tokens"] = json.loads(MAP.read_text()).get("tokens", {})
    return _MAP_CACHE["tokens"]


def compare(light_css: dict, dark_css: dict):
    meta = json.loads((GENERATED / "variables.json").read_text())["meta"]
    cols = meta["variableCollections"]
    mapping = code_map_tokens()
    rows, counts = [], {"match": 0, "diff": 0, "missing": 0}

    order = ["Color", "Space & Radius", "Type"]
    by_col = {name: [] for name in order}
    for var in meta["variables"].values():
        col = cols[var["variableCollectionId"]]["name"]
        by_col.setdefault(col, []).append(var)

    for col_name in by_col:
        col = next(c for c in cols.values() if c["name"] == col_name)
        for var in sorted(by_col[col_name], key=lambda v: v["name"]):
            # A design-only step (the AI surfaces) has no CSS counterpart by
            # intent: the app writes those radii and sizes as literals. Mark the
            # variable's description `design-only` and it stays out of the
            # report instead of adding a `missing` row every run.
            if "design-only" in (var.get("description") or "").lower():
                continue
            entry = mapping.get(var["name"])
            design = {}
            for i, m in enumerate(col["modes"]):
                if m["modeId"] not in var["valuesByMode"]:
                    continue
                key = "Light" if i == 0 else "Dark" if i == 1 else m["name"]
                design[key] = fmt(var, col, m["modeId"])
            row = {"collection": col_name, "token": var["name"], "code": None,
                   "design": design, "codeValues": {}, "status": "missing", "note": "", "delta": {}}
            if not entry:
                row["note"] = "no entry in design/code-map.json"
                counts[row["status"]] += 1
                rows.append(row)
                continue
            if entry.get("note"):
                row["note"] = entry["note"]
            if not entry.get("css") and not entry.get("selector"):
                row["note"] = entry.get("missing") or row["note"] or "no CSS counterpart"
                counts["missing"] += 1
                rows.append(row)
                continue

            if entry.get("css"):
                row["code"] = entry["css"]
                cl = var_value(light_css, entry["css"])
                cd = var_value(dark_css, entry["css"])
                if cl is None and cd is None:
                    row["note"] = (row["note"] + "; " if row["note"] else "") + "property not found in the CSS files"
                    counts["missing"] += 1
                    rows.append(row)
                    continue
                values = {"Light": cl, "Dark": cd}
            else:
                row["code"] = f"{entry['selector']} {entry['property']}"
                values = {}
                for mode, decls in (("Light", light_css), ("Dark", dark_css)):
                    for sel, props in decls.items():
                        if sel.split()[-1] == entry["selector"]:
                            values[mode] = props.get(entry["property"])
                            break
                if not any(values.values()):
                    row["note"] = (row["note"] + "; " if row["note"] else "") + "rule not found in the CSS files"
                    counts["missing"] += 1
                    rows.append(row)
                    continue

            matched = True
            bg = {mode: (parse_color(var_value(light_css if mode == "Light" else dark_css, "--bg") or "#ffffff") or (255, 255, 255, 1))
                  for mode in ("Light", "Dark")}
            for mode, design_value in design.items():
                code_value = values.get(mode)
                if code_value is None:
                    matched = False
                    row["note"] = (row["note"] + "; " if row["note"] else "") + f"{mode}: no value in code"
                    continue
                d_col = parse_color(design_value)
                c_col = parse_color(code_value)
                row["codeValues"][mode] = code_value
                if d_col and c_col:
                    if c_col[3] < 0.999:
                        c_col = over(c_col, bg[mode])
                    d2 = delta(d_col, c_col)
                    row["delta"][mode] = d2
                    if d2 > TOLERANCE:
                        matched = False
                elif (d_num := parse_number(design_value)) is not None and \
                        (c_num := parse_number(code_value)) is not None:
                    row["delta"][mode] = abs(d_num - c_num)
                    if abs(d_num - c_num) > 0.5:
                        matched = False
                else:
                    if code_value != design_value:
                        matched = False
            row["status"] = "match" if matched else "diff"
            counts[row["status"]] += 1
            rows.append(row)
    return rows, counts


def write_report(rows, counts):
    total = len(rows)
    lines = [
        "# Design tokens ↔ code",
        "",
        "Generated by `design/sync_tokens.py` from `design/salt-md.figcraft`.",
        "Colour values are compared per channel, alpha composited over `--bg` where the code uses a wash; "
        f"a difference of up to {TOLERANCE} per channel is a match.",
        "",
        f"**{total} tokens** · {counts['match']} match · {counts['diff']} diff · {counts['missing']} missing",
        "",
    ]
    for col in ("Color", "Space & Radius", "Type"):
        group = [r for r in rows if r["collection"] == col]
        if not group:
            continue
        lines += [f"## {col}", "",
                  "| Token | Code | Light (design / code) | Dark (design / code) | Status | Note |",
                  "| --- | --- | --- | --- | --- | --- |"]
        for r in group:
            code = f"`{r['code']}`" if r["code"] else "—"
            light = f"{r['design'].get('Light', '—')} / {r['codeValues'].get('Light', '—')}"
            dark = (f"{r['design'].get('Dark', '—')} / {r['codeValues'].get('Dark', '—')}"
                    if ("Dark" in r["design"] or "Dark" in r["codeValues"]) else "—")
            glyph = {"match": "match", "diff": "diff", "missing": "missing"}[r["status"]]
            delta = f" (Δ{max(r['delta'].values())})" if r["status"] == "diff" and r["delta"] else ""
            lines.append(f"| `{r['token']}` | {code} | {light} | {dark} | {glyph}{delta} | {r['note']} |")
        lines.append("")
    lines += [
        "## Reading this",
        "",
        "- **match**: the design token and its CSS counterpart carry the same value in every mode the design has.",
        "- **diff**: both sides exist and disagree. Either the design or the code is stale; decide which.",
        "- **missing**: the design token has no CSS counterpart at all. Colour tokens that are missing are "
        "gaps in `theme.css`; spacing, size and type tokens are literals in `styles.css` today, so those rows are "
        "the case for a scale rather than a bug.",
        "",
    ]
    (REPORT / "tokens.md").write_text("\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="exit 1 when any token is missing or diff")
    args = ap.parse_args()

    if not CLI.exists():
        raise SystemExit(f"figcraft-cli not found at {CLI} (set FIGCRAFT_CLI)")
    GENERATED.mkdir(parents=True, exist_ok=True)
    REPORT.mkdir(parents=True, exist_ok=True)

    text, doc = export_variables()
    (GENERATED / "variables.json").write_text(text.rstrip() + "\n")
    write_tokens_css(doc)

    light_css, dark_css = load_css()
    rows, counts = compare(light_css, dark_css)
    write_report(rows, counts)

    print(f"variables: {len(doc['meta']['variables'])} in {len(doc['meta']['variableCollections'])} collections "
          f"→ design/generated/variables.json")
    print(f"tokens:    design/generated/tokens.css (Light + Dark)")
    print(f"compare:   {len(rows)} tokens · {counts['match']} match · {counts['diff']} diff · {counts['missing']} missing")
    for r in rows:
        if r["status"] != "match":
            print(f"  {r['status']:8} {r['token']:26} {r['code'] or '—'}")
    print(f"report:    design/report/tokens.md")
    return 1 if args.check and (counts["diff"] or counts["missing"]) else 0


if __name__ == "__main__":
    sys.exit(main())
