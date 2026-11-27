#!/usr/bin/env python3
"""Compare FigCraft screens with the wiki screenshots, pixel by pixel.

    python3 design/compare.py

For every screen in design/screens.json it
  1. exports the frame from design/salt-md.figcraft at 2x with figcraft-cli,
  2. aligns it with the reference screenshot,
  3. finds connected zones whose colour differs by more than THRESHOLD,
  4. writes design/report/<id>-diff.png, <id>-side.png and mismatches.md.

Every zone is a place where the design and the app disagree. The report is the
queue of things to fix; nothing is "close enough" until its zones are gone.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
FILE = DESIGN / "salt-md.figcraft"
CLI = Path.home() / "Library/Application Support/ArtCraft/mcp/cli/figcraft-cli"
RENDER = ROOT / "tmp/design-render"
REPORT = DESIGN / "report"
THRESHOLD = 16          # per-channel difference that counts as a mismatch
MIN_AREA = 120          # pixels at 2x (~30 logical px²) — ignores type antialiasing
SCALE = 2


def export(node: int, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [str(CLI), "export", str(FILE), "--node", str(node), "--scale", str(SCALE), "-o", str(out)],
        cwd=ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def classify(box, scale):
    x0, y0 = box[0] / scale, box[1] / scale
    if x0 < 292:
        return "sidebar"
    if y0 < 47:
        return "topbar"
    return "content"


def mean_color(a, box):
    crop = a[box[1]:box[3], box[0]:box[2]]
    if crop.size == 0:
        return "#000000"
    m = crop.reshape(-1, crop.shape[-1]).mean(axis=0).astype(int)
    return "#%02x%02x%02x" % tuple(m[:3])


def compare(screen):
    sid = screen["id"]
    ours_path = RENDER / f"{sid}.png"
    export(screen["node"], ours_path)
    ours = Image.open(ours_path).convert("RGB")
    ref = Image.open(ROOT / screen["ref"]).convert("RGB")

    if "ours_crop" in screen:
        x, y, w, h = screen["ours_crop"]
        ours = ours.crop((x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE))

    note = ""
    if ours.size != ref.size:
        note = f"size {ref.size} vs {ours.size}, resized ours"
        ours = ours.resize(ref.size, Image.LANCZOS)

    a = np.asarray(ref).astype(np.int16)
    b = np.asarray(ours).astype(np.int16)
    delta = np.abs(a - b).max(axis=2)

    # Paper and card surfaces differ by a few levels between a screenshot and
    # a render; that is not a design mismatch. Keep coloured surfaces and ink.
    light = ((a.min(axis=2) > 210) & (b.min(axis=2) > 210)
             & ((a.max(axis=2) - a.min(axis=2)) < 18)
             & ((b.max(axis=2) - b.min(axis=2)) < 18))
    mask = (delta > THRESHOLD) & ~light
    mask = ndimage.binary_opening(mask, structure=np.ones((2, 2)))
    mask = ndimage.binary_dilation(mask, structure=np.ones((3, 3)), iterations=1)
    labels, count = ndimage.label(mask)
    slices = ndimage.find_objects(labels)

    zones = []
    for i, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        y0, y1 = sl[0].start, sl[0].stop
        x0, x1 = sl[1].start, sl[1].stop
        area = int((labels[sl] == i).sum())
        if area < MIN_AREA:
            continue
        d = delta[sl][labels[sl] == i]
        zones.append({
            "x": round(x0 / SCALE),
            "y": round(y0 / SCALE),
            "w": round((x1 - x0) / SCALE),
            "h": round((y1 - y0) / SCALE),
            "area": area,
            "mean": round(float(d.mean()), 1),
            "max": int(d.max()),
            "region": classify((x0, y0, x1, y1), SCALE),
            "ref": mean_color(a, (x0, y0, x1, y1)),
            "ours": mean_color(b, (x0, y0, x1, y1)),
        })
    zones.sort(key=lambda z: -(z["area"] * z["mean"]))

    total = delta.size
    sim = lambda t: round(100.0 * float((delta <= t).mean()), 2)
    result = {
        "id": sid,
        "title": screen["title"],
        "source": screen["source"],
        "size": list(ref.size),
        "note": note,
        "similarity_16": sim(16),
        "similarity_32": sim(32),
        "zones": zones,
    }

    # diff picture: reference with the mismatching areas in red and the top
    # zones framed, so a person can see where the code and the canvas differ.
    overlay = ref.copy()
    red = Image.new("RGB", ref.size, (220, 30, 60))
    overlay = Image.composite(red, overlay, Image.fromarray((mask * 150).astype(np.uint8)))
    draw = ImageDraw.Draw(overlay)
    for z in zones[:15]:
        draw.rectangle(
            [z["x"] * SCALE, z["y"] * SCALE, (z["x"] + z["w"]) * SCALE, (z["y"] + z["h"]) * SCALE],
            outline=(180, 0, 40), width=2,
        )
    REPORT.mkdir(parents=True, exist_ok=True)
    overlay.save(REPORT / f"{sid}-diff.png")

    side = Image.new("RGB", (ref.width, ref.height * 2 + 8), "white")
    side.paste(ref, (0, 0))
    side.paste(ours, (0, ref.height + 8))
    side.save(REPORT / f"{sid}-side.png")
    return result


def main():
    screens = json.loads((DESIGN / "screens.json").read_text())
    results = [compare(s) for s in screens]

    lines = ["# Design ↔ code — mismatch report", ""]
    lines.append(f"Threshold: max channel Δ > {THRESHOLD}; zones ≥ {MIN_AREA}px at {SCALE}x. "
                 "Coordinates are 1280×800 logical pixels.")
    lines.append("")
    lines.append("| Screen | Similar ≤16 | ≤32 | Zones | Source |")
    lines.append("| --- | ---: | ---: | ---: | --- |")
    for r in results:
        lines.append(f"| {r['title']} | {r['similarity_16']}% | {r['similarity_32']}% | "
                     f"{len(r['zones'])} | `{r['source']}` |")
    lines.append("")

    for r in results:
        lines.append(f"## {r['title']}")
        lines.append("")
        if r["note"]:
            lines.append(f"_{r['note']}_")
            lines.append("")
        if not r["zones"]:
            lines.append("No zones above the threshold.")
            lines.append("")
            continue
        lines.append("| # | region | x, y | w×h | mean Δ | ref | ours |")
        lines.append("| ---: | --- | --- | --- | ---: | --- | --- |")
        for i, z in enumerate(r["zones"][:20], 1):
            lines.append(f"| {i} | {z['region']} | {z['x']}, {z['y']} | {z['w']}×{z['h']} | "
                         f"{z['mean']} | `{z['ref']}` | `{z['ours']}` |")
        lines.append("")
        lines.append(f"Images: `design/report/{r['id']}-side.png`, `{r['id']}-diff.png`.")
        lines.append("")

    (REPORT / "mismatches.md").write_text("\n".join(lines))
    (REPORT / "mismatches.json").write_text(json.dumps(results, indent=2))

    for r in results:
        print(f"{r['id']:9} ≤16 {r['similarity_16']:5.1f}%  ≤32 {r['similarity_32']:5.1f}%  zones {len(r['zones'])}")
    print(f"\nreport: {REPORT/'mismatches.md'}")


if __name__ == "__main__":
    sys.exit(main())
