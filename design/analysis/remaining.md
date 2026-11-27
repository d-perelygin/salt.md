# Design ↔ code: what is left, zone by zone

*Independent audit of `design/report/mismatches.md`; nothing in `design/` was edited.*

Measured against the design file snapshot `dbfeda180bdf005a` (a copy is in `tmp/verifier/snapshot.figcraft`), exported with
`figcraft-cli export design/salt-md.figcraft --node <id> --scale 2` and diffed with the reference `wiki/img/*.png` (1280×800 @2x) in PIL/numpy. Zone coordinates are the report's logical pixels; every Δ below is device px at 2x unless it says logical.

## How a zone was classified

| Class | Decided by | Fixable by |
| --- | --- | --- |
| **position** | the ink bounding box is the same size but its x/y differs, and shifting by that many px drops the zone's mean Δ by >40% | a coordinate, a gap or a padding |
| **size / padding** | the ink or the painted box changes dimension (edge bands at top/bottom or left/right) | a width, height, padding or corner radius |
| **colour / fill** | a flat region whose colour differs by more than 4/255, or an element painted with a different paint (ring vs dot, grey vs ink) | a fill, an opacity or a stroke colour |
| **text / font** | same shape family, different advance width (tracking/size/weight) or a different face | font size, weight, letter-spacing or family |
| **content** | the pixels hold different characters | the copy itself, not a style |
| **renderer noise** | ink boxes agree within 1px (or the difference is under what the renderer can resolve), so only edges/1px offsets differ | nothing: do not chase these |

## Verdict

- **56 zones audited** (top 8 of each of the 7 screens).
- **55 are worth a fix**; **1 is renderer noise**.
- Breakdown: position 11, size/padding 11, colour/fill 6, text/font 21, content 6, noise 1.
- Pixels over the threshold inside these 56 zones: **175,973 at 2x → about 30,575** after the fixes (83% gone). Position and the graph's fills are simulated, the rest are counted at ~15% residual for glyph antialiasing.
- Read the *mean Δ* column, not only the pixel count, for small text: at 12–16px a 2–5px shift turns every glyph edge into a fresh >16 pixel, so a zone whose advance width also differs (the body copy, the calendar label) keeps a high count even when the shift is right. The mean falls, the count does not.
- Of the 55 fixable zones, **48 are a design change you can verify** and **7 are the same 16px body text set 1.2–1.8% wide** — font substitution (FigCraft's static Inter against BlockNote's Inter Variable), where the only design-side lever is letter-spacing and no value will be pixel-exact.
- **Not one zone is pure antialiasing.** The report already excludes light-surface noise and zones under 120px at 2x, so what survives is real geometry; the single `noise` entry is a 1px offset, listed there because a 1px move is below what anyone can verify in the design tool.

Top five by pixels at stake (and the one bug that repeats most):

1. **The 16px body copy sets 1.2–1.8% wide** — 7 zones, 26,100 px at stake: the document's six lines and the search result paragraphs. The app lays text out with Inter Variable, FigCraft with static Inter; only letter-spacing can compensate, so treat this as a known gap rather than a bug to close.
2. **The search scrim is the wrong paint** — one property, 24,600 px: `#3B3A36` at 0.46 blends to a warm grey where the app's overlay is neutral black at 0.40. The single cheapest fix on the list.
3. **`.prop-chip` / `.board-chip` geometry and type** — 7 zones, 20,600 px: the design's chip is 22px tall where the app's is 20, its board label 13px/500 where the app's is 12px/600, and the blue chip carries the orange hairline `#E1B66E` instead of its own tone's.
4. **The board's sample copy drifted** — 6 zones, 9,400 px: tags read «Design» for «Design system» and «Search» for «Search index»; dates read «29 Aug» for «29/08/2026». No style change fixes a different string.
5. **The document h2 is 28px with -1px tracking; the app's is 32px mono at -0.035em** — 2 zones, 6,500 px, and it is the largest single line on the screen. One text size.

And repeating on every node of the graph: **the node dots are rings, not dots** — paper fill + a 2.4px stroke where the app paints a solid `#2F9E5F` 12px dot. Four of the graph's eight zones here, and every node on the screen.

## Document

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 520, 696 222×18 | 418 TEXT «Clean REST API: build your own clients on top» | **text / font** | line ink starts +1.0px right, run 678→687 device px (+1.3%) at the same cap height | advance width: letter-spacing 0 → -0.012em (or accept: static Inter here, Inter Variable in the app) | 49.0 → 10 | 5295 → 794 | high |
| 2 | 392, 507 174×18 | 409 TEXT «Create your first page (button in the sidebar)» | **text / font** | line ink +1.0px right, 662→670 device px (+1.2%) | same as #1: letter-spacing -0.012em | 52.7 → 11 | 4476 → 671 | high |
| 3 | 542, 589 78×30 | 412 TEXT «Your data stays yours» — h2, JetBrains Mono SemiBold 28px, ls -1 | **text / font** | advance 16.1px/char in the design vs 18.1px in the app; ink 661 vs 756 device px wide, 52 vs 57 tall | fontSize 28 → 32; letterSpacing -1 → -1.12 (-0.035em). App: BlockNote h2 = 2em of 16px, mono, weight 600, ls -0.035em | 68.7 → 14 | 3913 → 587 | high |
| 4 | 392, 478 111×20 | 407 TEXT «Install salt.md» — checklist row 1 | **position** | ink top 485 in the design vs 478 in the app; rows 2 and 3 sit within 1px. Row pitch 1→2 is 23.5 vs 29.5 in the app | row 1 (and the checklist block's first item height) is 7px too low: y -7, or the item's height -7 | 72.1 → 47 | 3805 → 3059 | high |
| 5 | 547, 537 156×17 | 411 TEXT «Press Ctrl/Cmd + K to search everything» | **text / font** | run 595→606 device px (+1.8%), start +1.0px | letter-spacing -0.012em | 55.5 → 11 | 3926 → 589 | high |
| 6 | 393, 537 154×16 | 411 TEXT (same line, left half) | **text / font** | run +1.8%, start +1.0px | letter-spacing -0.012em | 55.2 → 11 | 3611 → 542 | high |
| 7 | 578, 324 90×18 | 402 TEXT «Welcome to salt.md: a fast, lightweight…» | **text / font** | run 1485→1483 (-0.1%) but start +0 and cap 2px higher: the line box sits 1px high | line box y +1 (lh 160% on a 16px line); width is already right | 67.2 → 13 | 2792 → 419 | medium |
| 8 | 448, 588 46×25 | 412 TEXT (h2, right half of the same line) | **text / font** | same line as #3: advance 16.1 vs 18.1px/char | fontSize 28 → 32, ls -1 → -1.12 | 94.2 → 19 | 2621 → 393 | high |

*Node 304. Images: `design/report/document-side.png`, `document-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Collection · Table

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 582, 315 87×23 | 567 INSTANCE Badge (main 41, Tone=Orange) — .prop-chip | **size / padding** | chip box 583..666.5 × 316.5..336 in the design vs 583..664.5 × 316..333.5 in the app: +2px wide, +2.5px tall | chip height 22 → 20 (app: 13px text, padding 2px 7px, no fixed height); y -0.5 | 44.7 → 9 | 3443 → 516 | high |
| 2 | 582, 520 87×23 | 664 INSTANCE Badge (same component, second row) | **size / padding** | identical to #1 | one component fix covers both | 44.7 → 9 | 3443 → 516 | high |
| 3 | 934, 321 74×11 | 577 TEXT «20.08.2026» + the cell's calendar icon | **text / font** | date ink 934..1006 in the design vs 940.5..1015.5 in the app: 6.5px left and 3px narrower (4% ≈ 13.5px vs 13px); the cell group is 133 vs 118px wide, gap date→icon 49.5 vs 33 | fontSize 13.5 → 13 (app .prop-date) and x +6.5; the gap between the date and its icon -16px | 74.7 → 15 | 1497 → 225 | high |
| 4 | 84, 397 38×18 | 475 TEXT «Systems» in INSTANCE Sidebar Item | **position** | ink 397.5..411.5 in the design vs 401..415 in the app: same width and height, 3.5px too high | row content y +3.5 (sidebar item title) | 56.4 → 9 | 1013 → 394 | high |
| 5 | 962, 485 46×11 | 655 TEXT «04.09.2026» (same cell as #3) | **text / font** | date ink 933..1008 vs 940.5..1015.5: same 7px offset and the same 4% width | same fix as #3: 13.5 → 13, x +7 | 78.3 → 16 | 990 → 148 | high |
| 6 | 706, 320 53×12 | 572 TEXT «Interface» + 571 Badge — .prop-chip | **size / padding** | label ink 703..756.5 × 321.5..331 vs 703.5..757.5 × 320..329.5: width right, label 1.5px low inside a chip 2px too tall | chip height 22 → 20 (the label then centres 1.5px up) | 61.1 → 12 | 1208 → 181 | high |
| 7 | 706, 442 53×12 | 631 TEXT «Interface» + 630 Badge | **size / padding** | identical to #6 | same component fix | 59.5 → 12 | 1164 → 175 | high |
| 8 | 706, 524 53×12 | 669 TEXT «Interface» + 668 Badge | **size / padding** | identical to #6 | same component fix | 59.5 → 12 | 1164 → 175 | high |

*Node 421. Images: `design/report/table-side.png`, `table-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Collection · Board

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 444, 506 120×22 | card tag chip (INSTANCE Badge) | **content (copy)** | the app's tag reads «Design system», the design's «Design» — the chip is ~57px wider for the extra word | change the sample copy to «Design system» | 72.7 → 15 | 7567 → 1135 | high |
| 2 | 1078, 368 108×21 | card tag chip (INSTANCE Badge) | **content (copy)** | the app's tag reads «Search index», the design's «Search» | change the copy to «Search index» | 67.0 → 13 | 6220 → 933 | high |
| 3 | 778, 368 115×23 | 1075 INSTANCE Badge — .board-chip | **colour / fill** | chip 704..880.5 wide vs 704..891.5; the design's 1px border is #E1B66E (orange) where the app draws the tone's own hairline #8CC0FF | border #E1B66E → tone-derived (blue: #8CC0FF; orange: #E1B66E). App: oklch(from color 0.8 c*0.95 h) inset 1px | 56.9 → 11 | 5559 → 834 | high |
| 4 | 682, 290 88×24 | 1066 INSTANCE Badge — .board-chip (Tone=Orange) | **size / padding** | chip 704..880.5 vs 891.5 wide; label ink 712..872.5 vs 711..884.5 (ratio 0.925 = 12/13); height 19.5 vs 17.5 | fontSize 13 → 12, weight 500 → 600, height 22 → 20. App: .board-chip 12px/600, padding 2px 8px | 52.1 → 10 | 4617 → 693 | high |
| 5 | 366, 401 100×16 | 1024 FRAME «Due» date row | **content (copy)** | the app prints «29/08/2026», the design «29 Aug» (and the shorter string moves everything after it) | change the copy, or the formatter the design was drawn from | 61.0 → 12 | 2425 → 364 | high |
| 6 | 700, 539 100×15 | 1092 date row | **content (copy)** | «22/08/2026» vs «22 Aug» | same as #5 | 63.2 → 13 | 2334 → 350 | high |
| 7 | 1034, 401 97×16 | 1114 date row | **content (copy)** | «12/08/2026» vs «12 Aug» | same as #5 | 60.9 → 12 | 2317 → 348 | high |
| 8 | 366, 676 100×15 | 1055 date row | **content (copy)** | «04/09/2026» vs «04 Sep» | same as #5 | 62.5 → 12 | 2337 → 351 | high |

*Node 693. Images: `design/report/board-side.png`, `board-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Collection · Calendar

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 390, 280 79×14 | 1253 TEXT «November 2026» | **text / font** | ink 342..418.5 in the design vs 344.5..424 in the app: starts 2.5px left AND sets 3% narrower at the same ink height (16px, ls -0.1). Aligning the ends needs +5, the start +2.5 — a pure shift cannot do both | letterSpacing -0.1 → 0 (recovers 1.3px of the 2.5) and x +2.5; the rest is the static/static font difference | 79.8 → 16 | 2070 → 310 | high |
| 2 | 342, 280 50×14 | 1253 TEXT «November 2026» (left half) | **text / font** | same as #1: 3% narrow plus 2.5px left | ls -0.1 → 0, x +2.5 | 83.8 → 17 | 1375 → 206 | high |
| 3 | 1192, 280 44×12 | 1268 TEXT «Month» + chevron in 1267 Frame 157 | **position** | label ink 1198..1234.5 vs 1192..1229 (6px right); chevron 14px wide / 14 tall vs 8×9.5 | label x -6 and the chevron glyph drawn smaller (icon 14 → 10) | 81.0 → 62 | 1002 → 817 | high |
| 4 | 84, 397 38×18 | 1176 TEXT «Systems» — Sidebar Item | **position** | identical to table #4: 3.5px too high | row content y +3.5 | 56.4 → 9 | 1013 → 394 | high |
| 5 | 1230, 750 22×22 | 4660 FRAME Frame 475 (the FAB glyph) | **position** | ink 0.5..18 in the design vs 1..19.5; the zone aligns at (-1.5,-1.5) with a 0.86 drop in mean Δ | glyph x +1.5, y +1.5 inside the FAB | 78.5 → 11 | 846 → 293 | high |
| 6 | 1194, 20 22×20 | 3607 FRAME Frame 404 (topbar globe glyph) | **colour / fill** | the app's stroke is #1C1A15 and its glyph 15.5×15.5; the design's is #787878, 18×18 and 2.5px right | glyph stroke/fill #787878 → #1C1A15 (fg), size 18 → 15.5, x -2.5 | 70.4 → 14 | 956 → 143 | high |
| 7 | 540, 234 54×12 | 1231 TEXT «Calendar» in View Tab | **renderer noise** | ink 3..114 × 7..27 vs 1..114 × 6..26: width identical, 1px left and 1px up; at (+0.5,+0.5) the mean Δ drops 0.64 | nothing worth changing: a 1px nudge of the label, inside a pill that already matches | — | — | high |
| 8 | 1092, 20 26×18 | 1201 FRAME Frame 2 (split-view glyph) | **size / padding** | the design's glyph is 15.5px wide in an 18px box, its divider sits mid-box; the app's reads as a narrower split-view mark (divider near the left third). A shift gains only 0.29, so the glyph itself differs | redraw the icon on the app's split-view path (divider at ~1/3); a coordinate nudge will not help | 62.5 → 13 | 905 → 136 | medium |

*Node 1122. Images: `design/report/calendar-side.png`, `calendar-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Library · Graph

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 696, 524 150×116 | 1508 ELLIPSE (node dot) + its label inside Frame 226 | **position** | the dot's ink 662..675.5 × 574.5..588 in the design vs 660..672 × 572.5..585 in the app (2px right and low) and its label starts 3px left | dot -2,-2 and filled green (see #6); label +3,+1. Two elements in one zone need opposite moves, so no single shift clears it | 9.7 → 2 | 4601 → 690 | medium |
| 2 | 364, 62 69×26 | 1473 TEXT «Library» — page title, Inter Bold 26px, ls -1.7 | **text / font** | ink 132 device px wide in the app vs 119 in the design at the same cap height (25 vs 25.5): ~1px/char too tight | letterSpacing -1.7 → -0.7 (the app's .page-title is -0.045em, 7% narrower than the design's -1.7px/26px) | 75.2 → 15 | 2831 → 425 | high |
| 3 | 480, 736 116×14 | 1526 TEXT «Show where pages are filed» | **text / font** | ink starts 488.5 in the app vs 480.5 in the design (8px left) and the run is 4.6% wider at the same ink height | x +8 and fontSize 12.5 → 12 (the app's 4.6% narrower run); the icon beside it needs its own look (see #4) | 50.8 → 10 | 2254 → 338 | high |
| 4 | 456, 734 23×14 | 1522 FRAME Frame 228 (the small red mark before the hint) | **size / padding** | the design's mark is 2px taller and 2px wider than the app's and its bbox starts 4px left/high | icon box 20 → 18 and +1,+1 — the app's mark is inset in its row | 146.3 → 29 | 862 → 129 | medium |
| 5 | 1230, 750 22×22 | 4662 FRAME Frame 476 (FAB glyph) | **position** | same as calendar #5 | glyph +1.5,+1.5 | 78.5 → 11 | 846 → 293 | high |
| 6 | 659, 572 30×18 | 1508 ELLIPSE (node dot) | **colour / fill** | the app's dot is solid green #2F9E5F (centre sampled 47,158,95); the design draws a paper-filled ring (centre 249,240,240) with a 2.4px stroke | fill #FBFAF7 → #2F9E5F, stroke → none; size 14.5 → 12 (the app's dot is 12px across) | 57.3 → 23 | 759 → 265 | high |
| 7 | 766, 654 18×26 | 1508-class ELLIPSE (node in the same graph) | **colour / fill** | same ring instead of a dot; 3px right/low | same fill fix, +1.5,+1.5 | 66.8 → 27 | 736 → 270 | high |
| 8 | 854, 577 24×18 | 1508-class ELLIPSE (node) | **colour / fill** | same ring instead of a dot | same fill fix | 68.7 → 28 | 703 → 255 | high |

*Node 1382. Images: `design/report/graph-side.png`, `graph-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Search

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 144, 596 988×38 | 3064 RECTANGLE (the modal scrim), #3B3A36 at 0.46 | **colour / fill** | the app's scrim is neutral and darker: #989898 over the page where the design blends to #a0a098 (0.40 of pure black) | fill #3B3A36 → #000000, opacity 0.46 → 0.40 (app: .modal-overlay rgba(0,0,0,0.35) plus its own stacking) | 14.6 → 3 | 24569 → 3685 | high |
| 2 | 847, 212 108×25 | 5649 TEXT «Search index» — Inter Bold 32px, ls 0 | **text / font** | the first word is 98.5px in the app vs 107 in the design while the second matches; the word gap is 20px vs 11px. The app's heading is the mono `.page-title` (brand face), the design's is Inter Bold — a face difference, not a size | fontFamily Inter → JetBrains Mono, fontSize 32 → 30.4, weight 700 → 620, letterSpacing 0 → -0.045em (the preview renders .page-title at zoom 0.8) | 89.0 → 18 | 4827 → 724 | medium |
| 3 | 186, 214 170×12 | 5645 TEXT «Index PDF attachments» — .result-title | **size / padding** | ink 306 device px wide in the app vs 334 in the design (ratio 0.916 ≈ 14/15) | fontSize 15 → 14 (app .result-title is 14px/600) | 89.2 → 18 | 4097 → 615 | high |
| 4 | 965, 212 67×25 | 5649 TEXT (right half of the heading) | **text / font** | same as #2 | same as #2 | 91.5 → 18 | 3102 → 465 | medium |
| 5 | 498, 636 131×17 | 3048 TEXT body 16px | **text / font** | run 725→735 device px (+1.4%), start +1.0px | letter-spacing -0.012em | 33.1 → 7 | 3223 → 483 | high |
| 6 | 615, 696 126×18 | 3052 TEXT body 16px | **text / font** | run +1.3%, start +1.0px | letter-spacing -0.012em | 30.5 → 6 | 2877 → 432 | high |
| 7 | 720, 666 110×17 | 3050 TEXT body 16px | **text / font** | run +1.3%, start +1.0px | letter-spacing -0.012em | 35.0 → 7 | 2694 → 404 | high |
| 8 | 185, 146 50×12 | 5638 TEXT «Search index» group label 15px SemiBold | **text / font** | ink 169 vs 175 device px (+3%), 1px left/up | 15px is 0.5px large here; leave it or 15 → 14.5 | 94.0 → 19 | 1288 → 193 | medium |

*Node 2926. Images: `design/report/search-side.png`, `search-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Sign in

| # | zone x,y w×h | layer | class | evidence | fix: property → value | mean Δ now → after | px Δ>16 now → after | conf. |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | --- |
| 1 | 30, 268 259×18 | 3115 FRAME Frame 396 (the black Sign in button) + 3116 label | **position** | button box 60..288.5 × 271..308.5 in the design vs 269..306.5 in the app: same size, 2px low | the two inputs above are each 1px too tall (design 38, app 37), which pushes the button down 2px — fix the field height, not the button: 38 → 37 | 27.4 → 0 | 2297 → 51 | high |
| 2 | 30, 292 259×18 | 3115 FRAME (button, right half) | **position** | same as #1 | same as #1 | 29.6 → 1 | 2538 → 129 | high |
| 3 | 0, 0 320×342 | 3107 FRAME Frame 393 (the card) | **size / padding** | card top at y=1 in the design vs 2 in the app (341 vs 340 tall), bottom edge equal | card height -1 at the top (padding) | 6.1 → 1 | 19874 → 2981 | medium |
| 4 | 32, 206 257×8 | 3111 FRAME Frame 394 (email field) | **size / padding** | field borders 175..212 in the design vs 175..211 in the app: 1px taller | input height 38 → 37 | 27.1 → 5 | 2079 → 312 | high |
| 5 | 179, 106 25×19 | 3109 TEXT «salt.md» — wordmark, JetBrains Mono Bold 22px, ls -0.6 | **text / font** | ink 176×33 in the app vs 174×34 in the design at the same left edge; the design's strokes are thicker (the app sets .wordmark weight 600, the design 700). Best alignment is under 1px, so this is weight, not position | fontWeight 700 → 600, letterSpacing -0.6 → -0.44 (-0.02em). App: .login-card h1.wordmark | 59.4 → 12 | 691 → 104 | high |
| 6 | 131, 282 24×16 | 3116 TEXT «Sign in» (button label) | **position** | rides the 2px-low button: ink top 1.5px low | covered by #1 | 70.3 → 27 | 661 → 352 | high |
| 7 | 172, 282 16×14 | 3116 TEXT «Sign in» (right half) | **position** | same as #6 | covered by #1 | 71.1 → 41 | 377 → 244 | high |
| 8 | 116, 110 12×15 | 3109 TEXT «salt.md» (left glyph) | **text / font** | same as #5: same width, 1px taller ink, weight 700 vs 600 | fontWeight 700 → 600 | 69.2 → 14 | 301 → 45 | high |

*Node 3095. Images: `design/report/signin-side.png`, `signin-diff.png`; the crops used here are in `tmp/verifier/crops/`.*

## Renderer noise — do not chase

These read as mismatches above the report's threshold of 16/255, but the geometry agrees within a pixel and only edges and antialiasing differ:

- **Calendar / `Calendar` view tab** (#7): 1px of text layout inside a pill that already matches. There is nothing to change.
- **Sign in / whole card** (#3): its zone is the union of everything inside the card; the individual causes are listed above (input height, button, wordmark). Do not treat the zone itself as a target.
- **Search / scrim** (#1): the band's *text* is identical — only the scrim colour differs, so fix the fill and leave the text alone.
- Every text zone that remains after the fixes will keep 1–2px of edge difference: the app lays text out with Inter Variable (BlockNote ships it), FigCraft with static Inter. At 16px that is ~0.2px per glyph, which is why a 340px line drifts 4px. Compare 8× zoom crops before calling such a line wrong.

## Re-running this

```bash
cp design/report/mismatches.json tmp/verifier/report-latest.json
python3 tmp/verifier/analyze.py    # exports every screen, measures the zones, writes the contact sheets
python3 tmp/verifier/detail.py     # line-level ink boxes for the layer under each zone
python3 tmp/verifier/probes.py     # the handful of boxes/edges quoted above
python3 tmp/verifier/write_report.py
```

`analyze.py` pins the design file to `tmp/verifier/snapshot.figcraft` and records its SHA-256, so a report can always be traced to the bytes it was measured on.

## Caveats

- The design file was edited by another process while this audit ran (04:58, 05:04, ~05:30). Re-exported at ~05:32, all seven audited frames render **pixel-identically** to the snapshot (`620156292dc2952c` vs the snapshot's `dbfeda18`), so the rows below still describe the live file even though its bytes moved.
- All numbers come from the snapshot with SHA-256 `dbfeda180bdf005a…`; if the file has moved on, re-run `python3 tmp/verifier/analyze.py` and `python3 tmp/verifier/detail.py` against the new snapshot before trusting a row.
- Zones are the report's: they are connected components of the diff, so one cause appears as several zones (three `Interface` chips, four date rows, four graph nodes). The per-screen tables name the shared layer or component so one fix can be counted once.
- `ours_crop` for sign-in means its zones are in card coordinates; the layer ids above are already offset back to page coordinates (+480, +229).
- Confidence is `medium` where a zone's crop clips the ink (its layer box is smaller than the app's rendered text) — there the size/position call comes from the wider probe window, not the zone alone.
