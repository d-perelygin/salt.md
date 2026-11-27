# AI-интерфейс salt.md → FigCraft

Инвентаризация всех AI-поверхностей и состояний, чтобы перенести их в `design/salt-md.figcraft`
1:1 по коду. Снимок: ветка `mobile/thumb-shell`, `5a4a666`. Тема — `web/src/theme.css`
(сайтовая, светлая и тёмная), поверх неё `web/src/aiChat.css`.

Метод: значения сняты из CSS и JSX (файл и селектор указаны у каждой строки), геометрия
экранов — из существующего файла FigCraft (`document.json`, `node.get`: питч кадров 1560,
`Desktop / Document` = 1280×800) и пересчитана по CSS. Живых скриншотов AI-чата в `wiki/img`
нет; единственный AI-скриншот — `wiki/img/agents-connect.png` (2× кроп диалога 640 px),
он сверен с `.agent-dialog`.

Файлы-источники:

| Файл | Что даёт |
| --- | --- |
| `web/src/components/AiChatView.tsx` | полноэкранный Chats: тред, поток, run, артефакты, память |
| `web/src/components/AiChatPanel.tsx` | плавающая панель на странице (та же логика, 400 px) |
| `web/src/components/AiThreadList.tsx` | строки тредов, меню, pinned/recent |
| `web/src/components/AiRunSummary.tsx` | «Worked for …» под ответом |
| `web/src/components/AiAgentStep.tsx` | строка шага трассы (thinking/tool) |
| `web/src/components/AiApprovalSelect.tsx` | выбор режима одобрений |
| `web/src/components/AiErrorCard.tsx` | карточка ошибки + парсер 9 категорий |
| `web/src/components/AiMarkdown.tsx` | markdown ответа |
| `web/src/components/AiInlineAssistant.tsx` | выделение → пилюля действий |
| `web/src/components/AiFormattingDropdown.tsx` | меню AI на панели форматирования |
| `web/src/components/AiBlockComposer.tsx` | оверлей «AI block» (не смонтирован) |
| `blocks.tsx#aiBlockSpec` | AI-блок в документе (draft/ready/busy/error) |
| `web/src/components/AiEmptyLine.tsx` | «Space for AI» на пустой строке |
| `web/src/components/AgentBadge.tsx`, `AgentConnect.tsx`, `../agentPresence.ts` | presence и подключение агента |
| `web/src/components/Sidebar.tsx`, `ArchivedChats.tsx` | сайдбар Chats, архив |
| `web/src/components/MobileDock.tsx`, `mobile.css` | AI на телефоне |
| `web/src/aiChat.css` | ~90 % геометрии AI |
| `web/src/theme.css`, `styles.css` | токены, `.btn-sm`, `.menu`, `.page-link`, `.agent-*` |

---

## 1. Карта поверхностей

| # | Экран / слой | Где виден | Компонент | Точка входа | Состояния | Источник |
| ---: | --- | --- | --- | --- | --- | --- |
| S1 | **Chats** (полный экран) | `main`, вместо документа, только `sidebarMode === 'chats'` | `AiChatView` | вкладка «Chat» в сайдбаре, `?chat=<id>`, `?chat=` | пустой новый чат; диалог; live-run; approval; вопрос; ошибка; артефакты; память; меню @ / файлов | `AiChatView.tsx`, `App.tsx:2457` |
| S2 | **Сайдбар Chats** | левая колонка 292 px | `Sidebar` + `AiThreadList` | вкладка «Chat» | список, pinned, unread, hover-меню, пусто, архив | `Sidebar.tsx:1736`, `AiThreadList.tsx` |
| S3 | **Архив чатов** | низ сайдбара (desktop) / шторка (phone) | `ArchivedChatsSection/Dialog` | «Archived» в футере сайдбара | свёрнут, открыт, поиск, пусто | `ArchivedChats.tsx` |
| S4 | **Панель чата на странице** | floating 400 px справа-снизу, поверх документа | `AiChatPanel` | `.ai-fab` (44 px), `salt:ai-ask` (⎘/⌘J, панель форматирования, Code tab), dock на телефоне | zero-состояние с контекстом страницы/коллекции, quote, вложения, все состояния S1 в узком виде | `AiChatPanel.tsx`, `App.tsx:2700/2708` |
| S5 | **Inline-ассистент по выделению** | пилюля fixed справа-снизу | `AiInlineAssistant` | выделение текста в редакторе | пилюля, busy, результат, замена | `AiInlineAssistant.tsx` |
| S6 | **AI на панели форматирования** | dropdown у кнопки «✨ AI» | `AiFormattingDropdown` | кнопка «AI» в тулбаре выделения | меню, custom-строка, busy, результат, ошибка, «Ask in chat» | `AiFormattingDropdown.tsx`, `Editor.tsx:4490` |
| S7 | **AI Block в документе** | блок документа | `aiBlockSpec` | `/` → «AI Block» | draft, ready, hover-toolbar, busy, error, read-only | `blocks.tsx:639–930` |
| S8 | **AI на пустой строке** | fixed-панель над строкой | `AiEmptyLine` | пробел в пустом параграфе | idle, writing, error | `AiEmptyLine.tsx` |
| S9 | **Presence агента** | topbar страницы, точка на карточке/строке сайдбара/таблицы | `AgentPresence`, `AgentDot` | `working_on` через MCP | fresh / stale, с заметкой / без, 1 / 2 агента, tooltip | `AgentBadge.tsx`, `agentPresence.ts` |
| S10 | **Connect an agent** | модалка 640 px | `AgentConnectModal` | меню профиля → «Agents & MCP» | Sign in / Token, токен пуст/создан, выбран клиент, предупреждение http | `AgentConnect.tsx`, `wiki/img/agents-connect.png` |
| S11 | **AI на телефоне** | ≤768 px | `MobileDock`, `AiChatPanel` как шторка, `AiChatView` на весь экран | dock «AI», вкладка Chat в drawer | dock-слот AI, шторка 88dvh, полноэкранный Chats, zero-состояния крупнее | `MobileDock.tsx`, `mobile.css:757/842/1244` |
| S12 | **AI в Process → Code** | тот же `AiChatPanel` с `raised` | — | кнопка «Ask AI» в Code | панель над модалкой (`z-index:110`) | `WorkflowCode.tsx:409`, `aiChat.css:436` |

Нет экрана «выбор модели»: в чате модель не выбирается. `.ai-model-label` в CSS есть, в JSX не
используется. Модель/Base URL — только `Admin settings → General → AI agent` (`AdminSettings.tsx:389`);
режим одобрений — в композере (`AiApprovalSelect`), хранится в `ai_settings.approval`.

---

## 2. Состояния по экранам

### 2.1 S1 / S4 — диалог (общая модель)

| Состояние | Что на экране | Условие в коде | Компоненты |
| --- | --- | --- | --- |
| Пустой новый чат | заголовок «New chat», zero-состояние, композер активен | `messages.length === 0 && !agentBusy && steps.length === 0 && !lastError` | `AiChatView` zero / `AiChatPanel` zero |
| Обычный диалог | user-bubble справа, ответ markdown слева + иконки действий | есть сообщения, run нет | `.ai-bubble-user`, `.ai-bubble-ai`, `.ai-msg-actions` |
| Ответ + завершённый run | над ответом «Worked for 1m 9s (20 steps)», свёрнуто/развёрнуто | `runList` с `finishedAt` и `completed/failed/cancelled` | `AiRunSummary` |
| Live-run, шагов ещё нет | только композер: send «…», поле disabled; в теле пусто | `agentBusy && steps.length === 0` | — |
| Live-run, шаги идут | «Working for 12s … (3)», список шагов, строка `progress` | `steps.length > 0` | trace + `AiAgentStep` |
| Ожидание одобрения | под трассой `Approve` / `Reject` | `status === 'waiting_approval'` | `.btn-sm.primary` / `.btn-sm` |
| Вопрос агента | карточка с нумерованными опциями + свободный ответ | `status === 'waiting_user' && pendingTool === 'ask_user'` | `.ai-question-card` |
| Ошибка | `AiErrorCard` + «Retry» (если есть `lastRun.task`) | `lastError` | `AiErrorCard` |
| Артефакты | блок «Artifacts» под текстом (только S1) | `artifacts.length > 0` | `.ai-artifacts-inline` |
| Цитата | чип цитаты над композером | `quote` / `autoQuote` (панель) | `.ai-quote` |
| Вложения | чипы файлов над композером | `files.length > 0` | `.ai-filechip` |
| Память | поповер из шапки | `memoryOpen` | inline-стили в `AiChatView` |
| @-меню | список страниц над композером | `mentionQuery !== null && matches` | inline-стили |
| Меню «+» | 2 пункта над композером | `attachMenuOpen` | `.menu` |
| Одобрения | поповер 3 режима | `open` | `AiApprovalSelect` |
| Загрузка истории | тело пустое → на миг показывается zero-состояние (нет скелетона) | `messages === []` при fetch | — |

### 2.2 S2/S3 — сайдбар и архив

| Состояние | Детали |
| --- | --- |
| Вкладки Home/Chat | 2 таба 133×30, активный — заливка `--active` |
| Поиск | «Search or ask» + `⌘K`, 268×36 |
| «New chat» | строка 260×29, иконка Plus 15 |
| Заголовок «Chats» | caps 11/600, `letter-spacing:.04em` |
| Тред: обычный / hover / active | 260 px, r8, `--hover` / `--active`; `⋯` появляется на hover/active |
| Тред с sub | 2-я строка 12 px: `pageTitle · lastPreview` (обрезка 80 симв.) |
| Pinned | секция «Pinned» с Pin 11; в строке Pin 11 opacity .6 |
| Unread | точка 8 px `--accent` |
| Меню треда | Pin / Copy link / Mark as read / Rename / Regenerate title / Archive / Delete forever / Open in new tab / «Last updated …» |
| Пусто | `.sb-empty` «No chats yet» 12 px muted |
| Архив (desktop) | секция у футера, `border-top`, свёрнута; открыта — 33 % высоты, sticky-поиск |
| Архив (phone) | шторка `.trash-dialog`, строки 48 px |

### 2.3 Мобильный AI (S11)

| Состояние | Значения |
| --- | --- |
| Dock | 5 слотов, `min-height:48`, label 10.5/550, icon 19; слот AI — «AI» + Sparkles, активный цвет `--accent` |
| Dock в Chats | средний слот меняется с «Search» на «New chat» |
| `.ai-fab` | скрыт (`display:none !important`) |
| Панель | шторка: `height:min(88dvh, 100dvh-8)`, r18 сверху, `z-index:330`, ручка 34×4, футер с `env(safe-area-inset-bottom)` |
| Zero в панели | строки 46 px, бейдж 34×34, текст 15.5, контекст 14.5 |
| Полный Chats | `AiChatView` на всю ширину: padding 12 24 20 → контент 342 при 390 |
| Вкладки в drawer | переезжают вниз, над футером (`order:1`) |

---

## 3. Размеры и токены

### 3.1 Палитра (theme.css, светлая / тёмная)

| Токен | Light | Dark | Где в AI |
| --- | --- | --- | --- |
| `--bg` | `#fbfaf7` | `#0b0b0e` | фон Chats, фон под панелью |
| `--card` | `#ffffff` | `#111116` | композер, панель, меню, AI-блок |
| `--sidebar-bg` | `#f2f1ea` | `#07070a` | сайдбар (в Chats) |
| `--fg` | `#1c1a15` | `#d9d9db` | текст |
| `--muted` | `#7e7d78` | `#808083` | подписи, иконки, sub |
| `--hover` | `rgba(28,26,21,.045)` | `rgba(255,255,255,.045)` | bubble user, чипы, hover |
| `--active` | `rgba(28,26,21,.075)` | `rgba(255,255,255,.075)` | активный тред/таб |
| `--border` | `rgba(28,26,21,.11)` | `rgba(255,255,255,.08)` | все hairline |
| `--border-strong` | `rgba(28,26,21,.2)` | `rgba(255,255,255,.15)` | ручка шторки |
| `--accent` | `#b3123f` | `#ff5c80` | send, unread, ссылки, выделение |
| `--accent-soft` | `rgba(179,18,63,.085)` | `rgba(255,92,128,.13)` | @-упоминание, poll-выделение |
| `--danger` | `#c2410c` | `#ff7a59` | рамка/заголовок ошибки |
| `--pill-dark` | `#1c1a15` | `#f5f5f7` | primary-кнопки (в т.ч. Retry, Approve) |

Не определены нигде (падают в литералы): `--accent-fg` (→`#fff`), `--card-foreground` (→inherit),
`--danger-soft` (→`rgba(239,68,68,.08)`), `--success` (→`#10b981` / `#22c55e` в разных местах),
`--warning` (→`#e07d10`). В файле FigCraft эти токены есть (`Accent/Border`, `State/Success`,
`State/Warning`), в коде — нет.

Композиты «альфа поверх» (нужны как solid-заливки в FigCraft):

| Слой | Поверх `--bg #fbfaf7` | Поверх `--card #fff` |
| --- | --- | --- |
| `--hover` | `#f1f0ed` | `#f5f5f4` |
| `--active` | `#eae9e6` | `#eeeeed` |
| `--border` | `#e2e1de` | `#e6e6e5` |
| `--border-strong` | `#cecdca` | `#d2d1d0` |
| `--accent-soft` | `#f5e6e7` | `#f9ebef` |
| danger wash `.08` | — | `#fef0f0` |

В самом файле `Surface/Hover = #ECEBE6`, `Surface/Active = #E3E2DC`, `Border/Default = #E4E2DB`
(это композиты над землёй `#F0EFEA` по разбору `design/analysis/sidebar.md`); для AI-слоёв,
которые лежат на `--bg`/`--card`, брать значения из таблицы выше.

Тоновые бейджи zero-состояния (не токены, литералы):
green `rgba(34,197,94,.16)` / рамка `.32` / `#22c55e`;
blue `rgba(59,130,246,.16)` / `.32` / `#3b82f6`;
purple `rgba(168,85,247,.16)` / `.32` / `#a855f7`; plain — прозрачный, `--muted`.

Цвета агентов (`agentPresence.ts`): claude `#c96442`, chatgpt `#10a37f`, codex `#6e7681`,
cursor `#7c6cf5`, openclaw `#b45309`, hermes `#0ea5e9`, gemini `#4285f4`, generic `#787774`.

### 3.2 Типографика

| Роль | Размер / вес / интерлиньяж | Источник |
| --- | --- | --- |
| База приложения | 16 px, Inter Variable | `body` (styles.css:84), `@fontsource-variable/inter` |
| Текст чата | 15 px / 1.6 (ответ), 15 / 1.55 (user) | `.ai-bubble-ai`, `.ai-bubble-user` |
| Композер | 15 px / 1.5 | `.ai-composer textarea` |
| Заголовок zero | 20 px / 600 | `.ai-view-zero-hero h2` |
| Заголовок треда | 14 px / 600 | `.ai-topbar .ai-title` |
| Крошка «AI /» | 14 px, opacity .55 | `.ai-crumb` |
| Строка треда | 14 px; sub 12 px `--muted` | `.ai-chat-row` |
| Секции сайдбара | 11 px / 600, caps, ls .04–.05em | `.ai-section-label`, `.ai-section-title` |
| Действия трассы | 12 px, `--muted` | `.ai-actions-toggle` |
| Шаг | 12 px (label 600, title 12 opacity .9) | `AiAgentStep` inline |
| Ошибка | head 13/600, body 13/1.45, hint 12 italic | `.ai-error-*` |
| Вопрос | title 14/600, опция 13/600, desc 12 | `.ai-question-*` |
| Артефакты | заголовок 12/600 caps, чип 13 | `.ai-artifacts-inline*` |
| Панель, шапка | 13/600 (свитчер) | inline в `AiChatPanel` |
| Маркдаун | p 15/1.6, h 1.05em/600, code .9em mono | `.ai-markdown` |
| Mono | JetBrains Mono Variable | `--mono` (theme.css:344) |

### 3.3 Геометрия (снято)

**Шапка и каркас чата (S1)**

| Селектор | Значения |
| --- | --- |
| `.ai-chat-main` | max-width 860, padding 12 24 20, margin auto → при 1280 и сайдбаре 292: x 356…1216, контент 380…1192 |
| `.ai-topbar` | gap 8, padding 6 2 14, min-height 40, 14 px |
| `.ai-view-menu` | 30×30, r8 |
| `.ai-topbar .ai-avatar` | 26×26, круг, `--hover`, border 1 |
| `.ai-newchat-btn` | padding 3 5 |
| `.ai-chat-body` | padding 4 2 12, скролл |
| `.ai-msg` | margin 6 0 14 |
| `.ai-bubble-user` | max-w 85 %, padding 10 14, r16 (br 4), border 1, bg `--hover`, 15/1.55 |
| `.ai-bubble-ai` | 100 %, 15/1.6 |
| `.ai-msg-actions` | gap 2, margin-top 6; иконка 14, кнопка 26×26 (padding 4 6, r6) |
| `.ai-composer` | r16, bg card, border 1, shadow `0 2px 8px rgba(0,0,0,.06)`, padding 10 12 8; высота ≈105 (10 + поле 53 + бар 34 + 8) |
| поле ввода | rows 2, 15/1.5, padding 2 2 6, авто-рост до 160 (view) / 140 (panel) |
| `.ai-composer-bar` | gap 6, padding-top 2 |
| `.ai-attach` | 28×28 круг, «+» 18 px |
| `.ai-send` | 32×32 круг, bg `--accent`, цвет `#fff`, «↑» 16 px; busy — «…», disabled opacity .4 |
| стоп | `.ai-iconbtn` c «■», появляется при `agentBusy && runId` |
| `.ai-quote` | border-left 3 `--accent`, padding 6 10, r 0 8 8 0, 13 px, max-height 80 (view) / 60 (panel), обрезка 300 симв. |
| `.ai-filechip` | padding 4 8, r8, 12 px, gap 4, Paperclip 13, X 13 |

**Панель (S4)**

| Селектор | Значения |
| --- | --- |
| `.ai-panel` | fixed right 16 bottom 16, width 400 (max `100vw-32`), max-height 82vh, r16, border 1, shadow `0 16px 48px rgba(0,0,0,.28)`, z 90 (raised 110) |
| `.ai-panel-head` | padding 10 12, border-bottom, 600; свитчер 13 px, padding 2 6, r6, max-w 240; plus/close 26 |
| `.ai-panel-body` | padding 12, скролл |
| `.ai-panel-foot` | border-top, padding 10 12 6 |
| композер в панели | 376 px (400−24), контент 352 |

**Zero-состояния**

| Селектор | Значения |
| --- | --- |
| `.ai-view-zero` | max-width 680, `margin: auto auto 8px` → прижат к композеру, gap 6 |
| `.ai-view-zero-hero` | gap 10, padding 0 6 8 |
| `.ai-view-zero-spark` | 34×34, r10, 17 px иконка |
| h2 | 20/600 |
| `.ai-zero-section` | 12/600, `--muted`, padding 8 6 2 |
| сетка | 2 колонки, gap 4 12; при ≤600 — 1 колонка |
| `.ai-zero-item` | gap 10, padding 6 8, r10, 14/500; hover `--hover` |
| `.ai-zero-badge` | 30×30, r8, иконка 15 |
| в панели | `.ai-panel-zero` gap 4, padding 2 0 6; `.ai-zero-context` padding 7 10, r10, 13 px, бейдж 11 px padding 2 6 r6; список gap 2; divider 1 px margin 6 4 |

**Треды и сайдбар**

| Селектор | Значения |
| --- | --- |
| `.ai-search` | margin 6 12 4, padding 8 12, r10, 14 px, width 268, иконка 15, `⌘K` |
| `.ai-side-tabs` | padding 4 12 8, gap 2, border-bottom → блок 43 px |
| `.ai-side-tab` | flex 1 (133), padding 7 0, r8, 13 px, gap 6, иконка 15 |
| `.ai-newchat` | margin 2 8 4, padding 6 12, r8, 14 px → 260×29 |
| `.ai-section-label` / `-title` | padding 10 16 4 / 8 12 4 |
| `.ai-chat-row` | margin 1 8, padding 6 12, r8, 14 px, gap 8; высота 29 (без sub) / 45 (с sub); x 16, width 260 |
| `.ai-row-menu` | opacity 0 → 1 на hover/active/focus-within |
| `.ai-unread-dot` | 8×8, `--accent` |
| `.ai-pin-badge` | 11 px, opacity .6 |
| `.trash-section` | border-top, padding 6; open — 33 % высоты; `.trash-toggle` 6 10, 13 px, `--muted` |

**Трасса, run, шаг**

| Селектор | Значения |
| --- | --- |
| `.ai-actions-bar` | gap 6, margin 4 0, 12 px `--muted` |
| `.ai-actions-toggle` | padding 3 8, r6, 12 px; hover `--hover` |
| `.ai-actions-list` | gap 4, margin 4 0 8 6, padding-left 8, border-left 2 `--border` |
| step row | **CSS нет** (`ai-action-step-*` не стилизованы) → inline-`<button>`: chevron 14, Brain/Wrench 14 (opacity .8), label 12/600 (opacity .85), title 12 (opacity .9), статус 11–12; иконки статуса идут сразу за заголовком, `margin-left:auto` в inline-потоке не работает |
| step body | `<pre>` margin 4 0 6 24, padding 8 10, r8, `--hover`, border 1, 12/1.45, max-h 240 |
| статус шага | running `⋯` `--accent`; done CircleCheck 12 `--success`(#10b981); error AlertTriangle 12 `--danger`(#c2410c) |
| строка `runStatus` | 12 px, opacity .7, margin-top 4 |
| Approve/Reject | `.btn-sm` gap 8, margin-top 8 |

**Вопрос, ошибка, артефакты, память**

| Селектор | Значения |
| --- | --- |
| `.ai-question-card` | margin 12 0, padding 12 14, r12, bg card, border `--accent`, ширина 100 % |
| title | gap 8, 14/600, 1.45, CircleHelp 15 |
| `.ai-question-opt` | padding 9 12, r10, border 1, bg `--hover`, 13 px, gap 10; selected — border accent + `accent 12%` |
| `.ai-question-opt-num` | 22×22, r6, mono 11/700; selected — bg accent, `#fff` |
| desc | 12 px, opacity .65 |
| textarea | r10, padding 8 10, 14 px, margin-bottom 8 |
| `.ai-error-card` | margin 8 0, padding 12 14, r10, bg `rgba(239,68,68,.08)`, border `--danger`, gap 8 |
| head | gap 8, 13/600, AlertTriangle 15, код-бейдж 11 mono padding 2 6 r4 |
| details | pre 11/1.4 mono, padding 8 10, max-h 160, r6 |
| actions | gap 6, wrap; 4 × `.btn-sm` (27 px) |
| `.ai-artifacts-inline` | margin 4 0 12, padding 10 12, r12, `--hover`, border 1 |
| title | 12/600 caps ls .04em |
| `.ai-artifact-chip` | r999, padding 5 12, 13 px, gap 6, max-w 260, bg card |
| memory popover | width 320 (max 80vw), max-h 320, padding 10, r10, shadow `0 8px 24px .25`, top `calc(100%+6)`, right 0 |
| mention menu | max-h 220, r10, min-w 260 (view) / left+right 12 (panel); строки 8 12, 14 px (view) / 13 px (panel), иконка 14 |
| approval menu | width `min(300px, 100vw-32)`, r12, padding 12, shadow `0 8px 24px .25`, bottom `calc(100%+8)`; пункт padding 8 4, r8, title 14/600, desc 12/.7 |

**Инлайн и документ**

| Селектор | Значения |
| --- | --- |
| `.ai-inline-wrap` | fixed right 20 bottom 20, max-w `min(760, 100vw-40)`, z50 |
| `.ai-inline-bar` | r999, padding 5 6 5 12, gap 2, shadow `0 8px 24px .25`, height ≈40 |
| opt | padding 6 10, r999, 13 px; disabled .4 |
| input | min-w 110, 13 px, padding 6 8 |
| `.ai-inline-go` | 26×26, accent, «↑» 14 |
| `.ai-inline-result` | margin-top 8, r12, padding 10 12, shadow `0 8px 24px .2`; текст 13, max-h 160 |
| `.bn-ai-block` | margin 12 0, border 1, r10, card, shadow `0 1px 4px .06` |
| header | padding 8 12, `--hover`, border-bottom, 13 px; title 600 ellipsis |
| toolbar | absolute top 6 right 8, gap 4, opacity 0 → 1 на hover/focus; `.bn-ai-block-actions` (кнопка Generate) на hover скрывается (opacity 0) |
| content | padding 12 14, min-h 40, 1.6 |
| draft | padding 14, gap 10; input/textarea 8 10, r6, 13 px |
| `.ai-empty` | fixed, z60, r12, padding 8 10 8 12, gap 6, shadow `0 8px 24px .25`; spark 16, input 15, status 13/.6, stop 26 круг, error 12 `--danger` padding 0 4 2 26 |
| `.ai-fmt-btn` | h28, padding 0 8, r4, 12/600, gap 4; Sparkles 14 accent, chevron 12/.6 |
| `.ai-fmt-dropdown` | min-w 230, max-w 340, r10, padding 6, gap 2, shadow `0 12px 32px .28`; item 6 10, r6, 13 px; input 5 8, 12 px; go 24 круг |
| `::highlight(ai-doc-selection)` | accent 30 % |

**Presence и connect**

| Селектор | Значения |
| --- | --- |
| `.agent-work` | padding 2 8 2 6, border 1 currentColor, r999, 12/1.6, gap 5, opacity .55 / 1 fresh; высота ≈25 |
| note | `--muted`, max-w 220; скрывается ≤1200 |
| `.agent-presence` | gap 6, max-w 420 (130 при ≤900) |
| `.agent-dot` | 22×22, круг, ring 2 px `--card`, logo 11, opacity .55; fresh — breathe 2.6 s |
| `.agent-dialog` | max-w 640, padding 22, r16; h2 24/700, margin 0 0 14 |
| `.agent-how` | 2 колонки, gap 8, margin 14 0 12; opt padding 10 12, r10, 13 px, sub 11.5 |
| `.agent-grid` | 4 колонки (2 ≤768), gap 8; карточка padding 12 6 10, r12, logo 34, имя 12/600 |
| `.agent-token-row` | selects flex 1 min 130 + primary |
| `.agent-skill` | flex, gap 14, margin-top 18, padding 12 14, r8; title 13.5/600, sub 12 |
| токен-код | 12 px mono, padding 8 10, r8, accent 10 % фон, 30 % рамка |

**Телефон (≤768)**

| Селектор | Значения |
| --- | --- |
| `.mobile-dock` | padding 4 6 + safe-area, border-top, gap 2, z60 |
| `.dock-btn` | min-h 48, r12, label 10.5/550, icon 19, активный `--accent` |
| `.dock-badge` | 18 px высотой, r10, border 2 `--bg`, 10/800 |
| `.ai-panel` | left/right 0, bottom `var(--kb-inset)`, height `min(88dvh, 100dvh-8)`, r18 сверху, z330 |
| `.ai-panel-foot` | padding-bottom `14 + safe-area` |
| `.sheet-grab` | h26, полоска 34×4 r2 `--border-strong` |
| `.ai-panel-zero .ai-zero-item` | min-h 46, padding 9 10, 15.5 px |
| `.ai-panel-zero .ai-zero-badge` | 34×34, r10 |
| `.ai-fab` | `display:none !important` |

### 3.4 Реальные строки (английский источник, `t()`)

| Место | Строка |
| --- | --- |
| Шапка | `AI`, `/`, `New chat`, `Menu`, `Memory`, `Remember this…`, `Remember`, `This workspace only`, `Nothing memorized yet.`, `Loading…`, `Forget` |
| Композер | `Ask, search, or make anything…`; в панели zero — `Describe what you want to build or ask…`, иначе `Ask AI`; `Attach`, `Mention note (@)`, `File from computer`, `Send`, `Cancel`, `unreadable`, `Remove`, `Remove quote` |
| Zero (view) | `How can I help you today?`, `Actions`, `Summarize this page`, `Fix grammar`, `Analyze for insights`, `Extract action items`, `Attach file or CSV`, `Link workspace page or collection` |
| Zero (panel) | `Collection`, `Note`, `Summarize collection`, `Suggested`, `Sales pipeline`, `Content calendar`, `Request tracker` |
| Трасса | `Working for {time} … ({n})`, `Agent actions ({n})`, `Worked for {time} ({n} steps)`, `Thinking`, `Tool`, `Loading…` |
| Run | `Working…`, `Run failed`, `Agent run failed`, `Approve`, `Reject` |
| Вопрос | `Type your own answer…`, `Submit answer`, `Cancel` |
| Ответ | `Copy`, `Regenerate`, `Insert into page` |
| Артефакты | `Artifacts`, `Untitled page` |
| Ошибка | `Authentication error`, `Quota exceeded`, `Rate limit reached`, `Model unavailable`, `Context limit exceeded`, `Connection timeout`, `AI disabled`, `Provider service error`, `Server error`; `Retry`, `Copy JSON response`, `Copied`, `Details`, `Hide details`, `Dismiss`; подсказки: `Check your API key in Admin Settings → AI Agent.`, `Check your provider account balance and billing limits.`, `Too many requests. Please wait a moment before retrying.`, `Verify the model name configured in Admin Settings.`, `The prompt or context is too long. Try detaching large files or starting a new chat.`, `Could not connect to the AI server. Check your connection or Base URL.`, `Enable the AI Agent in Admin Settings.`, `The AI service is experiencing issues. Please try again shortly.`, `See details below or copy the raw server response.` |
| Одобрения | `How should the agent ask for approval?`, `Always ask`, `Review for me`, `Skip all approvals`, `Ask before making changes or sharing content`, `Only consult me about potentially unsafe actions`, `Act without asking. Use with caution.` |
| Сайдбар | `Search or ask`, `Home`, `Chat`, `Chats`, `New chat`, `No chats yet`, `Pinned`, `Recent`, `Unread`, `More`, `Pin chat`, `Unpin chat`, `Copy link`, `Mark as read`, `Rename`, `Regenerate title`, `Archive`, `Restore`, `Delete forever`, `Open in new tab`, `Last updated {date}`, `Delete this chat forever?` |
| Архив | `Archived`, `Search archived chats`, `No archived chats`, `Nothing archived matches.` |
| Блок | `AI block`, `AI Block`, `Generate`, `Generating…`, `Done`, `Optional title…`, `What should AI write? e.g. Summarize, draft outline…`, `Turn into text`, `Regenerate`, `Settings` |
| Форматирование | `AI Actions`, `Rewrite`, `Summarize`, `Translate`, `Fix grammar`, `Custom instruction…`, `Ask in chat`, `AI is thinking…`, `Replace`, `Dismiss` |
| Пустая строка | `Describe the note to write…`, `Writing…`, `Stop`, `AI could not write the note` |
| Presence | `{agent} · via {name} · here for {time} · active just now` / `last seen {time} ago`, `checked in for about {time}` |
| Connect | `Connect an agent`, `Sign in`, `Token in the address`, `Nothing secret in the address. Expires and can be ended.`, `For clients that only have a URL field. Treat it like a password.`, `Create token`, `… or paste an existing token here`, `Read & write`, `Read only`, `Copy`, `Download skill`, `Close` |

---

## 4. Что уже есть в `design/salt-md.figcraft`

Файл: страница `02 · Components` (node 24), `03 · Desktop` (25), `04 · Mobile` (26), `05 · Dark` (5660).
Кадры уже 1280×800 с питчем 1560 по x; сайдбар 292; топбар 47.

| Компонент (node) | Что это | Годится для AI |
| --- | --- | --- |
| `Sidebar` (233; 163 Document, 234 Collection) | 292×800: шапка 60, поиск 268×36 «Search or ask» + ⌘K, **вкладки Home/Chat 133×30**, дерево, футер | **база для S2**: заменить дерево на список тредов, вкладку Chat — в active; ничего не дублировать |
| `Topbar` (137) | 980×47, слева иконка+название, справа 6 иконок 28×28 | база для presence-варианта (S9) |
| `Button` (64; Primary/Secondary/Ghost, 30 px) | `.btn` | для `.btn-sm` (27 px) нужен **Size=S**, а не новый компонент |
| `Badge` (55, 9 тонов) | `.prop-chip` — свойство коллекции | **не** presence/agent badge: другой вид (border currentColor, r999, 12 px) |
| `Sidebar Item` (114) | `.tree-item`, 266×40, r10, 22 px иконка | геометрия строки не совпадает с `.ai-chat-row` (260, r8, 6/12, 2 строки) — краски hover/active переиспользовать, форму — нет |
| `Avatar` (56) | 22 круг, инициалы | только футер сайдбара; в чате аватаров нет |
| `Board Card` (121) | 288×133, chips/meta/checkbox | для `AgentDot` на карточке нужен слот `card-marks`, которого в макете нет |
| `Property Pill` (97), `View Tab` (83), `Checkbox` (118), `Workspace Badge` (119) | — | не используются в AI |
| Токены: `Color` (Light/Dark), `Space & Radius`, `Type` | — | не хватает: radius 6/8/12/16, size 26/28/30/32/34/40/44, shadow-токенов, line-height, `--accent-fg`/`--danger-soft`/`--success`/`--warning` |

Кадры, которые уже есть: Document, Search, Table, Board, Calendar, Graph, Settings, Sign in,
Mobile Document/Pages, Dark Document/Board, и вся страница `06 · AI` (A1–A8).

### 4.1 Что уже переведено на инстансы (06 · AI, node 6595)

Библиотека AI — на `02 · Components`, x ≥ 2000: шесть наборов (`AI / Bubble` 4 варианта,
`AI / Run Summary` 3, `AI / Step Row` 4, `AI / Approval Card` 3, `AI / Thread Row` 4
(normal/unread/archived/active), `AI / Composer` 2), набор `AI / Empty State`
(Device=Desktop 680×204, Device=Phone 342×339) и шесть одиночек (`AI / Artifact Row`,
`AI / Agent Badge`, `AI / Thinking`, `AI / Panel Header`, `AI / Memory Row`,
`AI / Attachment Row`).

Варианты несут свой контент: текст снят с кадра (cut → paste в компонент), поэтому стиль
и позиции совпадают до пикселя. Копия на кадре задаётся текстовыми свойствами
`Label` (и `Sub` у `AI / Thread Row`), размер — `node.set width/height` на инстансе,
`Send` в композере держится правым constraint'ом.

| Кадр | Инстансов | Что именно |
| --- | ---: | --- |
| A1 | 5 | 3 × Thread Row (unread/normal/normal), Empty State · Desktop, Composer · idle |
| A2 | 13 | Bubble · Human, Run Summary · done, 3 × Step Row, 2 × Artifact Row, 2 × Attachment Row, Composer · idle, 3 × Thread Row (active/normal/normal) |
| A3 | 10 | Bubble · Human, Run Summary · running, 4 × Step Row, Composer · busy, 3 × Thread Row |
| A4 | 3 | 3 × Thread Row |
| A5 | 2 | Panel Header, Composer · idle (376) |
| A6 | 1 | Agent Badge (fresh) |
| A7 | 2 | Agent Badge (fresh, stale с opacity .55) |
| A8 | 2 | Empty State · Phone, Composer · idle (342) |

Остались нарисованными (компонента нет, по одному экземпляру на кадр): сайдбар A1–A4
(поиск, табы, «New chat», футер; в A1 — инстанс `Sidebar` + нарисованные поверх табы),
карточка вопроса и карточка ошибки в A4, контекст/строки действий/цитата в A5,
меню форматирования, AI Block и инлайн-пилюля в A6, Connect-диалог в A7, dock в A8,
текст ответа в A2. `AI / Approval Card`, `AI / Thinking`, `AI / Memory Row` собраны,
но ни один кадр их не показывает: меню режимов одобрений, поповер памяти и отдельная
строка «Thinking…» в макетах не нарисованы — это кандидаты в волны 07–11.

Расхождения с прежней отрисовкой, оставленные сознательно: у композера `Send` стоит
в 12 px от правого края (как в `aiChat.css`), в нарисованных 812-кадрах было 20;
старый бейдж `Cursor` гаснет целиком (`opacity .55` у `.agent-work`), а не только рамкой;
композер в A8 получил триггер одобрений (он есть в общем компоненте, в кадре его не рисовали);
A3 показывает текст шагов (в предыдущей версии файла он был потерян при замене на пустые
инстансы), шаг — та же однострочная inline-строка, что и в A2.

---

## 5. Предложенные кадры

Новая страница **`06 · AI`**, питч как у остальных: 1560 по x, ряды через 1080.

| # | Кадр | Размер | x, y | Что показывает |
| ---: | --- | --- | --- | --- |
| A1 | `AI / Chats · new chat` | 1280×800 | 0, 0 | сайдбар Chats + zero-состояние + композер |
| A2 | `AI / Chats · answer + run` | 1280×800 | 1560, 0 | диалог, «Worked for …», шаги, артефакты, цитата, файлы |
| A3 | `AI / Run live · approval` | 1280×800 | 3120, 0 | трасса в работе, статус, Approve/Reject, стоп |
| A4 | `AI / Paused & failed` | 1280×800 | 4680, 0 | карточка вопроса + карточка ошибки с деталями |
| A5 | `AI / Side panel on a page` | 1280×800 | 0, 1080 | панель 400 px: контекст страницы, действия, цитата, меню одобрений |
| A6 | `AI / Document surfaces` | 1280×800 | 1560, 1080 | AI Block (ready + hover), меню «AI» тулбара, инлайн-пилюля + результат, presence в топбаре |
| A7 | `AI / Agents` | 1280×800 | 3120, 1080 | Connect-диалог + presence-бейджи/точки/тултип |
| A8 | `AI / Mobile` | **390×844** | 4680, 1080 | чат на телефоне + dock; (опц. A9: шторка панели) |

Про A8: кадр не 1280×800 намеренно — при 390×844 масштаб 1:1, любое вписывание в 800 ломает
все замеры (композер и dock уезжают за край). Если нужен строго один размер — делать A8
композицией 1280×800 из двух телефонов **без масштаба нельзя** (844 > 800); тогда лучше
отдельная страница `07 · AI · Mobile` с кадрами 390×844.

### A1 — координаты (1280×800)

| Элемент | Бокс |
| --- | --- |
| Сайдбар (reuse 163, Chat active) | 0,0 292×800 |
| Поиск | 12,66 268×36 |
| Табы Home/Chat | 12,110 268×30 (пилюли 133, gap 2), border-bottom y148 |
| New chat | 16,153 260×29 |
| «Chats» | 16,186, текст 11 px на y196 |
| Треды r1..r3 | 16,213 / 259 / 305; 260×45 (с sub) |
| Футер | y745, 292×55 |
| Чат-колонка | 356…1216 (860), контент 380…1192 |
| Топбар | y12…58: menu 382,26; avatar 420,26; «AI» 454; «/» 476; title 494 |
| Zero-блок | 446,454 680×201: hero 34 на 452,454; h2 496; «Actions» y496; сетка 2×334 (x446/x792), 3 ряда по 42, gap 4 |
| Композер | 380,675 812×105; attach 392,742 28; approval 426,742 26; send 1148,742 32 |

### A2 — состав

Топбар «Tighten the onboarding copy»; user-bubble (85 %, r16/br4, 2 строки) справа 772…1192;
«Worked for 1m 9s (20 steps)» 12 px; 3 шага, один раскрыт (`pre` 24 px отступ слева, r8,
max-h 240); ответ: 2 абзаца + список; ряд иконок Copy / Regenerate / Insert into page;
блок Artifacts (2 чипа, r999, max-w 260); над композером цитата (border-left 3 accent)
и 2 файл-чипа; композер обычный.

### A3 — состав

«Working for 12s … (4)»; шаги: Thinking (Brain) / Tool get_page (CircleCheck) /
Tool write_content (⋯ accent) / Tool create_page (AlertTriangle); строка `calling write_content`
12 px opacity .7; `Approve` + `Reject` (btn-sm, 27 px); композер disabled (send «…» opacity .4,
стоп «■» рядом); статус-бар не показан, если шагов ещё нет — это отдельный вариант
(пустое тело + «…»).

### A4 — состав

Карточка вопроса: title с CircleHelp, 3 опции (22×22 номер, label 13/600, desc 12),
вторая выбрана (accent-рамка, заливка accent 12 %, галочка 13); свободное поле; `Submit answer`
(ink) + `Cancel`. Ниже — ошибка: head «Quota exceeded» + код `insufficient_quota`, message,
hint курсивом, `Details` раскрыт (pre 11 mono), кнопки Retry / Copy JSON / Hide details / Dismiss.

### A5 — состав (панель)

Документ на фоне; панель 864…1264, y363…784 (natural height ≈421): шапка 47 (✨ + название +
chevron + «+» + ×); контекст страницы (иконка 15, title 13/600, бейдж «Note»); «Actions»;
3 строки 30 px; «Attach file or CSV»; divider; «Link workspace page or collection»;
цитата `margin: 0 12`; композер 376; открытое меню одобрений 300 px над триггером
(3 режима, выбран «Review for me», галочка 12).

### A6 — состав (документ)

Топбар 47 с presence-бейджем; заголовок страницы; абзац с выделением (accent 30 %);
панель форматирования с кнопкой «✨ AI ⌄»; открытый dropdown 230–340 px: 4 пункта 13 px,
custom-строка с input 12 px и круглой go 24, divider, «Ask in chat»; AI Block 828 px:
header 8/12 (`--hover`, r9 сверху), title 600, hover-toolbar (3 иконки 12), content 12/14;
ниже — inline-пилюля (max 760, h40, r999) с 4 опциями, input, go 26 и карточкой результата
(r12, текст 13, max-h 160) под ней; Replace/Dismiss.

### A7 — состав

Слева Connect-диалог 640, y36…764, но при 800 окне `max-height:86vh` = 688 → показывать
обрезанным по 688 со скроллом (это правда кода). Справа на бумаге: presence-бейдж fresh
(25 px, border currentColor, лого 14, имя 600, заметка muted), stale (opacity .55),
вариант с двумя агентами (без заметок), `.agent-dot` 22 на карточке, точка в строке сайдбара,
карточка тултипа с текстом `Claude · via Ada Lovelace · …`.

---

## 6. Новые компоненты (source + селектор + варианты)

Имена — по конвенции файла (`Type=Value`, `State=Value`), описание слоя = `path#selector`.

| Компонент | Source | Варианты / свойства | Заметки |
| --- | --- | --- | --- |
| `AI / Bubble User` | `AiChatView.tsx` · `.ai-bubble-user` | `With Mention=Off/On`; `Lines=1/2/4`; Text | max-w 85 %, r16/br4 |
| `AI / Answer` | `.ai-bubble-ai`, `.ai-markdown` | `Content=Text/List/Code/Table`; `Actions=Off/Copy/Copy+Regen/Copy+Regen+Insert` | действия 26×26, иконки 14 |
| `AI / Composer` | `.ai-composer` | `State=Empty/Typed/Busy`; `Attachments=Off/On`; `Quote=Off/On`; `Placeholder=View/Panel` | h105, send 32 |
| `AI / Approval Trigger` | `AiApprovalSelect.tsx` | `Mode=Always/Review/Skip` | Hand / ShieldCheck / ShieldOff 15; skip — `#e07d10` |
| `AI / Approval Menu` | там же (inline) | `Mode=Always/Review/Skip`; `State=Open` | 300×~170, r12 |
| `AI / Trace Header` | `.ai-actions-bar` | `State=Collapsed/Expanded`; `Live=On/Off`; `Count=1…` | 12 px, chevron 10 |
| `AI / Trace` | `.ai-actions-list` | `State=Live/Done/Waiting approval`; `Steps=1/4` | border-left 2 |
| `AI / Step` | `AiAgentStep.tsx` · `.ai-action-step-*` | `Kind=Thinking/Tool`; `Status=Running/Done/Error`; `State=Closed/Open` | **CSS нет** — рисовать по факту (inline-строка) либо сначала починить код |
| `AI / Run Summary` | `AiRunSummary.tsx` | `State=Collapsed/Expanded/Loading`; `Steps=7/20` | «Worked for …» |
| `AI / Artifacts` | `.ai-artifacts-inline*` | `Chips=1/2/4` | только полный Chats |
| `AI / Question Card` | `.ai-question-card` | `Option=Off/On/Multiple`; `Desc=Off/On`; `Filled=Off/On` | accent-рамка, номера 22 |
| `AI / Error` | `AiErrorCard.tsx` · `.ai-error-card` | `Category=Auth/Quota/Rate/Model/Context/Timeout/Disabled/Server/Unknown`; `Details=Off/On`; `Retry=Off/On` | 9 категорий, 4 кнопки |
| `AI / Memory Popover` | `AiChatView.tsx` (inline) | `State=Loading/Empty/List`; `Workspace=Off/On` | 320×320, r10 |
| `AI / Mention Menu` | inline, оба файла | `Surface=View/Panel`; `Items=1/3/8` | 260 / 376 шириной |
| `AI / Attach Menu` | `.menu` + inline | — | 2 пункта, над композером |
| `Sidebar / Chat Row` | `AiThreadList.tsx` · `.ai-chat-row` | `State=Default/Hover/Active`; `Unread=Off/On`; `Pinned=Off/On`; `Sub=Off/On` | 260×29/45, r8 |
| `Sidebar / Chat Section` | `.ai-section-label`, `.ai-section-title` | `Kind=Chats/Pinned/Recent` | 11/600 caps |
| `Sidebar / Archived` | `ArchivedChats.tsx` | `State=Closed/Open`; `Empty=On/Off` | 33 % высоты |
| `AI Panel / Header` | `.ai-panel-head` | `Menu=Closed/Open`; `Thread=Off/On` | 47 px |
| `AI Panel / Context` | `.ai-zero-context` | `Kind=Note/Collection` | 33 px, r10 |
| `AI Panel / Action Row` | `.ai-zero-item` | `Tone=Default/Green/Blue/Purple/Plain`; `Size=Desktop/Phone` | 30 / 46 px |
| `AI View / Zero` | `.ai-view-zero*` | `Page=Off/On` | 680 px, 2 колонки |
| `AI Inline / Bar` | `.ai-inline-bar` | `State=Idle/Busy` | 40 px, r999 |
| `AI Inline / Result` | `.ai-inline-result` | `State=Result` | 13 px, max-h 160 |
| `AI / Empty Line` | `AiEmptyLine.tsx` · `.ai-empty` | `State=Idle/Writing/Error` | 15 px, h≈50 |
| `AI / Formatting Menu` | `AiFormattingDropdown.tsx` | `State=Menu/Busy/Result/Error` | 230–340, r10 |
| `AI / Block` | `blocks.tsx` · `.bn-ai-block` | `State=Draft/Ready/Hover/Busy/Error/Read-only` | r10, shadow .06 |
| `Agent / Presence Badge` | `AgentBadge.tsx` · `.agent-work` | `Fresh=On/Off`; `Note=Off/On`; `Count=1/2` | border currentColor |
| `Agent / Dot` | `.agent-dot` | `Fresh=On/Off` | 22 px, ring 2 |
| `Agent / Connect Dialog` | `AgentConnect.tsx` | `How=Sign in/Token`; `Token=Empty/Created`; `Client=9`; `Warn=Off/On` | 640×688 (скролл) |
| `Mobile / Dock` | `MobileDock.tsx` · `.mobile-dock` | `Middle=Search/New chat`; `AI=On/Off` | 48 px, label 10.5 |
| `Mobile / AI Sheet` | `.ai-panel` @≤768 | `State=Zero/Chat` | 88dvh, r18 |

Переиспользовать, не дублировать: `Sidebar` (163/234) как база S2, `Topbar` (137) как база
presence-строки, `Button` (64) + Size=S вместо нового «btn-sm», `Board Card` (121) для точки
агента. `Badge` (55) и `Avatar` (56) в AI не нужны.

---

## 7. Что важно решить до переноса (расхождения кода)

1. **Строки шагов не стилизованы.** `.ai-action-step-item/-head/-title` нигде не описаны
   (`grep` по всему репо), поэтому шаг — обычная inline-кнопка: шеврон, иконка, «Thinking/Tool»,
   заголовок и статус идут подряд без отступов, а `margin-left:auto` у статуса не работает.
   В FigCraft либо рисовать как есть (мелкая инлайн-строка), либо сначала добавить CSS
   (gap 6, flex, статус справа) — иначе макет «улучшит» продукт.
2. **Неопределённые токены:** `--accent-fg`, `--danger-soft`, `--success`, `--warning`,
   `--card-foreground`. В файле соответствующие переменные есть; в коде — литералы
   (`#fff`, `rgba(239,68,68,.08)`, `#10b981`, `#e07d10`). Для 1:1 брать литералы.
3. **Мёртвый CSS:** `.ai-trace`, `.ai-artifacts` (боковая панель), `.ai-artifacts-wrap`,
   `.ai-model-label`, `.ai-approval-pill`, `.ai-section-toggle` — в JSX не встречаются.
   Компоненты по ним не строить.
4. **Артефакты только в полном Chats** (`AiChatView`), в панели их нет.
5. **«Insert into page»** есть только при `pageId` (страница), в глобальном Chats — нет.
6. **Выбора модели в UI нет** — не рисовать; только режим одобрений.
7. **Пустой чат при загрузке истории:** `messages=[]` → на кадре с тредом возможен миг
   zero-состояния; скелетона нет.
8. **Панель 640 диалога при 800 окне** режется `max-height:86vh` (688) — это код, не ошибка макета.
9. **Композиты hover/active**: в файле лежат значения над землёй `#F0EFEA`; AI-слои лежат на
   `--bg`/`--card` — брать из §3.1, иначе hover в чате будет на 3–5 единиц темнее.

## 8. Как проверять после переноса

```bash
CLI="$HOME/Library/Application Support/ArtCraft/mcp/cli/figcraft-cli"
"$CLI" export design/salt-md.figcraft --node <id> --scale 2 -o tmp/agent-ai/a1-2x.png
python3 design/lint_names.py          # у каждого слоя description = path#selector
python3 design/sync_tokens.py --check # если добавляли radius/size/shadow
```

Для `compare.py` нужны эталонные PNG: AI-экранов в `wiki/img` нет. Предложение — снять
`ai-chats`, `ai-panel`, `ai-run`, `ai-error`, `ai-block` с живого инстанса в 1280×800 (2×)
и добавить в `design/screens.json` теми же ключами, что id кадров (A1…A7).
