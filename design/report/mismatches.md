# Design ↔ code — mismatch report

Threshold: max channel Δ > 16; zones ≥ 120px at 2x. Coordinates are 1280×800 logical pixels.

| Screen | Similar ≤16 | ≤32 | Zones | Source |
| --- | ---: | ---: | ---: | --- |
| Document | 94.59% | 95.8% | 272 | `web/src/components/Editor.tsx` |
| Collection · Table | 95.54% | 97.01% | 305 | `web/src/components/CollectionView.tsx` |
| Collection · Board | 88.44% | 93.79% | 442 | `web/src/components/CollectionView.tsx` |
| Collection · Calendar | 96.71% | 98.34% | 224 | `web/src/components/CollectionView.tsx` |
| Library · Graph | 96.65% | 97.94% | 195 | `web/src/components/GraphView.tsx` |
| Search | 95.94% | 97.28% | 189 | `web/src/components/SearchModal.tsx` |
| Sign in | 90.64% | 91.68% | 38 | `web/src/components/Login.tsx` |

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
| 6 | content | 518, 152 | 70×20 | 54.8 | `#e2e1dd` | `#d9d8d3` |
| 7 | content | 690, 396 | 91×22 | 52.4 | `#edc9c3` | `#f1cfc8` |
| 8 | content | 702, 320 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 9 | content | 702, 442 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 10 | content | 702, 524 | 57×12 | 84.9 | `#89bce0` | `#91c3e5` |
| 11 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 12 | content | 962, 485 | 46×11 | 98.0 | `#c3c2be` | `#bdbcb9` |
| 13 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 14 | content | 424, 150 | 56×22 | 56.9 | `#e4e3e0` | `#dad9d4` |
| 15 | content | 959, 362 | 46×11 | 96.6 | `#c2c1bd` | `#bcbbb7` |
| 16 | content | 966, 444 | 38×11 | 101.2 | `#c5c3c0` | `#c1c0bc` |
| 17 | content | 970, 403 | 38×11 | 98.8 | `#c4c3bf` | `#c0bfbb` |
| 18 | content | 970, 526 | 38×11 | 96.3 | `#c4c3bf` | `#c0bfbb` |
| 19 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 20 | content | 690, 314 | 76×22 | 48.5 | `#add5f0` | `#b4dbf1` |

Images: `design/report/table-side.png`, `table-diff.png`.

## Collection · Board

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 698, 401 | 210×48 | 197.0 | `#f9f5f4` | `#a8bcd2` |
| 2 | content | 700, 358 | 194×42 | 91.5 | `#d4e9f8` | `#dae0de` |
| 3 | content | 366, 506 | 199×29 | 84.9 | `#c1dff5` | `#d7ecf8` |
| 4 | content | 700, 506 | 124×29 | 83.1 | `#d3ddda` | `#d8e1dd` |
| 5 | content | 1074, 368 | 113×32 | 89.9 | `#c9e3f7` | `#e2f1fa` |
| 6 | content | 366, 368 | 89×32 | 86.9 | `#f2d9d5` | `#f6ddd8` |
| 7 | content | 684, 294 | 87×29 | 79.9 | `#edd5ac` | `#efd6ab` |
| 8 | content | 504, 539 | 82×22 | 103.8 | `#f2f2f2` | `#d6d6d5` |
| 9 | content | 1018, 294 | 52×29 | 65.0 | `#bce6ca` | `#bde9cb` |
| 10 | content | 350, 294 | 54×29 | 63.6 | `#f6c7c1` | `#f6c8c1` |
| 11 | content | 724, 539 | 49×21 | 115.7 | `#f4ddd4` | `#f6e3db` |
| 12 | content | 1034, 368 | 39×32 | 70.4 | `#f2d3f7` | `#f6d7f8` |
| 13 | content | 1152, 224 | 72×31 | 157.3 | `#575651` | `#35332e` |
| 14 | content | 390, 676 | 50×19 | 117.3 | `#f2d9ce` | `#f5e0d7` |
| 15 | content | 396, 539 | 41×21 | 117.1 | `#f3dcd2` | `#f4dfd6` |
| 16 | content | 366, 616 | 39×22 | 123.2 | `#d2d2d1` | `#d2d2d1` |
| 17 | content | 404, 401 | 60×22 | 109.3 | `#f4ddd3` | `#f3e7e2` |
| 18 | content | 506, 616 | 31×24 | 122.7 | `#d8d7d7` | `#d8d7d7` |
| 19 | content | 467, 617 | 36×24 | 121.8 | `#dadad9` | `#dad9d9` |
| 20 | content | 366, 644 | 39×27 | 63.7 | `#f0cbf6` | `#f4cff7` |

Images: `design/report/board-side.png`, `board-diff.png`.

## Collection · Calendar

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 342, 280 | 83×14 | 131.9 | `#b5b4b0` | `#b5b3b0` |
| 2 | content | 1152, 224 | 72×31 | 157.3 | `#575651` | `#35332e` |
| 3 | content | 426, 280 | 42×14 | 133.3 | `#afadaa` | `#aeada9` |
| 4 | content | 535, 232 | 58×14 | 95.3 | `#b5b4b0` | `#b6b4af` |
| 5 | content | 1192, 280 | 44×12 | 111.0 | `#d2d0cd` | `#c5c4c1` |
| 6 | sidebar | 84, 397 | 38×18 | 89.6 | `#cac9c4` | `#cac9c4` |
| 7 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 8 | topbar | 1194, 20 | 22×20 | 93.8 | `#bfbdba` | `#cccbc8` |
| 9 | topbar | 1092, 20 | 26×18 | 90.0 | `#d3d2ce` | `#e2e1dd` |
| 10 | content | 850, 231 | 44×15 | 88.3 | `#e1e0dd` | `#dcdad7` |
| 11 | topbar | 324, 26 | 34×12 | 98.0 | `#c9c7c4` | `#cdccc9` |
| 12 | content | 784, 234 | 38×10 | 90.5 | `#cac8c5` | `#c4c3c0` |
| 13 | content | 1108, 234 | 30×11 | 101.4 | `#cccac7` | `#c5c3c0` |
| 14 | content | 1186, 234 | 26×11 | 111.5 | `#5a5954` | `#605e5a` |
| 15 | content | 523, 282 | 37×13 | 97.0 | `#f6f5f2` | `#c6c5c1` |
| 16 | content | 514, 230 | 17×18 | 100.6 | `#edceb6` | `#c0bfba` |
| 17 | content | 1084, 278 | 22×17 | 84.4 | `#d8d7d3` | `#d2d1cd` |
| 18 | content | 547, 159 | 42×19 | 52.1 | `#e2e1de` | `#d9d8d3` |
| 19 | topbar | 1128, 20 | 24×19 | 86.8 | `#dad9d5` | `#e1e0dc` |
| 20 | content | 440, 159 | 38×16 | 52.7 | `#e1e0dd` | `#d8d7d2` |

Images: `design/report/calendar-side.png`, `calendar-diff.png`.

## Library · Graph

| # | region | x, y | w×h | mean Δ | ref | ours |
| ---: | --- | --- | --- | ---: | --- | --- |
| 1 | content | 800, 522 | 336×202 | 67.1 | `#f8f5f2` | `#f8f8f4` |
| 2 | content | 608, 552 | 200×110 | 89.6 | `#f2eeeb` | `#f8f8f4` |
| 3 | content | 364, 62 | 69×26 | 133.3 | `#b9b8b4` | `#b9b7b4` |
| 4 | content | 456, 732 | 23×19 | 177.9 | `#e6b2c0` | `#73716d` |
| 5 | content | 1230, 750 | 22×22 | 125.4 | `#c64f70` | `#c65071` |
| 6 | content | 757, 458 | 14×40 | 136.7 | `#c4d6c7` | `#fbfaf7` |
| 7 | content | 426, 314 | 19×19 | 152.9 | `#fbfaf7` | `#a9bfd5` |
| 8 | content | 1146, 414 | 19×19 | 152.3 | `#fbfaf7` | `#d9a8a6` |
| 9 | content | 413, 342 | 48×12 | 86.4 | `#faf9f6` | `#cccbc7` |
| 10 | content | 464, 128 | 73×14 | 50.7 | `#e1e0dd` | `#dad9d4` |
| 11 | content | 766, 660 | 14×16 | 161.7 | `#81c09a` | `#fbfaf7` |
| 12 | content | 316, 62 | 18×18 | 114.7 | `#bfbeba` | `#cac9c6` |
| 13 | content | 485, 736 | 34×11 | 91.1 | `#e3e2e1` | `#c7c5c2` |
| 14 | content | 1210, 69 | 25×14 | 98.3 | `#d5d4d1` | `#d0cecb` |
| 15 | content | 562, 738 | 36×11 | 78.9 | `#dedddc` | `#bebcb9` |
| 16 | content | 807, 303 | 20×20 | 113.2 | `#c1d3ed` | `#fbfaf7` |
| 17 | content | 329, 128 | 54×15 | 50.6 | `#dbdad7` | `#d6d5d0` |
| 18 | content | 1005, 130 | 28×13 | 90.7 | `#cbcbca` | `#d2d1cc` |
| 19 | content | 1034, 130 | 31×14 | 88.3 | `#dadad9` | `#d8d7d2` |
| 20 | content | 343, 62 | 20×21 | 114.9 | `#a2a19d` | `#a3a19e` |

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
| 1 | sidebar | 30, 286 | 259×22 | 194.7 | `#2e2c27` | `#686763` |
| 2 | sidebar | 30, 262 | 259×22 | 194.8 | `#676663` | `#2c2a25` |
| 3 | sidebar | 132, 34 | 57×56 | 134.9 | `#dfdfde` | `#cbcac9` |
| 4 | sidebar | 0, 0 | 320×342 | 47.0 | `#e7e5e5` | `#e6e5e4` |
| 5 | sidebar | 30, 166 | 259×14 | 60.4 | `#f9f1f2` | `#f8f1f0` |
| 6 | sidebar | 30, 200 | 259×13 | 60.2 | `#f7efef` | `#f8ecee` |
| 7 | sidebar | 138, 276 | 28×20 | 113.9 | `#3d3c37` | `#4c4a46` |
| 8 | sidebar | 179, 106 | 25×19 | 86.1 | `#adacaa` | `#aaa9a7` |
| 9 | sidebar | 53, 182 | 19×17 | 83.4 | `#e2e1df` | `#d1d0cd` |
| 10 | sidebar | 144, 68 | 10×24 | 123.6 | `#b9b8b6` | `#c1c0bf` |
| 11 | sidebar | 170, 276 | 18×18 | 108.5 | `#3f3d38` | `#3a3833` |
| 12 | sidebar | 76, 231 | 20×16 | 60.6 | `#e2e1de` | `#e3e2df` |
| 13 | sidebar | 116, 110 | 12×15 | 91.7 | `#a5a4a2` | `#9f9f9c` |
| 14 | sidebar | 44, 180 | 8×20 | 83.7 | `#dfdedc` | `#cecdc9` |
| 15 | sidebar | 96, 228 | 13×18 | 60.4 | `#e2e1df` | `#e4e3df` |
| 16 | sidebar | 131, 282 | 10×12 | 99.7 | `#5c5b56` | `#272520` |
| 17 | sidebar | 151, 60 | 18×5 | 90.6 | `#a1a09e` | `#969593` |
| 18 | sidebar | 128, 110 | 12×10 | 88.3 | `#a09f9d` | `#8f8e8b` |
| 19 | sidebar | 44, 228 | 8×18 | 64.4 | `#e0dfdc` | `#e2e1dd` |
| 20 | sidebar | 53, 231 | 8×16 | 61.1 | `#dddcda` | `#dfdeda` |

Images: `design/report/signin-side.png`, `signin-diff.png`.
