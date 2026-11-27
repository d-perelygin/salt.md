#!/usr/bin/env python3
"""Names and descriptions, the design file's half of the map.

    python3 design/lint_names.py
    python3 design/lint_names.py --json     # machine-readable, for a hook or CI

Every component and screen in design/code-map.json is looked up in
design/salt-md.figcraft. A layer passes when

  * its name in the file is the name the map uses,
  * it has a description, and the description carries the path to its code
    (`web/src/styles.css#.btn`, `web/src/components/Editor.tsx`),
  * that path exists in the repository.

The map itself is checked the same way: a class or custom property it names must
appear in the file it points at, so the map cannot drift away from the code.

Exit code 1 when anything fails, so it can gate a change to the design file.
Nothing here edits the design: the fix is a description on the layer, made in
the design tool (or with `node.set {id, description}`), then re-run.
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
MAP = DESIGN / "code-map.json"
FILE = DESIGN / "salt-md.figcraft"
TMP = DESIGN / "generated" / ".lint-names-script.json"
CLI = Path(os.environ.get("FIGCRAFT_CLI", Path.home() / "Library/Application Support/ArtCraft/mcp/cli/figcraft-cli"))

PATH_RE = re.compile(r"\b((?:web|server|design|wiki)/[\w./@-]+\.(?:tsx|ts|css|go|md|py))")
CODE_HINT = "web/src/styles.css#.class"      # how a description should read


def cli(steps):
    TMP.parent.mkdir(parents=True, exist_ok=True)
    TMP.write_text(json.dumps(steps))
    try:
        out = subprocess.run([str(CLI), "run", "--in", str(FILE), str(TMP)],
                             cwd=ROOT, check=True, capture_output=True, text=True).stdout
    finally:
        TMP.unlink(missing_ok=True)
    results = []
    for line in out.splitlines():
        line = line.strip()
        if line:
            results.append(json.loads(line))
    return results


def layer(index: int):
    return {"command": "node.get",
            "params": {"id": index, "fields": ["name", "type", "description", "pluginData"]}}


def describe(layer_result):
    """An empty description is absent from the CLI result, not an empty string.

    A frame has no description field (`node.set` refuses it: "description
    applies to components"), and the screens are frames. Their path lives in
    pluginData.description instead, which is the one lane the file keeps for a
    frame's own notes. A component's real description always wins.
    """
    text = (layer_result.get("description") or "").strip()
    if not text:
        text = ((layer_result.get("pluginData") or {}).get("description") or "").strip()
    return " ".join(text.split())


def check_targets(doc: dict):
    targets = []
    for name, spec in doc.get("components", {}).items():
        targets.append({
            "kind": "component", "key": name, "node": spec["node"], "expected": name,
            "hint": f"{spec['file']}#{spec['class']}" if spec.get("class") else spec.get("file", ""),
            "paths": [p for p in [spec.get("file")] if p],
        })
    for key, spec in doc.get("screens", {}).items():
        targets.append({
            "kind": "screen", "key": key, "node": spec["node"], "expected": spec.get("title", key),
            "hint": spec.get("source", ""), "paths": [p for p in [spec.get("source")] if p],
        })
    return targets


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="print the findings as JSON")
    args = ap.parse_args()

    if not CLI.exists():
        raise SystemExit(f"figcraft-cli not found at {CLI} (set FIGCRAFT_CLI)")
    doc = json.loads(MAP.read_text())
    targets = check_targets(doc)

    steps = [layer(t["node"]) for t in targets]
    results = [r for r in cli(steps) if r.get("command") == "node.get"]
    layers = {str((r.get("result") or {}).get("id")): (r.get("result") or {}) for r in results}

    findings = []
    for t in targets:
        got = layers.get(str(t["node"]), {})
        item = {"kind": t["kind"], "key": t["key"], "node": t["node"], "status": "ok", "problems": []}
        if not got:
            item["status"] = "error"
            item["problems"].append("node not found in the design file")
            findings.append(item)
            continue
        name = got.get("name", "")
        if name != t["expected"]:
            item["status"] = "error"
            item["problems"].append(f'layer is named "{name}", the map says "{t["expected"]}"')
        text = describe(got)
        if not text:
            item["status"] = "error"
            item["problems"].append(f"description empty; add `{t['hint']}`")
        else:
            paths = PATH_RE.findall(text)
            if not paths:
                item["status"] = "error"
                item["problems"].append(f"description has no code path; add `{t['hint']}`")
            for p in paths:
                if not (ROOT / p).exists():
                    item["status"] = "error"
                    item["problems"].append(f"description points at `{p}`, which is not in the repository")
        findings.append(item)

    # The map's own claim: the class or token it names is really in that file.
    map_findings = []
    for name, spec in doc.get("components", {}).items():
        path = ROOT / spec["file"]
        item = {"kind": "component", "key": name, "file": spec["file"], "status": "ok", "problems": []}
        if not path.exists():
            item["status"] = "error"
            item["problems"].append("file from code-map.json does not exist")
        elif spec.get("class") and spec["class"] not in path.read_text():
            item["status"] = "error"
            item["problems"].append(f"`{spec['class']}` is not in {spec['file']}")
        map_findings.append(item)
    for key, spec in doc.get("screens", {}).items():
        item = {"kind": "screen", "key": key, "file": spec.get("source", ""), "status": "ok", "problems": []}
        if spec.get("source") and not (ROOT / spec["source"]).exists():
            item["status"] = "error"
            item["problems"].append("source file from code-map.json does not exist")
        map_findings.append(item)
    for token, spec in doc.get("tokens", {}).items():
        path = spec.get("file")
        if not path:
            continue
        item = {"kind": "token", "key": token, "file": path, "status": "ok", "problems": []}
        if not (ROOT / path).exists():
            item["status"] = "error"
            item["problems"].append("file from code-map.json does not exist")
        elif spec.get("css") and spec["css"] + ":" not in (ROOT / path).read_text():
            item["status"] = "error"
            item["problems"].append(f"`{spec['css']}` is not declared in {path}")
        map_findings.append(item)

    errors = [f for f in findings + map_findings if f["status"] != "ok"]
    if args.json:
        print(json.dumps({"design": str(FILE.relative_to(ROOT)), "checked": findings,
                          "codeMap": map_findings,
                          "summary": {"checked": len(findings), "errors": len(errors)}}, indent=2))
        return 1 if errors else 0

    print(f"design/lint_names.py — {FILE.relative_to(ROOT)}, {len(findings)} layers in design/code-map.json")
    for kind, label in (("component", "components"), ("screen", "screens")):
        group = [f for f in findings if f["kind"] == kind]
        print(f"\n{label} ({len(group)})")
        for f in group:
            mark = "ok  " if f["status"] == "ok" else "FAIL"
            print(f"  {mark} {f['key']:18} node {f['node']:<5} {'; '.join(f['problems'])}")
    print(f"\ncode-map paths ({len(map_findings)})")
    broken = [f for f in map_findings if f["status"] != "ok"]
    if broken:
        for f in broken:
            print(f"  FAIL {f['key']:18} {'; '.join(f['problems'])}")
    else:
        print(f"  ok   all {len(map_findings)} entries resolve to a file that carries the name")

    missing = [f for f in findings if any(p.startswith("description empty") for p in f["problems"])]
    print(f"\nsummary: {len(findings)} checked · {len(findings) - len([f for f in findings if f['status'] != 'ok'])} ok · "
          f"{len(missing)} without a description · {len(errors) - len(missing)} other problems")
    if missing:
        print(f"hint: paste the suggested `path#.class` into each layer's description ({CODE_HINT})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
