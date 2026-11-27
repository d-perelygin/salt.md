# misc — Search (2926), Sign in (3095), Library · Graph (1382)

Measurements of the three FigCraft screens against the wiki screenshots. Each
row: a zone, the reference box/value, the FigCraft box/value, the delta, the
layer that owns it, the exact property to set, and why the two differ.

**Source of the FigCraft column:** `design/salt-md.figcraft`, sha256
`dc0893d8c59d…10ac680`, copied to `tmp/agent-misc/salt-md-latest.figcraft`; its
JSON is `tmp/agent-misc/latest.json`, its renders
`tmp/agent-misc/latest-2926|3095|1382.png`. Nothing was written to the file and
no commit was made from this session.

The sheet is being edited in another session while this was measured: between
`4faa496` and `dc0893d` the sidebar was rebuilt and the token colours were
retuned (border `#e4e2db`→`#e2e2de`, badge and node greens went lighter and
back). **All boxes below were re-checked against `dc0893d` and are identical**
across those revisions; the hex values in the FigCraft column are the ones in
`dc0893d` and may be tuned again — trust the `эталон` column, not the token.

**эталон:** `wiki/img/search.png`, `wiki/img/sign-in.png` (a 640×684 @2x crop of
the card at (480,229) 320×342), `wiki/img/graph.png` — all 2x of 1280×800.

**Coordinates** are 1280×800 logical px. **Δ = эталон − FigCraft**: `+x`/`+y`
means the design layer must move right/down; `+w`/`+h` that it must grow.
`≈` = within 1–1.5 px (antialiasing). FigCraft x/y are relative to the parent
named in the layer column, as `node.get` reports them; the graph rows are
frame-local (frame 1382 is at 0,0).

---

## 0. Exact commands

```sh
CLI="/Users/danil/Library/Application Support/ArtCraft/mcp/cli/figcraft-cli"

# the measured copy and its JSON
cp design/salt-md.figcraft tmp/agent-misc/salt-md-latest.figcraft
"$CLI" convert tmp/agent-misc/salt-md-latest.figcraft tmp/agent-misc/latest.json

# whole frames at 2x
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 2926 --scale 2 -o tmp/agent-misc/latest-2926.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 3095 --scale 2 -o tmp/agent-misc/latest-3095.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 1382 --scale 2 -o tmp/agent-misc/latest-1382.png

# one zone (exporting a nested node is a crop of it), 4x to read edges
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 5629 --scale 4 -o tmp/agent-misc/z/search-modal.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 5634 --scale 4 -o tmp/agent-misc/z/search-row1.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 5655 --scale 4 -o tmp/agent-misc/z/search-foot-pill.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 3107 --scale 4 -o tmp/agent-misc/z/signin-card.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 1476 --scale 4 -o tmp/agent-misc/z/graph-tabs.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 1500 --scale 2 -o tmp/agent-misc/z/graph-canvas.png
"$CLI" export tmp/agent-misc/salt-md-latest.figcraft --node 1521 --scale 4 -o tmp/agent-misc/z/graph-foot.png

# the same zone cut out of the reference (logical px)
python3 - <<'PY'
from PIL import Image
Image.open('wiki/img/search.png').crop((141*2,49*2,1139*2,598*2)).save('tmp/agent-misc/z/ref-search-modal.png')
Image.open('wiki/img/graph.png').crop((316*2,204*2,1248*2,775*2)).save('tmp/agent-misc/z/ref-graph-canvas.png')
Image.open('wiki/img/sign-in.png').crop((30*2,160*2,290*2,200*2)).save('tmp/agent-misc/z/ref-signin-email.png')
PY

# layer geometry with parent-relative x/y (what node.set takes)
"$CLI" run --in design/salt-md.figcraft <<'JSON'
[{"command":"node.get","params":{"id":"5634","fields":["name","x","y","width","height","cornerRadius","fills","strokes","effects"]}}]
JSON
```

Measurement helper used for every box below (ink bbox under `thr` in a region):

```sh
python3 - <<'PY'
import numpy as np; from PIL import Image
a=np.asarray(Image.open('wiki/img/search.png').convert('RGB')).astype(int)
x,y,w,h,thr=141,49,998,549,150
c=a[y*2:(y+h)*2,x*2:(x+w)*2]; m=c.min(axis=2)<thr
ys,xs=np.where(m); print(x+xs.min()/2, y+ys.min()/2, (xs.max()-xs.min()+1)/2, (ys.max()-ys.min()+1)/2)
PY
```

Fixes are written as `node.set` property=value pairs; the coordinates are the
ones `node.get` returns (parent-relative). Nothing here was applied.

---

## 1. Search — frame 2926, modal 5629

Reference modal: white 998×549 at (141,49) inside a 1000×551 box at (140,48),
1 px border, radius 12; header rule y=127; pane divider x=787 (list 646,
preview 352); footer rule y=550.

| # | zone | эталон | FigCraft | Δ | layer | property = value | cause |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| S1 | modal box | 1000×551 at (140,48) r12, 1 px #e6e6e5 border (white 998×549 at 141,49) | 998×549 at (141,49) r14, no stroke | −1,−1 +2,+2 r −2 | 5629 | `x=140 y=48 width=1000 height=551 cornerRadius=12 stroke=#E6E6E5 strokeWeight=1` | `.search-modal` 1000 wide, `border:1px`, `border-radius:12px` |
| S2 | drag handle | (623,60) 34×4 r2 #d2d1d0 | — | — | — | `shape.rectangle` in 5629 at `x=482 y=11 width=34 height=4 cornerRadius=2 fill=#D2D1D0` | the app's sheet has a grabber above the input (25 px strip), which is why its header is 78 tall |
| S3 | header rule | y=127 | 5633 y=113 | +14 | 5633 | `y=78` | header = 25 handle + input 16/20/16 + 1 rule |
| S4 | query text | ink (160.5,97.5) 41×9.5, 17 px | ink (162.5,77) 48.5×11.5, 20 px | −2,+20.5 fs −3 | 5630 | `fontSize=17` `lineHeight=24` `y≈41` (ink top 48.5) | `.search-input { font-size:17px; padding:16px 18px }` |
| S5 | preview toggle | ink (1109.5,94.5) 14×14, no chip | chip (1081,65) 32×32 r7, icon ink (1088,72) 18×18 | +21.5,+22.5 | 5631 / 5632 | `5631 x=959 y=37 fill=none`; `5632 x=9 y=9 width=15 height=15` | the app's icon is a bare 14 px glyph at the header's right, 8 px from the edge |
| S6 | result row 1 | fill (147,134) 634×68 r8 #f5f5f5; inner padding 9/12, icon→text gap 10 | 5634 (141,119) 623×76, square, #ecebe6; padding 14/16/14/20, gap 12 | +6,+15 +11,−8 | 5634 | `x=6 y=85 width=634 height=68 cornerRadius=8 fill=#F5F5F5 padding=[9,12,9,12] gap=10` | `.search-results{padding:6px}` + `.search-result{padding:9px 12px;border-radius:8px;gap:10px}` |
| S7 | result row 2 | (147,202) 634×68 (no fill), same padding | 5641 (141,195) 623×76 | +6,+7 +11,−8 | 5641 | `x=6 y=153 width=634 height=68 cornerRadius=8 padding=[9,12,9,12] gap=10` | same; rows are 68 tall and touch (row 1 ends 202) |
| S8 | row icon | ink (156.5,143.5) 21×17 | ink (162.5,134.5) 17×17 | −6,+9 | 5635 (5636) | `5636 width=17 height=17`; position comes from 5634's padding 9/12 | `.result-icon` 17 px, first child of a 9/12-padded row |
| S9 | row title | ink (185.5,146.5) 87×10.5, 14/600 | ink (194,137) 92×11.5, 15/600 | −8.5,+9.5 fs −1 | 5638 | `fontSize=14`; x/y from the row's padding + gap (5637 x=0 y=0 in 5634) | `.result-title { font-size:14px; font-weight:600 }` |
| S10 | breadcrumb | ink (186,165) 150×8, 11 px @70% | ink (194,158.5) 163×9.5, 12 px | −8,+6.5 fs −1 | 5639 | `fontSize=11` `opacity=0.7` | `.result-context { font-size:11px; opacity:.7 }` |
| S11 | snippet | ink (186,181) 76.5×9, 12.5 px | ink (194,177) 78×9.5, 13 px | −8,+4 fs −0.5 | 5640 | `fontSize=12.5` | `.result-snippet { font-size:12.5px }` |
| S12 | pane divider | x=787, y 127→550 (424) | 5648 x=764, y 113→550 (437) | +23, +14, h −13 | 5648 | `x=646 y=78 height=424` | `.search-main{flex:2}` / `.search-preview{flex:1}` in a 1000 modal → 646 / 352 |
| S13 | preview title | ink (848.5,211.5) 201×24 (≈32 px) | ink (805,175.5) 176×22 (28 px) | +43.5,+36 fs +4 | 5649 | `fontSize=32` `lineHeight=38` `x=706 y=154` | the preview hosts the real editor at `zoom:.8`; the page title renders ≈32 px in that pane |
| S14 | preview rule | (847,263) 293×1 | 5650 (804,225) 300×1 | +43,+38 w −7 | 5650 | `x=706 y=214 width=293` | h1 rule width = pane padding 12/14 + content |
| S15 | “Kind” | ink (847.5,285.5) 22.5×8.5, 12.5 px | ink (805,253) 24×9.5, 13 px | +42.5,+32.5 | 5651 | `fontSize=12.5 x=706 y=231` | property label row in the preview |
| S16 | badge | (954,280) 51×19 #a5e3b9 | 5652 (904,245) 62×20 #b8f0c8 | +50,+35 −11,−1 | 5652 | `x=813 y=231 width=51 height=19 fill=#A5E3B9` | `--accent-soft` chip, 51 wide for “Service” |
| S17 | preview “open” icon | ink (1105.5,147.5) 12×12 | — | — | — | icon 12×12 in 5629 at `x=964 y=95` | `.search-preview-head` renders an open-in-new-tab button |
| S18 | footer rule | y=550 | 5654 y=550 | 0 | 5654 | — (ok) | same padding |
| S19 | footer hint | one pill (155,559) 185×31 r8 #f5f5f5, two caps #d4d4d4 (26,515)/(59,515) 25×21, label ink (230,569.5) 108×14 | chip 5655 (161,560) 34×22 r5 + caps text 5656 + label 5657 (205,564) outside | −6,−1 +151,+9; label +24,+1.5 | 5655 / 5656 / 5657 | `5655 x=14 y=510 width=185 height=31 cornerRadius=8 fill=#F5F5F5`; `5656` → two 25×21 #D4D4D4 caps at `x=12`/`x=45`, `y=5`, r5; `5657 x=75 y=5` | `.search-footer-btn` is one pill (padding 5/6/5/12, gap 8, radius 8, bg `--hover`) holding both keys and the label |
| S20 | settings icon | ink (1105.5,568.5) 12×12 | ink (1101,563) 16×16 | +4.5,+5.5 | 5658 / 5659 | `5658 x=963 y=518 width=16 height=16` (no fill); `5659 x=2 y=2 width=11 height=11 strokeWeight=1.4` | `.search-icon-btn` 6 px padding, 13 px glyph |
| S21 | dim overlay | page dimmed to #9c9c98 (sidebar) / #a3a3a1 (paper) | #a8a7a2 / #aeadaa | lighter | 3064 | `opacity=0.46` | the app's scrim is 46 % of #3b3a36 over `--bg` |

---

## 2. Sign in — frame 3095, card 3107

Reference is the 320×342 card crop at (480,229); card-local coordinates below.

| # | zone | эталон | FigCraft | Δ | layer | property = value | cause |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| L1 | card ring | r20 ✓, 1.5 px conic ring: #e0dcdd left/bottom, arc #43c756→#ffcc2d→#fa4671 on the right edge; soft shadow | 3107 320×342 r20, flat 1 px #e3b6c1 | — | 3107 | `strokeWeight=1.5`; keep r20; ring = conic gradient stroke, or accept the flat pink | `.ring` paints a 1.5 px rotating conic border (9 s) + `box-shadow` — the screenshot catches the arc mid-turn; a static frame can only approximate it |
| L2 | logo | ink (140.5,39.5) 38.5×49 (the mark is narrow) | 3108 box (132,35) 56×56, ink 56×54.5 | box ✓, art ✗ | 3108 | replace the vector with `web/src/Logo.tsx` (viewBox `96 100 204 204`) at `x=132 y=35 width=56 height=56` | `Login.tsx` renders that exact SVG at 56; the frame's drawing fills its box |
| L3 | wordmark | ink (117,108) 86.5×16 | ink (117,107) 85.5×16 | ✓ | 3109 | — | JetBrains Mono Bold 22 (the `.wordmark` on a mono stack) |
| L4 | subtitle | ink (76,144) 167.5×13 | ink (76,143) 167.5×12.5 | ✓ | 3110 | — | `.login-card p` 13.5 |
| L5 | email field | box (31,175) 258×37, border #d7869b 1 px + pink glow below | 3111 (30,167) 260×38, stroke #b3123f 1.5 | +1,+8 −2,−1 | 3111 | `width=258 height=38 stroke=#D7869B strokeWeight=1`, drop shadow #B3123F 14 % blur 12 offset y 2; y comes from the stack (L9) | `.login-card input` fills the card minus 30 px padding; `:focus` border = accent 50 % + `0 2px 12px rgba(accent,.14)`; the field is focused in the shot |
| L6 | password field | box (31,222) 258×37, border #e3e1de | 3113 (30,215) 260×38 #e4e2db | +1,+7 −2,−1 | 3113 | `width=258 stroke=#E3E1DE` | same input metrics, unfocused |
| L7 | submit button | box (31,269) 258×38, **pill r19**, #1c1a15 | 3115 (30,263) 260×38 r8 | +1,+6 −2, r +11 | 3115 | `width=258 cornerRadius=19` | `.login-card .btn.primary { border-radius:999px }` |
| L8 | field labels | Email ink (45.5,188.5) 32.5×10.5; Password ink (45,235.5) 63×10.5 | Email ink (44.5,180.5) 33.5×11; Password (44,229) 63×10.5 | +1,+8 / +1,+6.5 | 3112 / 3114 | children of the fields — they follow L9; `x=15` if the 1 px stroke stays | placeholder text, 14 px, `padding:9px 12px` |
| L9 | content stack | subtitle ink ends 157 → field 175 (gap 18); fields 11 apart; button ends 307, card bottom padding 33 | gaps 10/10/10, bottom 41, fields 260 wide | stack +8 | 3107 (auto-layout, vertical, gap 10, padding 34/30) | `padding=[34,30,33,30]`; insert a 1×8 spacer (or make 3110 26 tall) between 3110 and 3111; fields `width=258` | `.login-card p { margin-bottom:8px }` adds 8 before the first input; card `gap:10px; padding:34px 30px` |

---

## 3. Library · Graph — frame 1382

Reference panel (292,8) 980×784 r16 with a shadow; content padding 32/24.

| # | zone | эталон | FigCraft | Δ | layer | property = value | cause |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| G1 | panel | (292,8) 980×784 r16 + shadow | 1453 same, 2 effects | ✓ | 1453 | — | `.index-view` sits on the app's sheet |
| G2 | rainbow | 1 px at y=8; colours start ≈443 and fade out ≈1106; sampled #e9caca(452) #f0ac95(532) #f7aa63(612) #f7d363(732) #a5d275(812) #60c796(892) #6cacd5(972) #afb5e8(1052) #ddd6e0(1132); flanks are the panel border #e4e4e0 | six 124.6-wide rects x 409.6→1154.9, 1 px, opacity 0.7, hard joins, #fe6b8d/#ff9541/#ffd541/#38ca6d/#4e8ef6/#9d47eb | span, saturation, joins | 2909–2914 | replace the six rects with one 1×980 rect at `x=292 y=8` (frame 1382), linear gradient with the stops above, opacity ≈0.62, or mask both ends with a 40 px fade | the app paints one gradient rail with faded ends, not six chips |
| G3 | topbar | 980×47, no breadcrumb, no bottom rule | 1454 same box, `Left` breadcrumb 🧂 Library at (330,22), 1 px bottom stroke | extra content | 1454 / 1455 | `1454 stroke=none`; delete 1455 | the Library screen shows its own big title, so the topbar carries actions only |
| G4 | page title | ink (344,62) 87.5×25.5, UI sans **26 px bold** | ink (382,93) 143.5×32, **JetBrains Mono SemiBold 38** | −38,−31, family+size | 1473 | `x=52 y=48 fontFamily=Inter fontStyle=Bold fontSize=26 lineHeight=31` | `.index-head h1 { font-size:26px }` in the UI font; mono at 38 is both too wide and too tall |
| G5 | page icon | ink (318.5,64.5) 15×15 | ink (341,95) 28×28 (1471 30×30, 1472 26×26) | −22.5,−30.5 13 | 1471 / 1472 | `1471 x=24 y=54` (16×16); `1472 x=1.5 y=2 width=13 height=13 strokeWeight=1.5` | the icon row is 16 px, on the title's cap line |
| G6 | Close | box (1185,63) 63×29 r7, text ink (1198.5,72.5) 36.5×9.5 | 1474 (1164,94) 60×32, text ink (1177.5,98.5) 33×9 | +21,−31 +3,−3 | 1474 / 1475 | `1474 x=893 y=55 width=63 height=29`; `1475 x=13 y=6.5` 12.5 px | `.btn-sm` sits 24 px from the right, 8 px below the topbar |
| G7 | tab bar | (316,120) 896×30 r8 #f1f0ed, right end 1212; bar padding 2, gap 2 | 1476 (340,156) 884×40 r10 #ecebe6, padding 4 | −24,−36 896×30 | 1476 | `x=24 y=112 width=896 height=30 cornerRadius=8 fill=#F1F0ED padding=2 gap=2` | `.index-modes { gap:2px; padding:2px; border-radius:8px; background:var(--hover) }`, width hugs the tabs |
| G8 | selected tab | (980,122) 80×26 r7 #ffffff; pills 26 tall, padding 5/11, gap 6, labels 13 px, counts 11 px | 1492 (868,160) 83×31 r7; pills 32 tall, padding 0/12 | +112,−38 | 1477–1495 (pills), 1492 selected | pills `cornerRadius=6 padding=[5,11,5,11] gap=6` (height follows at 26); bar reflows; 1492 at `x=664` (80 wide) | `.index-mode { padding:5px 11px; border-radius:6px; font-size:13px; gap:6px }`, count 11 px |
| G9 | filter | (317,161) 378×28 | 1498 (341,213) 468×32 | −24,−52 378×28 | 1498 | `x=25 y=153 width=378 height=28` | `.index-search { flex:1 1 200px; max-width:380px; height:30px }` |
| G10 | canvas | (316,204) 932×≈571 r10, **top border only** #e2e2de | 1500 (340,258) 884×520 r8, full 1 px stroke | −24,−54 932×571 | 1500 | `x=24 y=196 width=932 height=571 cornerRadius=10`, stroke top only (1 px #E2E2DE) | `.graph-wrap { border-top:1px solid; border-radius:10px; height:calc(100vh - 230px) }` |
| G11 | colour wash | radial gradient, centre ≈(782,461) (50 %/45 % of the canvas), accent 7 % → transparent at 62 %; visible 500→1100 | 1501 flat #f7e7ea @35 % at (640,378) 520×420 | move/resize/type | 1501 | `x=300 y=120 width=520 height=420 fill` = radial gradient #B3123F 7 % → transparent | `.graph-canvas { background: radial-gradient(circle at 50% 45%, accent 7%, transparent 62%) }` |
| G12 | node colours | #3f86e0 #e2645a #2f9e5f #e0a53b #2fb6bd #9a5fd6 | #01488f #990707 #025e21 #6f3800 #22776d #710b94 | one shade too dark | 1502–1514 | set each stroke/fill to the эталон hex in the node table | the app's `HUES` list in `GraphView.tsx` is exactly the эталон set |
| G13 | nodes | table below | table below | — | 1502–1514 | positions/sizes per table | force layout, `r = 4 + √deg·2.6`, databases ring (r≥8), documents filled |
| G14 | edges | four faint parent edges from Team (up/left/right/down), 1 px muted ≈40 % | 3 vectors (1517 270×120, 1518 250×140, 1519 0×190), #cfccc3 1.4 | missing the down edge | 1517–1519 (+ one new) | endpoints = G13; colour #7e7d78 at 40 %, 1 px | `kind:'parent'` edges are muted at `globalAlpha .4`, `lineWidth 1` |
| G15 | footer card | (331,724) 902×35 r8, padding 8/12 | 1521 (357,729) 850×38 r8, padding 0/12 | −26,−5 902×35 | 1521 | `x=15 y=516 width=902 height=35 padding=[8,12,8,12]` | `.graph-bar` is absolute, `left/right/bottom:14px`, `padding:8px 12px` |
| G16 | footer count | ink (344,737) 101×11.5, 12/600 | ink (369.5,743) 101.5×12.5, 12.5/500 | −25.5,−6 | 1522 / 1523 | `1522 x=13 gap=16`; `1523` 12 px, weight 600 | `.graph-bar{font-size:12px;gap:16px}`, `.graph-count{font-weight:600}` |
| G17 | filed checkbox | (466,735) 13×13 **#b3123f**, 9.5 before the label | 1524 (482,739) 18×18 #1c1a15 | −16,−4 13 | 1524 | `width=13 height=13 fill=#B3123F cornerRadius=3` | accent checkbox (checked), 13 px |
| G18 | toggle label | ink (488.5,737) 156×11.5, 12 px | ink (511,743) 162.5×12.5, 12.5 px | −22.5,−6 | 1524+1526 | wrap the checkbox and the label in one horizontal frame (`gap=6`), that frame after the count with `gap=16`; label 12 px | `.graph-toggle { display:flex; gap:6px }` |
| G19 | footer hint | ink (997,737) 219×11.5, 12 px @80% | ink (961,743) 232.5×12 | +36,−6 | 1527 | text 12 px, `opacity=0.8`; position follows 1521's `padding-right=12` + spaceBetween | `.graph-hint { margin-left:auto; opacity:.8 }` |
| G20 | FAB | (1220,740) 44×44 | 2915 (1220,740) 44×44 | ✓ | 2915 | — | already aligned in `d660476` |

### Nodes and edges (frame-local)

Sizes are the visible mark, colour is the stroke (ring) or fill (dot).

| item | layer | эталон | FigCraft | Δ |
| --- | --- | --- | --- | --- |
| Systems (ring) | 1504 | (807,303.5) 19.5 ∅, #3f86e0 | (451,369) 18 ∅, #01488f | +356,−65.5 +1.5 |
| Tasks (ring) | 1506 | (898,391.5) 19.5 ∅, #e2645a | (1170,469) 18 ∅, #990707 | −272,−77.5 +1.5 |
| Team handbook (filled) | 1502 | (758,557.5) 19.5 ∅ filled #2f9e5f | (899,577) 22 ∅ ring #025e21 | −141,−19.5 −2.5 + fill |
| child above Team | — | (757,457.5) 14.5 ∅ #2f9e5f | — | missing |
| child left | 1508 | (659,571.5) 14.5 | (633,701) 14 | +26,−129.5 |
| child right | 1509 | (861.5,577.5) 14 | (1153,661) 14 | −291.5,−83.5 |
| child below | 1510 | (766,662) 14.5 | (903,711) 14 | −137,−49 |
| dot teal | 1511 | (592.5,452.5) 9 #2fb6bd | (556,474) 8 #22776d | +36.5,−21.5 +1 |
| dot purple | 1512 | (966.5,509) 9 #9a5fd6 | (1266,644) 8 #710b94 | −299.5,−135 +1 |
| dot amber | 1513 | (682,341) 9 #e0a53b | (686,394) 8 #6f3800 | −4,−53 +1 |
| dot green | 1514 | — | (816,664) 8 #025e21 | extra; remove |
| labels | 1503/1505/1507 | below the node, ink top = node centre + r + 8, 11 px, 75 % | 12 px, below the node | move with G13; fs 12→11 |

Node centre ↔ label: measured ink tops − node centres ≈ +11 (Systems 315 vs
303.5), i.e. `y + r + 8` for the label's top.

---

## 4. Already right (do not redo)

- Panel 1453 (292,8) 980×784 r16 with its shadow.
- Sidebar surface `#f0efea` (instance fill; the five white frames are gone).
  Sidebar internals are being rewritten in another session — out of scope here.
- Rainbow height (1 px) and the FAB at (1220,740).
- Sign-in card box 320×342 at (480,229), r20; wordmark and subtitle positions.
- Search modal white area 998×549 at (141,49) (only the outer border/radius is
  S1); footer rule y=550.
- Graph footer radius 8 and filter radius 7.

## 5. Priority

1. **Graph header block** G3–G10: padding 48→24, title family/size, tabs 40→30,
   filter, canvas — the largest visible drift (up to 54 px).
2. **Graph nodes + wash** G11–G14: all ten marks are in the wrong place, one
   shade too dark, Team must be filled, one edge is missing.
3. **Search header** S2–S5 + S12: handle, 78 px header, divider x=646, 17 px
   query; then the body rows (S6–S11) follow the 6 px inset and 68 px height.
4. **Search footer** S19: one 185×31 pill, not a chip plus a floating label.
5. **Sign-in stack** L5–L9: +8 px on both fields and the button, pill button,
   focus glow.
6. Cosmetics: modal radius 12, overlay 0.46, rainbow gradient/fade, preview
   open icon (S17), footer settings icon (S20).
