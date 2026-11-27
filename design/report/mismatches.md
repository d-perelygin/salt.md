# Design ↔ code — mismatch report

Threshold: max channel Δ > 16; zones ≥ 120px at 2x. Coordinates are 1280×800 logical pixels.

| Screen | Similar ≤16 | ≤32 | Zones | Source |
| --- | ---: | ---: | ---: | --- |
| Document | 94.59% | 95.8% | 272 | `web/src/components/Editor.tsx` |
| Collection · Table | 95.86% | 97.08% | 308 | `web/src/components/CollectionView.tsx` |
| Collection · Board | 94.77% | 95.98% | 348 | `web/src/components/CollectionView.tsx` |
| Collection · Calendar | 97.04% | 98.41% | 221 | `web/src/components/CollectionView.tsx` |
| Library · Graph | 96.83% | 98.1% | 180 | `web/src/components/GraphView.tsx` |
| Search | 95.94% | 97.28% | 189 | `web/src/components/SearchModal.tsx` |
| Sign in | 93.45% | 94.46% | 32 | `web/src/components/Login.tsx` |

## Document

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 370, 374 | 108×31 | 117.8 | `#cbcac8` | `#c6c5c2` |
| 2 | content | 520, 696 | 222×18 | 94.7 | `#dcdbd8` | `#d4d3d0` |
| 3 | content | 392, 507 | 174×18 | 94.7 | `#dbdad7` | `#d4d3d0` |
| 4 | content | 542, 589 | 78×30 | 129.2 | `#cbcac8` | `#cfceca` |
| 5 | content | 392, 478 | 111×20 | 107.4 | `#d8d7d5` | `#cfcecb` |
| 6 | content | 547, 537 | 156×17 | 97.5 | `#dad9d6` | `#d0cfcc` |
| 7 | content | 393, 537 | 154×16 | 95.0 | `#d8d8d5` | `#d2d1ce` |
| 8 | content | 654, 374 | 58×26 | 137.3 | `#bfbebc` | `#c6c4c1` |
| 9 | content | 578, 324 | 90×18 | 104.4 | `#d5d4d2` | `#cccbc7` |
| 10 | content | 448, 588 | 46×25 | 132.7 | `#c1c1bf` | `#b1b0ac` |
| 11 | content | 654, 593 | 57×26 | 124.0 | `#c2c1bf` | `#cccac7` |
| 12 | content | 385, 593 | 56×20 | 126.5 | `#b6b5b3` | `#bcbbb7` |
| 13 | content | 670, 326 | 99×14 | 99.4 | `#d4d4d1` | `#cccbc7` |
| 14 | content | 525, 666 | 108×18 | 92.5 | `#dddcd9` | `#d6d5d1` |
| 15 | content | 771, 324 | 84×18 | 105.4 | `#d8d7d5` | `#d0cfcc` |
| 16 | content | 381, 90 | 32×66 | 63.7 | `#d2d1d0` | `#d2d1cf` |
| 17 | content | 632, 666 | 88×18 | 95.4 | `#d9d8d5` | `#d2d1cd` |
| 18 | content | 420, 422 | 77×16 | 96.6 | `#d7d6d4` | `#cecdca` |
| 19 | content | 368, 478 | 19×22 | 172.1 | `#e6b7c2` | `#6d6b67` |
| 20 | content | 669, 507 | 61×16 | 92.7 | `#d1d0ce` | `#cccbc7` |

Images: `design/report/document-side.png`, `document-diff.png`.

## Collection · Table

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 1152, 224 | 74×31 | 158.4 | `#5c5a56` | `#34322e` |
| 2 | content | 578, 314 | 88×22 | 68.0 | `#eacb96` | `#eed09d` |
| 3 | content | 578, 520 | 88×22 | 68.0 | `#eacb96` | `#eed09d` |
| 4 | content | 690, 520 | 126×22 | 56.6 | `#c6d3cf` | `#ccd8d2` |
| 5 | content | 934, 321 | 74×11 | 97.7 | `#cac9c5` | `#bebdb9` |
| 6 | content | 690, 396 | 91×22 | 52.4 | `#edc9c3` | `#f1cfc8` |
| 7 | content | 702, 320 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 8 | content | 702, 442 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 9 | content | 702, 524 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 10 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 11 | content | 962, 485 | 46×11 | 98.0 | `#c3c2be` | `#bdbcb9` |
| 12 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 13 | content | 959, 362 | 46×11 | 96.6 | `#c2c1bd` | `#bcbbb7` |
| 14 | content | 966, 444 | 38×11 | 101.2 | `#c5c3c0` | `#c1c0bc` |
| 15 | content | 970, 403 | 38×11 | 98.8 | `#c4c3bf` | `#c0bfbb` |
| 16 | content | 970, 526 | 38×11 | 96.3 | `#c4c3bf` | `#c0bfbb` |
| 17 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 18 | content | 690, 314 | 76×22 | 48.5 | `#add5f0` | `#b4dbf1` |
| 19 | content | 690, 438 | 76×22 | 48.5 | `#add5f0` | `#b4dbf1` |
| 20 | content | 850, 231 | 44×15 | 92.8 | `#e1e0dd` | `#d9dbdc` |

Images: `design/report/table-side.png`, `table-diff.png`.

## Collection · Board

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 364, 504 | 200×23 | 78.9 | `#b2d7f3` | `#cde7f6` |
| 2 | content | 1032, 368 | 154×22 | 78.7 | `#c1d2f4` | `#dde2f7` |
| 3 | content | 698, 368 | 195×22 | 68.8 | `#afd6f2` | `#b6dcf2` |
| 4 | content | 682, 290 | 88×23 | 65.4 | `#ebcf9e` | `#edd09c` |
| 5 | content | 390, 401 | 78×14 | 105.1 | `#efcdc0` | `#eedbd3` |
| 6 | content | 724, 401 | 78×14 | 104.3 | `#efcec0` | `#eedcd4` |
| 7 | content | 543, 534 | 44×19 | 144.0 | `#f0f0f0` | `#b6b6b4` |
| 8 | content | 1152, 224 | 72×31 | 157.3 | `#575651` | `#35332e` |
| 9 | content | 698, 504 | 125×23 | 60.5 | `#c8d5d1` | `#cedad5` |
| 10 | content | 1016, 290 | 53×23 | 60.6 | `#b2e4c2` | `#b3e7c3` |
| 11 | content | 348, 290 | 55×23 | 58.9 | `#f6bfb7` | `#f5c0b8` |
| 12 | content | 390, 676 | 50×14 | 114.0 | `#edc9ba` | `#f1d4c8` |
| 13 | content | 724, 538 | 49×14 | 104.6 | `#eecabc` | `#f1d3c7` |
| 14 | content | 390, 539 | 46×13 | 107.9 | `#edc8b8` | `#f0d2c5` |
| 15 | content | 1058, 401 | 47×14 | 102.3 | `#efcdbf` | `#f2d6cb` |
| 16 | content | 364, 368 | 90×22 | 54.7 | `#edc9c3` | `#f2cec8` |
| 17 | content | 376, 509 | 56×14 | 78.9 | `#8ec0e3` | `#95c6e7` |
| 18 | content | 710, 509 | 56×14 | 78.9 | `#8ec0e3` | `#95c6e7` |
| 19 | content | 840, 224 | 93×31 | 48.8 | `#efd8dc` | `#f2dbe0` |
| 20 | content | 710, 372 | 56×13 | 79.7 | `#8abde1` | `#92c4e5` |

Images: `design/report/board-side.png`, `board-diff.png`.

## Collection · Calendar

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 390, 280 | 79×14 | 106.5 | `#b2b1ad` | `#c7c6c3` |
| 2 | content | 1152, 224 | 72×31 | 157.3 | `#575651` | `#35332e` |
| 3 | content | 342, 280 | 50×14 | 111.4 | `#b5b4b0` | `#c3c2bf` |
| 4 | content | 1192, 280 | 44×12 | 111.0 | `#d2d0cd` | `#c5c4c1` |
| 5 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 6 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 7 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 8 | content | 540, 234 | 54×12 | 73.1 | `#a9a8a4` | `#a9a8a4` |
| 9 | topbar | 1092, 20 | 26×18 | 90.0 | `#d3d2ce` | `#e2e1dd` |
| 10 | content | 850, 231 | 44×15 | 88.3 | `#e1e0dd` | `#dcdad7` |
| 11 | topbar | 324, 26 | 34×12 | 98.0 | `#c9c7c4` | `#cdccc9` |
| 12 | content | 784, 234 | 38×10 | 90.5 | `#cac8c5` | `#c4c3c0` |
| 13 | content | 1108, 234 | 30×11 | 101.4 | `#cccac7` | `#c5c3c0` |
| 14 | content | 518, 159 | 55×14 | 54.0 | `#dbdad6` | `#d5d4d0` |
| 15 | content | 519, 282 | 37×13 | 97.8 | `#f6f5f2` | `#c6c5c1` |
| 16 | content | 1186, 234 | 26×11 | 111.5 | `#5a5954` | `#605e5a` |
| 17 | content | 1084, 278 | 22×17 | 84.4 | `#d8d7d3` | `#d2d1cd` |
| 18 | topbar | 1128, 20 | 24×19 | 86.8 | `#dad9d5` | `#e1e0dc` |
| 19 | content | 514, 232 | 17×15 | 97.2 | `#edc9ae` | `#edccb3` |
| 20 | content | 310, 310 | 944×2 | 11.0 | `#e1e0dc` | `#ecebe7` |

Images: `design/report/calendar-side.png`, `calendar-diff.png`.

## Library · Graph

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 696, 524 | 150×108 | 78.0 | `#f1ebe9` | `#f3f4f0` |
| 2 | content | 364, 62 | 69×26 | 133.3 | `#b9b8b4` | `#b9b7b4` |
| 3 | content | 480, 736 | 116×14 | 83.5 | `#e8e7e6` | `#d0cfcc` |
| 4 | content | 456, 734 | 23×14 | 159.7 | `#dd96aa` | `#dfa2b1` |
| 5 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 6 | content | 659, 572 | 28×18 | 115.5 | `#c0d9c7` | `#d5e8da` |
| 7 | content | 757, 458 | 14×40 | 136.7 | `#c4d6c7` | `#f8f7f4` |
| 8 | content | 854, 577 | 25×18 | 119.2 | `#b9d6c2` | `#d1e6d7` |
| 9 | content | 766, 660 | 18×20 | 126.7 | `#a9d1b8` | `#c5e0ce` |
| 10 | content | 464, 128 | 73×14 | 50.7 | `#e1e0dd` | `#dad9d4` |
| 11 | content | 316, 62 | 18×18 | 114.7 | `#bfbeba` | `#cac9c6` |
| 12 | content | 1210, 69 | 25×14 | 98.3 | `#d5d4d1` | `#d0cecb` |
| 13 | content | 792, 334 | 44×12 | 82.5 | `#f7efee` | `#cccbc8` |
| 14 | content | 329, 128 | 54×15 | 50.6 | `#dbdad7` | `#d6d5d0` |
| 15 | content | 1005, 130 | 28×13 | 90.7 | `#cbcbca` | `#d2d1cc` |
| 16 | content | 618, 736 | 27×11 | 92.9 | `#dfdfdd` | `#c1c0bc` |
| 17 | content | 1034, 130 | 31×14 | 88.3 | `#dadad9` | `#d8d7d2` |
| 18 | content | 592, 452 | 15×15 | 149.4 | `#cbe4e4` | `#c1e6e6` |
| 19 | content | 343, 62 | 20×21 | 114.9 | `#a2a19d` | `#a3a19e` |
| 20 | content | 360, 172 | 44×12 | 62.8 | `#dddddd` | `#dcdbd8` |

Images: `design/report/graph-side.png`, `graph-diff.png`.

## Search

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 144, 596 | 988×38 | 45.2 | `#9b9a98` | `#a4a39f` |
| 2 | content | 847, 208 | 108×28 | 153.6 | `#bfbfbd` | `#acaba9` |
| 3 | content | 965, 208 | 78×28 | 156.0 | `#bbbab9` | `#a9a9a7` |
| 4 | sidebar | 186, 214 | 170×12 | 115.3 | `#bfbebd` | `#b5b5b3` |
| 5 | content | 498, 636 | 131×17 | 53.8 | `#8a8a88` | `#8b8a86` |
| 6 | content | 615, 696 | 126×18 | 56.5 | `#8f8f8e` | `#8e8c88` |
| 7 | content | 720, 666 | 110×17 | 59.7 | `#8d8d8b` | `#8c8a86` |
| 8 | content | 1220, 740 | 45×48 | 33.1 | `#823d4f` | `#894f5d` |
| 9 | content | 952, 278 | 53×21 | 47.7 | `#abe5be` | `#9dd6b0` |
| 10 | content | 525, 666 | 108×18 | 55.2 | `#8f8f8e` | `#8f8e8a` |
| 11 | sidebar | 164, 94 | 39×16 | 113.6 | `#cacac9` | `#cbcac9` |
| 12 | content | 642, 666 | 78×18 | 57.6 | `#8d8d8b` | `#8b8a86` |
| 13 | sidebar | 158, 210 | 20×20 | 125.3 | `#cccccb` | `#b3b2b1` |
| 14 | content | 536, 696 | 79×18 | 58.4 | `#8e8e8c` | `#8e8d89` |
| 15 | sidebar | 158, 142 | 20×20 | 119.2 | `#c4c4c3` | `#acacaa` |
| 16 | sidebar | 250, 164 | 87×15 | 53.3 | `#e9e9e8` | `#ebebea` |
| 17 | content | 1106, 92 | 19×19 | 136.1 | `#edc7d1` | `#e4acbb` |
| 18 | sidebar | 240, 146 | 34×12 | 113.1 | `#b0afae` | `#b1b1af` |
| 19 | sidebar | 231, 180 | 37×16 | 86.5 | `#e8c9d2` | `#eaeaea` |
| 20 | sidebar | 186, 248 | 35×16 | 86.6 | `#efcfd8` | `#e9e9e8` |

Images: `design/report/search-side.png`, `search-diff.png`.

## Sign in

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 132, 34 | 57×56 | 134.9 | `#dfdfde` | `#cbcac9` |
| 2 | sidebar | 30, 268 | 259×18 | 146.6 | `#2c2a25` | `#45433f` |
| 3 | sidebar | 30, 292 | 259×18 | 146.6 | `#464440` | `#2e2c28` |
| 4 | sidebar | 0, 0 | 320×342 | 47.0 | `#e7e5e5` | `#e6e5e4` |
| 5 | sidebar | 32, 206 | 257×8 | 70.9 | `#f5e7e8` | `#f5e9e9` |
| 6 | sidebar | 179, 106 | 25×19 | 86.1 | `#adacaa` | `#aaa9a7` |
| 7 | sidebar | 131, 282 | 24×16 | 108.6 | `#504e4a` | `#53514d` |
| 8 | sidebar | 144, 68 | 10×24 | 123.6 | `#b9b8b6` | `#c1c0bf` |
| 9 | sidebar | 172, 282 | 16×14 | 105.5 | `#504e4a` | `#53514d` |
| 10 | sidebar | 116, 110 | 12×15 | 91.7 | `#a5a4a2` | `#9f9f9c` |
| 11 | sidebar | 151, 60 | 18×5 | 90.6 | `#a1a09e` | `#969593` |
| 12 | sidebar | 128, 110 | 12×10 | 88.3 | `#a09f9d` | `#8f8e8b` |
| 13 | sidebar | 53, 190 | 19×10 | 46.1 | `#cfcecc` | `#b1b0ac` |
| 14 | sidebar | 76, 142 | 8×12 | 63.1 | `#dad9d8` | `#d9d9d7` |
| 15 | sidebar | 234, 145 | 7×10 | 67.6 | `#d0d0ce` | `#d0cfcd` |
| 16 | sidebar | 129, 120 | 12×6 | 91.5 | `#91908e` | `#a1a09e` |
| 17 | sidebar | 68, 238 | 7×10 | 61.9 | `#d4d3d1` | `#d6d5d2` |
| 18 | sidebar | 61, 238 | 7×10 | 60.5 | `#d4d3d1` | `#d6d5d2` |
| 19 | sidebar | 53, 238 | 8×10 | 62.7 | `#cfcfcd` | `#d1d0cd` |
| 20 | sidebar | 218, 145 | 8×10 | 66.1 | `#d4d3d2` | `#d4d3d2` |

Images: `design/report/signin-side.png`, `signin-diff.png`.
