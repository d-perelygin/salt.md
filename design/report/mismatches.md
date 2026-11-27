# Design ↔ code — mismatch report

Threshold: max channel Δ > 16; zones ≥ 120px at 2x. Coordinates are 1280×800 logical pixels.

| Screen | Similar ≤16 | ≤32 | Zones | Source |
| --- | ---: | ---: | ---: | --- |
| Document | 93.56% | 95.34% | 281 | `web/src/components/Editor.tsx` |
| Collection · Table | 93.91% | 96.19% | 336 | `web/src/components/CollectionView.tsx` |
| Collection · Board | 88.2% | 93.52% | 393 | `web/src/components/CollectionView.tsx` |
| Collection · Calendar | 89.11% | 97.32% | 312 | `web/src/components/CollectionView.tsx` |
| Library · Graph | 92.2% | 97.28% | 287 | `web/src/components/GraphView.tsx` |
| Search | 90.04% | 95.87% | 205 | `web/src/components/SearchModal.tsx` |
| Sign in | 89.71% | 91.2% | 34 | `web/src/components/Login.tsx` |

## Document

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 338, 792 | 887×8 | 29.0 | `#d3d2cd` | `#f0efea` |
| 2 | content | 370, 374 | 108×31 | 117.8 | `#cbcac8` | `#c6c5c2` |
| 3 | content | 520, 696 | 222×18 | 94.7 | `#dcdbd8` | `#d4d3d0` |
| 4 | content | 392, 507 | 174×18 | 94.7 | `#dbdad7` | `#d4d3d0` |
| 5 | content | 542, 589 | 78×30 | 129.2 | `#cbcac8` | `#cfceca` |
| 6 | content | 392, 478 | 111×20 | 107.4 | `#d8d7d5` | `#cfcecb` |
| 7 | content | 547, 537 | 156×17 | 97.5 | `#dad9d6` | `#d0cfcc` |
| 8 | content | 393, 537 | 154×16 | 95.0 | `#d8d8d5` | `#d2d1ce` |
| 9 | content | 654, 374 | 58×26 | 137.3 | `#bfbebc` | `#c6c4c1` |
| 10 | content | 578, 324 | 90×18 | 104.4 | `#d5d4d2` | `#cccbc7` |
| 11 | content | 448, 588 | 46×25 | 132.7 | `#c1c1bf` | `#b1b0ac` |
| 12 | content | 654, 593 | 57×26 | 124.0 | `#c2c1bf` | `#cccac7` |
| 13 | content | 385, 593 | 56×20 | 126.5 | `#b6b5b3` | `#bcbbb7` |
| 14 | content | 670, 326 | 99×14 | 99.4 | `#d4d4d1` | `#cccbc7` |
| 15 | content | 525, 666 | 108×18 | 92.5 | `#dddcd9` | `#d6d5d1` |
| 16 | content | 771, 324 | 84×18 | 105.4 | `#d8d7d5` | `#d0cfcc` |
| 17 | content | 381, 90 | 32×66 | 63.7 | `#d2d1d0` | `#d2d1cf` |
| 18 | content | 632, 666 | 88×18 | 95.4 | `#d9d8d5` | `#d2d1cd` |
| 19 | content | 420, 422 | 77×16 | 96.6 | `#d7d6d4` | `#cecdca` |
| 20 | sidebar | 84, 202 | 66×13 | 115.0 | `#b7b7b5` | `#b8b7b6` |

Images: `design/report/document-side.png`, `document-diff.png`.

## Collection · Table

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 332, 792 | 892×8 | 28.9 | `#d4d2cd` | `#f0efea` |
| 2 | content | 1152, 224 | 74×31 | 158.4 | `#5c5a56` | `#34322e` |
| 3 | content | 419, 356 | 80×16 | 97.6 | `#cecdca` | `#d4d2cf` |
| 4 | content | 578, 314 | 88×22 | 68.7 | `#eacb96` | `#e9cb9c` |
| 5 | content | 578, 520 | 88×22 | 68.7 | `#eacb96` | `#e9cb9c` |
| 6 | sidebar | 81, 322 | 72×17 | 96.6 | `#cac9c4` | `#cac9c4` |
| 7 | content | 690, 520 | 126×22 | 57.9 | `#c6d3cf` | `#c8d6cf` |
| 8 | content | 934, 321 | 74×11 | 97.7 | `#cac9c5` | `#bebdb9` |
| 9 | sidebar | 84, 283 | 56×14 | 105.8 | `#c3c2bd` | `#c4c3be` |
| 10 | content | 690, 396 | 91×22 | 53.9 | `#edc9c3` | `#edcbc5` |
| 11 | content | 518, 152 | 70×20 | 54.8 | `#e2e1dd` | `#d9d8d3` |
| 12 | content | 494, 438 | 42×16 | 100.0 | `#d3d2ce` | `#d9d8d4` |
| 13 | content | 702, 320 | 57×12 | 85.2 | `#89bce0` | `#8dc2df` |
| 14 | content | 702, 442 | 57×12 | 85.2 | `#89bce0` | `#8dc2df` |
| 15 | content | 702, 524 | 57×12 | 85.2 | `#89bce0` | `#8dc2df` |
| 16 | sidebar | 80, 769 | 56×12 | 92.8 | `#c6c5c0` | `#bebdb8` |
| 17 | content | 962, 485 | 46×11 | 98.0 | `#c3c2be` | `#bdbcb9` |
| 18 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 19 | content | 424, 150 | 56×22 | 56.9 | `#e4e3e0` | `#dad9d4` |
| 20 | content | 959, 362 | 46×11 | 96.6 | `#c2c1bd` | `#bcbbb7` |

Images: `design/report/table-side.png`, `table-diff.png`.

## Collection · Board

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 364, 494 | 203×58 | 98.8 | `#dce8f1` | `#e7e6ec` |
| 2 | content | 698, 360 | 212×54 | 94.3 | `#dce7f1` | `#ecedea` |
| 3 | content | 698, 494 | 128×58 | 100.4 | `#e5e5e2` | `#e5e7e4` |
| 4 | content | 332, 278 | 940×522 | 26.4 | `#f1f0ed` | `#f2f1ed` |
| 5 | content | 1032, 360 | 155×30 | 85.0 | `#d2def7` | `#f4e5e9` |
| 6 | content | 682, 282 | 89×31 | 86.4 | `#eed8b1` | `#ecd5af` |
| 7 | content | 364, 360 | 91×30 | 85.0 | `#f2d7d3` | `#f2d8d5` |
| 8 | content | 364, 604 | 47×66 | 89.3 | `#ece0ee` | `#e7d8e4` |
| 9 | content | 1104, 336 | 86×17 | 117.1 | `#cbcbca` | `#cbcbc9` |
| 10 | content | 778, 336 | 78×20 | 119.0 | `#d0cfce` | `#d0cfce` |
| 11 | content | 390, 392 | 78×22 | 108.8 | `#f4ded5` | `#f3e7e2` |
| 12 | content | 724, 392 | 78×22 | 109.3 | `#f4ded5` | `#f3e7e2` |
| 13 | content | 790, 470 | 56×22 | 121.6 | `#d6d5d4` | `#d5d5d4` |
| 14 | content | 364, 336 | 70×17 | 118.8 | `#cccccb` | `#cccccb` |
| 15 | content | 348, 282 | 63×31 | 65.1 | `#f7cec9` | `#f2cbc7` |
| 16 | content | 1016, 282 | 54×31 | 67.6 | `#c1e7cd` | `#c1e7cc` |
| 17 | content | 462, 336 | 64×17 | 120.0 | `#cacac9` | `#cacac9` |
| 18 | content | 528, 336 | 54×20 | 119.0 | `#cececd` | `#cececd` |
| 19 | content | 698, 336 | 52×17 | 122.0 | `#c8c8c6` | `#c8c7c6` |
| 20 | content | 1058, 392 | 47×22 | 117.7 | `#f4ded5` | `#f6e4dd` |

Images: `design/report/board-side.png`, `board-diff.png`.

## Collection · Calendar

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 332, 710 | 892×90 | 30.4 | `#f2efec` | `#f8f5f3` |
| 2 | content | 396, 280 | 72×15 | 119.0 | `#b8b6b3` | `#b7b6b2` |
| 3 | content | 1152, 224 | 72×31 | 157.3 | `#575651` | `#35332e` |
| 4 | sidebar | 81, 322 | 72×17 | 96.6 | `#cac9c4` | `#cac9c4` |
| 5 | content | 344, 278 | 53×18 | 107.4 | `#c1c0bc` | `#d2d1ce` |
| 6 | sidebar | 84, 283 | 56×14 | 105.8 | `#c3c2bd` | `#c4c3be` |
| 7 | content | 535, 232 | 58×14 | 95.3 | `#b5b4b0` | `#b6b4af` |
| 8 | content | 310, 310 | 944×2 | 26.8 | `#e1e0dc` | `#fbfaf7` |
| 9 | sidebar | 80, 769 | 56×12 | 92.8 | `#c6c5c0` | `#bebdb8` |
| 10 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 11 | content | 564, 280 | 42×15 | 96.6 | `#d9d8d4` | `#d2d1cd` |
| 12 | sidebar | 151, 202 | 42×13 | 92.8 | `#c0bfba` | `#c9c8c3` |
| 13 | sidebar | 140, 285 | 32×13 | 94.7 | `#bdbcb7` | `#bebdb8` |
| 14 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 15 | topbar | 1092, 20 | 26×18 | 90.0 | `#d3d2ce` | `#e2e1dd` |
| 16 | content | 850, 231 | 44×15 | 88.3 | `#e1e0dd` | `#dcdad7` |
| 17 | sidebar | 126, 24 | 24×16 | 111.6 | `#b2b1ac` | `#b2b1ac` |
| 18 | sidebar | 118, 204 | 34×11 | 96.7 | `#bcbbb6` | `#bab9b4` |
| 19 | topbar | 324, 26 | 34×12 | 98.0 | `#c9c7c4` | `#cdccc9` |
| 20 | content | 784, 234 | 38×10 | 90.5 | `#cac8c5` | `#c4c3c0` |

Images: `design/report/calendar-side.png`, `calendar-diff.png`.

## Library · Graph

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 332, 792 | 892×8 | 28.9 | `#d4d2cd` | `#f0efea` |
| 2 | content | 632, 576 | 528×152 | 59.6 | `#f8f4f2` | `#f7f1f0` |
| 3 | content | 659, 552 | 217×42 | 113.0 | `#e7e6e1` | `#faf3f2` |
| 4 | content | 482, 736 | 65×21 | 119.6 | `#f1f0f0` | `#c1bfbc` |
| 5 | content | 362, 736 | 70×20 | 112.8 | `#dcdada` | `#deddda` |
| 6 | sidebar | 84, 202 | 66×13 | 115.0 | `#b7b7b5` | `#b8b7b6` |
| 7 | sidebar | 81, 322 | 72×17 | 96.6 | `#cac9c4` | `#cac9c4` |
| 8 | content | 422, 94 | 18×29 | 162.8 | `#f9f8f5` | `#8e8d89` |
| 9 | sidebar | 84, 283 | 56×14 | 105.8 | `#c3c2bd` | `#c4c3be` |
| 10 | sidebar | 171, 202 | 52×13 | 111.3 | `#bbbab9` | `#bbbab9` |
| 11 | content | 464, 100 | 19×23 | 157.9 | `#f9f8f5` | `#868480` |
| 12 | content | 506, 101 | 20×29 | 161.0 | `#f7f6f3` | `#aeaca9` |
| 13 | content | 406, 67 | 26×21 | 150.4 | `#abaaa6` | `#fbfaf7` |
| 14 | sidebar | 80, 769 | 56×12 | 92.8 | `#c6c5c0` | `#bebdb8` |
| 15 | content | 458, 734 | 21×19 | 151.4 | `#e4aaba` | `#e3e2de` |
| 16 | content | 382, 94 | 18×29 | 170.5 | `#f9f8f5` | `#afaeaa` |
| 17 | content | 583, 736 | 42×20 | 82.5 | `#f0efee` | `#dddcd9` |
| 18 | content | 402, 101 | 20×22 | 157.4 | `#f9f8f5` | `#a4a39f` |
| 19 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 20 | content | 486, 100 | 18×23 | 158.6 | `#f9f8f5` | `#a8a7a3` |

Images: `design/report/graph-side.png`, `graph-diff.png`.

## Search

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 0, 0 | 1280×800 | 29.4 | `#cfcfce` | `#d5d5d3` |
| 2 | sidebar | 235, 213 | 126×13 | 118.0 | `#c6c5c4` | `#b7b6b5` |
| 3 | sidebar | 225, 136 | 80×40 | 84.6 | `#e4e4e3` | `#e6e6e5` |
| 4 | content | 904, 244 | 63×21 | 85.3 | `#fdfdfd` | `#a9e1b9` |
| 5 | sidebar | 185, 137 | 50×36 | 98.3 | `#d9d9d8` | `#dededc` |
| 6 | content | 954, 280 | 52×20 | 89.8 | `#a5e3b9` | `#ffffff` |
| 7 | content | 615, 696 | 126×18 | 61.5 | `#8f8f8e` | `#969592` |
| 8 | content | 720, 666 | 110×17 | 64.6 | `#8d8d8b` | `#949390` |
| 9 | content | 525, 666 | 108×18 | 60.1 | `#8f8f8e` | `#989793` |
| 10 | content | 519, 696 | 96×18 | 62.3 | `#8d8d8c` | `#979693` |
| 11 | content | 548, 636 | 82×15 | 59.4 | `#878785` | `#908f8c` |
| 12 | content | 642, 666 | 78×18 | 62.6 | `#8d8d8b` | `#94938f` |
| 13 | sidebar | 194, 232 | 117×12 | 52.1 | `#eeeeee` | `#e5e4e3` |
| 14 | sidebar | 258, 248 | 78×15 | 61.1 | `#ebebea` | `#e7e7e6` |
| 15 | sidebar | 231, 568 | 51×16 | 102.6 | `#d3d3d2` | `#dedddd` |
| 16 | sidebar | 160, 133 | 20×27 | 117.4 | `#d2d2d1` | `#bab8b3` |
| 17 | content | 804, 176 | 18×22 | 161.0 | `#ffffff` | `#91908e` |
| 18 | content | 932, 176 | 16×22 | 168.0 | `#ffffff` | `#8c8b88` |
| 19 | content | 1000, 212 | 15×24 | 162.5 | `#949391` | `#fdfdfd` |
| 20 | content | 848, 212 | 16×24 | 158.1 | `#9d9c9a` | `#fdfdfd` |

Images: `design/report/search-side.png`, `search-diff.png`.

## Sign in

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | sidebar | 30, 262 | 261×45 | 195.8 | `#4a4945` | `#44423e` |
| 2 | sidebar | 30, 166 | 261×46 | 105.5 | `#f8f2f1` | `#f4e8e9` |
| 3 | sidebar | 132, 34 | 57×56 | 134.9 | `#dfdfde` | `#cbcac9` |
| 4 | sidebar | 0, 0 | 320×342 | 47.0 | `#e7e5e5` | `#e5e3e2` |
| 5 | sidebar | 138, 276 | 28×20 | 113.9 | `#3d3c37` | `#4c4a46` |
| 6 | sidebar | 179, 106 | 25×19 | 86.1 | `#adacaa` | `#aaa9a7` |
| 7 | sidebar | 74, 228 | 34×18 | 61.7 | `#e5e4e1` | `#e6e5e2` |
| 8 | sidebar | 52, 182 | 20×17 | 83.7 | `#e3e2df` | `#d2d1ce` |
| 9 | sidebar | 144, 68 | 10×24 | 123.6 | `#b9b8b6` | `#c1c0bf` |
| 10 | sidebar | 170, 276 | 18×18 | 108.5 | `#3f3d38` | `#3a3833` |
| 11 | sidebar | 44, 228 | 17×18 | 64.3 | `#e3e2df` | `#e4e3e0` |
| 12 | sidebar | 116, 110 | 12×15 | 91.7 | `#a5a4a2` | `#9f9f9c` |
| 13 | sidebar | 44, 180 | 8×20 | 84.2 | `#e1e0de` | `#d1cfcc` |
| 14 | sidebar | 131, 282 | 10×12 | 99.7 | `#5c5b56` | `#272520` |
| 15 | sidebar | 151, 60 | 18×5 | 90.6 | `#a1a09e` | `#969593` |
| 16 | sidebar | 128, 110 | 12×10 | 88.3 | `#a09f9d` | `#8f8e8b` |
| 17 | sidebar | 68, 231 | 8×16 | 55.7 | `#e4e3e0` | `#e5e4e0` |
| 18 | sidebar | 60, 231 | 8×16 | 55.6 | `#e4e3e0` | `#e5e4e1` |
| 19 | sidebar | 76, 142 | 8×12 | 63.1 | `#dad9d8` | `#d9d9d7` |
| 20 | sidebar | 234, 145 | 7×10 | 67.6 | `#d0d0ce` | `#d0cfcd` |

Images: `design/report/signin-side.png`, `signin-diff.png`.
