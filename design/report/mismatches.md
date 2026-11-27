# Design ↔ code — mismatch report

Threshold: max channel Δ > 16; zones ≥ 120px at 2x. Coordinates are 1280×800 logical pixels.

| Screen | Similar ≤16 | ≤32 | Zones | Source |
| --- | ---: | ---: | ---: | --- |
| Document | 94.67% | 95.89% | 279 | `web/src/components/Editor.tsx` |
| Collection · Table | 96.01% | 97.23% | 308 | `web/src/components/CollectionView.tsx` |
| Collection · Board | 94.93% | 96.13% | 345 | `web/src/components/CollectionView.tsx` |
| Collection · Calendar | 97.06% | 98.44% | 222 | `web/src/components/CollectionView.tsx` |
| Library · Graph | 96.87% | 98.13% | 177 | `web/src/components/GraphView.tsx` |
| Search | 95.99% | 97.32% | 189 | `web/src/components/SearchModal.tsx` |
| Sign in | 94.18% | 95.2% | 29 | `web/src/components/Login.tsx` |

## Document

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 520, 696 | 222×18 | 94.7 | `#dcdbd8` | `#d4d3d0` |
| 2 | content | 392, 507 | 174×18 | 94.7 | `#dbdad7` | `#d4d3d0` |
| 3 | content | 542, 589 | 78×30 | 129.2 | `#cbcac8` | `#cfceca` |
| 4 | content | 392, 478 | 111×20 | 107.4 | `#d8d7d5` | `#cfcecb` |
| 5 | content | 547, 537 | 156×17 | 97.5 | `#dad9d6` | `#d0cfcc` |
| 6 | content | 393, 537 | 154×16 | 95.0 | `#d8d8d5` | `#d2d1ce` |
| 7 | content | 578, 324 | 90×18 | 104.4 | `#d5d4d2` | `#cccbc7` |
| 8 | content | 448, 588 | 46×25 | 132.7 | `#c1c1bf` | `#b1b0ac` |
| 9 | content | 654, 593 | 57×26 | 124.0 | `#c2c1bf` | `#cccac7` |
| 10 | content | 385, 593 | 56×20 | 126.5 | `#b6b5b3` | `#bcbbb7` |
| 11 | content | 670, 326 | 99×14 | 99.4 | `#d4d4d1` | `#cccbc7` |
| 12 | content | 525, 666 | 108×18 | 92.5 | `#dddcd9` | `#d6d5d1` |
| 13 | content | 771, 324 | 84×18 | 105.4 | `#d8d7d5` | `#d0cfcc` |
| 14 | content | 381, 90 | 32×66 | 63.7 | `#d2d1d0` | `#d2d1cf` |
| 15 | content | 632, 666 | 88×18 | 95.4 | `#d9d8d5` | `#d2d1cd` |
| 16 | content | 420, 422 | 77×16 | 96.6 | `#d7d6d4` | `#cecdca` |
| 17 | content | 368, 478 | 19×22 | 172.1 | `#e6b7c2` | `#6d6b67` |
| 18 | content | 669, 507 | 61×16 | 92.7 | `#d1d0ce` | `#cccbc7` |
| 19 | content | 622, 594 | 30×22 | 129.3 | `#d2d1cf` | `#afaeaa` |
| 20 | content | 848, 422 | 54×16 | 97.3 | `#d2d1cf` | `#cac9c6` |

Images: `design/report/document-side.png`, `document-diff.png`.

## Collection · Table

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 582, 315 | 87×23 | 75.2 | `#eacb97` | `#ebca90` |
| 2 | content | 582, 520 | 87×23 | 75.2 | `#eacb97` | `#ebca90` |
| 3 | content | 934, 321 | 74×11 | 97.7 | `#cac9c5` | `#bebdb9` |
| 4 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 5 | content | 962, 485 | 46×11 | 98.0 | `#c3c2be` | `#bdbcb9` |
| 6 | content | 706, 320 | 53×12 | 83.4 | `#8abde0` | `#8dc0e3` |
| 7 | content | 706, 442 | 53×12 | 83.4 | `#8abde0` | `#8dc0e3` |
| 8 | content | 706, 524 | 53×12 | 83.4 | `#8abde0` | `#8dc0e3` |
| 9 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 10 | content | 959, 362 | 46×11 | 96.6 | `#c2c1bd` | `#bcbbb7` |
| 11 | content | 966, 444 | 38×11 | 101.2 | `#c5c3c0` | `#c1c0bc` |
| 12 | content | 970, 403 | 38×11 | 98.8 | `#c4c3bf` | `#c0bfbb` |
| 13 | content | 970, 526 | 38×11 | 96.3 | `#c4c3bf` | `#c0bfbb` |
| 14 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 15 | content | 850, 231 | 44×15 | 92.8 | `#e1e0dd` | `#d9dbdc` |
| 16 | topbar | 1092, 20 | 26×18 | 90.0 | `#d3d2ce` | `#e2e1dd` |
| 17 | topbar | 324, 26 | 34×12 | 98.0 | `#c9c7c4` | `#cdccc9` |
| 18 | content | 784, 234 | 38×10 | 90.5 | `#cac8c5` | `#c4c3c0` |
| 19 | content | 934, 526 | 36×11 | 96.0 | `#d2d1cd` | `#bdbcb8` |
| 20 | content | 702, 402 | 33×12 | 89.7 | `#d7b175` | `#dab478` |

Images: `design/report/table-side.png`, `table-diff.png`.

## Collection · Board

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 444, 506 | 120×22 | 85.4 | `#acd4f3` | `#d7ecf8` |
| 2 | content | 1078, 368 | 108×21 | 80.1 | `#aad3f3` | `#d2e9f8` |
| 3 | content | 778, 368 | 115×23 | 77.3 | `#b0d6f3` | `#b5d6e5` |
| 4 | content | 682, 290 | 88×24 | 68.6 | `#ecd0a1` | `#eccb93` |
| 5 | content | 366, 401 | 100×16 | 98.7 | `#f0d9cf` | `#efe2dd` |
| 6 | content | 700, 539 | 100×15 | 100.8 | `#efd7cd` | `#eee1dc` |
| 7 | content | 1034, 401 | 97×16 | 99.3 | `#f0d9d0` | `#efe4de` |
| 8 | content | 366, 676 | 100×15 | 101.1 | `#efd6cc` | `#eee1db` |
| 9 | content | 700, 401 | 82×16 | 97.7 | `#efd9d0` | `#f1e2db` |
| 10 | content | 396, 539 | 67×15 | 108.8 | `#efcfc2` | `#efddd5` |
| 11 | content | 552, 536 | 34×19 | 149.0 | `#f3f3f3` | `#a2a19f` |
| 12 | content | 348, 290 | 55×24 | 59.6 | `#f6c0b9` | `#f6b9b0` |
| 13 | content | 1016, 290 | 53×24 | 59.3 | `#b4e4c4` | `#abe4bd` |
| 14 | content | 376, 510 | 56×13 | 86.6 | `#8bbee1` | `#8ec1e3` |
| 15 | content | 710, 510 | 56×13 | 86.6 | `#8bbee1` | `#8ec1e3` |
| 16 | content | 840, 224 | 93×31 | 48.8 | `#efd8dc` | `#f2dbe0` |
| 17 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 18 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 19 | content | 880, 234 | 40×14 | 98.8 | `#ebcad1` | `#e8bac6` |
| 20 | content | 614, 538 | 14×14 | 174.8 | `#c85475` | `#ffffff` |

Images: `design/report/board-side.png`, `board-diff.png`.

## Collection · Calendar

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 390, 280 | 79×14 | 106.5 | `#b2b1ad` | `#c7c6c3` |
| 2 | content | 342, 280 | 50×14 | 111.4 | `#b5b4b0` | `#c3c2bf` |
| 3 | content | 1192, 280 | 44×12 | 111.0 | `#d2d0cd` | `#c5c4c1` |
| 4 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 5 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 6 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 7 | content | 540, 234 | 54×12 | 73.1 | `#a9a8a4` | `#a9a8a4` |
| 8 | topbar | 1092, 20 | 26×18 | 90.0 | `#d3d2ce` | `#e2e1dd` |
| 9 | content | 850, 231 | 44×15 | 88.3 | `#e1e0dd` | `#dcdad7` |
| 10 | topbar | 324, 26 | 34×12 | 98.0 | `#c9c7c4` | `#cdccc9` |
| 11 | content | 784, 234 | 38×10 | 90.5 | `#cac8c5` | `#c4c3c0` |
| 12 | content | 1108, 234 | 30×11 | 101.4 | `#cccac7` | `#c5c3c0` |
| 13 | content | 518, 159 | 55×14 | 54.0 | `#dbdad6` | `#d5d4d0` |
| 14 | content | 519, 282 | 37×13 | 97.8 | `#f6f5f2` | `#c6c5c1` |
| 15 | content | 1084, 278 | 22×17 | 84.4 | `#d8d7d3` | `#d2d1cd` |
| 16 | topbar | 1128, 20 | 24×19 | 86.8 | `#dad9d5` | `#e1e0dc` |
| 17 | content | 1189, 234 | 28×11 | 104.8 | `#575551` | `#5d5b56` |
| 18 | content | 514, 232 | 17×15 | 97.2 | `#edc9ae` | `#edccb3` |
| 19 | content | 310, 310 | 944×2 | 11.0 | `#e1e0dc` | `#ecebe7` |
| 20 | sidebar | 48, 116 | 16×16 | 100.2 | `#b1afaa` | `#b0afaa` |

Images: `design/report/calendar-side.png`, `calendar-diff.png`.

## Library · Graph

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 696, 524 | 150×116 | 72.8 | `#f2ecea` | `#f2ebea` |
| 2 | content | 364, 62 | 69×26 | 133.3 | `#b9b8b4` | `#b9b7b4` |
| 3 | content | 480, 736 | 116×14 | 83.5 | `#e8e7e6` | `#d0cfcc` |
| 4 | content | 456, 734 | 23×14 | 159.7 | `#dd96aa` | `#dfa2b1` |
| 5 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 6 | content | 659, 572 | 30×18 | 112.3 | `#c4daca` | `#d6e2d7` |
| 7 | content | 766, 654 | 18×26 | 120.5 | `#bbd8c4` | `#d0e1d3` |
| 8 | content | 854, 577 | 24×18 | 118.4 | `#b8d6c1` | `#cfdfd2` |
| 9 | content | 757, 458 | 14×40 | 132.1 | `#c4d6c7` | `#f6eeed` |
| 10 | content | 464, 128 | 73×14 | 50.7 | `#e1e0dd` | `#dad9d4` |
| 11 | content | 316, 62 | 18×18 | 114.7 | `#bfbeba` | `#cac9c6` |
| 12 | content | 1210, 69 | 25×14 | 98.3 | `#d5d4d1` | `#d0cecb` |
| 13 | content | 792, 334 | 44×12 | 78.8 | `#f7efee` | `#cbc3c2` |
| 14 | content | 329, 128 | 54×15 | 50.6 | `#dbdad7` | `#d6d5d0` |
| 15 | content | 1005, 130 | 28×13 | 90.7 | `#cbcbca` | `#d2d1cc` |
| 16 | content | 618, 736 | 27×11 | 92.9 | `#dfdfdd` | `#c1c0bc` |
| 17 | content | 1034, 130 | 31×14 | 88.3 | `#dadad9` | `#d8d7d2` |
| 18 | content | 343, 62 | 20×21 | 114.9 | `#a2a19d` | `#a3a19e` |
| 19 | content | 592, 452 | 15×15 | 147.7 | `#cbe4e4` | `#c0dfe1` |
| 20 | content | 360, 172 | 44×12 | 62.8 | `#dddddd` | `#dcdbd8` |

Images: `design/report/graph-side.png`, `graph-diff.png`.

## Search

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 144, 596 | 988×38 | 45.2 | `#9b9a98` | `#a4a39f` |
| 2 | content | 847, 212 | 108×25 | 147.3 | `#b9b8b7` | `#a3a2a0` |
| 3 | sidebar | 186, 214 | 170×12 | 115.3 | `#bfbebd` | `#b5b5b3` |
| 4 | content | 965, 212 | 67×25 | 142.2 | `#b2b1af` | `#a09f9d` |
| 5 | content | 498, 636 | 131×17 | 53.8 | `#8a8a88` | `#8b8a86` |
| 6 | content | 615, 696 | 126×18 | 56.5 | `#8f8f8e` | `#8e8c88` |
| 7 | content | 720, 666 | 110×17 | 59.7 | `#8d8d8b` | `#8c8a86` |
| 8 | sidebar | 185, 146 | 50×12 | 115.3 | `#b3b2b1` | `#b9b8b7` |
| 9 | content | 1220, 740 | 45×48 | 33.1 | `#823d4f` | `#894f5d` |
| 10 | content | 952, 278 | 53×21 | 49.4 | `#abe5be` | `#9bd5ae` |
| 11 | content | 525, 666 | 108×18 | 55.2 | `#8f8f8e` | `#8f8e8a` |
| 12 | sidebar | 164, 94 | 39×16 | 113.6 | `#cacac9` | `#cbcac9` |
| 13 | content | 642, 666 | 78×18 | 57.6 | `#8d8d8b` | `#8b8a86` |
| 14 | sidebar | 236, 146 | 40×12 | 111.9 | `#b2b1b0` | `#b8b8b6` |
| 15 | sidebar | 158, 210 | 20×20 | 125.3 | `#cccccb` | `#b3b2b1` |
| 16 | content | 536, 696 | 79×18 | 58.4 | `#8e8e8c` | `#8e8d89` |
| 17 | sidebar | 158, 142 | 20×20 | 119.2 | `#c4c4c3` | `#acacaa` |
| 18 | sidebar | 250, 164 | 87×15 | 53.3 | `#e9e9e8` | `#ebebea` |
| 19 | content | 1106, 92 | 19×19 | 136.1 | `#edc7d1` | `#e4acbb` |
| 20 | sidebar | 231, 180 | 37×16 | 86.5 | `#e8c9d2` | `#eaeaea` |

Images: `design/report/search-side.png`, `search-diff.png`.

## Sign in

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 30, 268 | 259×18 | 146.6 | `#2c2a25` | `#45433f` |
| 2 | sidebar | 30, 292 | 259×18 | 146.6 | `#464440` | `#2e2c28` |
| 3 | sidebar | 0, 0 | 320×342 | 47.0 | `#e7e5e5` | `#e7e5e4` |
| 4 | sidebar | 32, 206 | 257×8 | 70.9 | `#f5e7e8` | `#f5e9e9` |
| 5 | sidebar | 179, 106 | 25×19 | 86.1 | `#adacaa` | `#aaa9a7` |
| 6 | sidebar | 131, 282 | 24×16 | 108.6 | `#504e4a` | `#53514d` |
| 7 | sidebar | 172, 282 | 16×14 | 105.5 | `#504e4a` | `#53514d` |
| 8 | sidebar | 116, 110 | 12×15 | 91.7 | `#a5a4a2` | `#9f9f9c` |
| 9 | sidebar | 128, 110 | 12×10 | 88.3 | `#a09f9d` | `#8f8e8b` |
| 10 | sidebar | 53, 190 | 19×10 | 46.1 | `#cfcecc` | `#b1b0ac` |
| 11 | sidebar | 76, 142 | 8×12 | 63.1 | `#dad9d8` | `#d9d9d7` |
| 12 | sidebar | 234, 145 | 7×10 | 67.6 | `#d0d0ce` | `#d0cfcd` |
| 13 | sidebar | 129, 120 | 12×6 | 91.5 | `#91908e` | `#a1a09e` |
| 14 | sidebar | 68, 238 | 7×10 | 61.9 | `#d4d3d1` | `#d6d5d2` |
| 15 | sidebar | 61, 238 | 7×10 | 60.5 | `#d4d3d1` | `#d6d5d2` |
| 16 | sidebar | 53, 238 | 8×10 | 62.7 | `#cfcfcd` | `#d1d0cd` |
| 17 | sidebar | 218, 145 | 8×10 | 66.1 | `#d4d3d2` | `#d4d3d2` |
| 18 | sidebar | 202, 145 | 6×10 | 66.0 | `#d5d5d3` | `#d5d5d3` |
| 19 | sidebar | 139, 145 | 14×12 | 55.4 | `#dededd` | `#dededd` |
| 20 | sidebar | 146, 120 | 8×5 | 94.0 | `#908f8d` | `#969693` |

Images: `design/report/signin-side.png`, `signin-diff.png`.
