import type { Prefs } from './i18n';

export interface PageMeta {
  id: string;
  parentId: string | null;
  title: string;
  icon: string;
  cover: string;
  position: number;
  updatedAt: string;
  trashed: boolean;
  type: 'doc' | 'collection';
  props: Record<string, unknown>;
  workspaceId: string;
  ownerId: string;
  visibility: 'workspace' | 'private' | 'restricted';
  isTemplate: boolean;
  tags: string[];
  description: string;
  snippet: string; // plain-text preview for the notes list (derived server-side)
  thumb: string; // first image URL, '' if none
  /** Only on a page in the trash: when it went, and — when the activity log can
   *  say — who sent it there, and whether that was an agent. */
  trashedAt?: string;
  trashedBy?: string;
  trashedByAgent?: boolean;
  /** The page carries a live public link (read-share or form-share). */
  shared?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  icon: string;
  image: string;
  /** This account's own area — it belongs to the account, not the instance. */
  personal?: boolean;
  /** Every newly created account joins automatically (only the owner sets this). */
  autoJoin?: boolean;
  /** Working conventions the admin wrote down — agents get them over MCP, members read them here. */
  rules?: string;
  /** A pending rules draft (usually from an agent) — inert until an admin applies it. */
  // Empty means the default in both cases — 'open' and 'split'. There is no
  // third state, so nothing has to handle one.
  agentAccess?: string;
  treeMode?: string;
  rulesProposal?: string;
  rulesProposalBy?: string;
  rulesProposalAt?: string;
}

/** One entry of the file index (W125): a file plus the page carrying it. */
export interface SaltFile {
  /** Stored name — the segment behind /files/. */
  name: string;
  displayName: string;
  ext: string;
  size: number;
  createdAt: string;
  pageId: string;
  pageTitle: string;
  workspaceId: string;
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  actorType: 'human' | 'agent';
  actorName: string;
  action: string;
  pageId: string;
  detail: string;
  /** The server offers a take-back only where it recorded a before/after. */
  revertible?: boolean;
  pageTitle?: string;
}

export interface Page extends PageMeta {
  content: unknown[];
  createdAt: string;
  /** The generation of this body (server/docgen.go); absent from a server
   *  that predates it. */
  docGen?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  icon: string;
  snippet: string;
  /** Workspace the hit lives in, so the palette can name it. */
  workspaceId: string;
  /** Collection holding the hit; present only for collection rows. */
  parentId?: string;
  parentTitle?: string;
}

export interface Backlink {
  id: string;
  title: string;
  icon: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
  avatar: string;
  isAdmin: boolean;
  /** Instanzrolle: owner betreibt die Instanz, admin verwaltet Menschen. */
  orgRole?: 'owner' | 'admin' | 'member';
  /** Deactivated: no sign-in, but everything stays attributable. */
  disabled?: boolean;
  /** AI features turned off specifically for this account by an admin. */
  aiDisabled?: boolean;
}

export interface Me {
  setupRequired: boolean;
  authenticated: boolean;
  user: User | null;
  version: string;
  // May non-admins create workspaces of their own? (instance setting, W97)
  allowUserWorkspaces?: boolean;
  /** Whether AI features are active for the current session (instance + user). */
  aiEnabled?: boolean;
  /** Language and time preferences of this account (W112). Empty fields mean
   *  automatic — see server/prefs.go. */
  prefs?: Prefs;
}

/** An outbound webhook: salt.md calls this URL when something happens, so
 *  other tools do not have to keep asking. The secret is returned once, when
 *  it is created, and never again. */
export interface Webhook {
  id: string;
  url: string;
  events: string;
  active: boolean;
  createdAt: string;
  lastStatus: string;
  lastAt: string;
  secret?: string;
}

export interface Revision {
  id: string;
  createdAt: string;
  authorName: string;
  title: string;
}

export interface Comment {
  id: string;
  blockId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  authorColor?: string;
  authorAvatar?: string;
  resolvedAt: string | null;
}

// One entry of a page's raw trail. No resolvedAt, no editedAt and no author id
// to check against: nothing about it can change after it is written, which is
// the entire point (server/notelog.go).
export interface PageNote {
  id: string;
  body: string;
  author: string; // the account — verified
  agent?: string; // what an agent called itself — a claim
  label?: string;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  scope: 'read' | 'write';
  workspaces: string[]; // empty = all the user's workspaces
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string;
}

export type PropType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'checkbox'
  | 'checklist'
  | 'url'
  | 'person'
  | 'relation'
  | 'backrelation'
  | 'rollup'
  | 'formula'
  | 'lastActivity';

/** One sub-task of a checklist property. Progress is derived from these — a
    stored percentage would be a second truth to keep in sync. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface PropOption {
  id: string;
  name: string;
  color: string;
}

export interface PropDef {
  id: string;
  name: string;
  type: PropType;
  options?: PropOption[];
  // relation: which collection this links to
  relationCollection?: string;
  // rollup: aggregate a target property over a relation
  rollupRelation?: string;
  rollupTarget?: string;
  rollupAgg?: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'percent';
  // rollup: count/sum only the related rows meeting this condition — the
  // difference between "how many tasks" and "how many are done".
  rollupWhereProp?: string;
  rollupWhereOp?: 'is' | 'is_not' | 'is_empty' | 'is_not_empty' | 'contains';
  rollupWhereValue?: string;
  // Several values, for is / is_not. "Open" means neither done NOR discarded,
  // and one comparison cannot say that. Empty falls back to rollupWhereValue,
  // so conditions written before this keep their meaning exactly.
  rollupWhereValues?: string[];
  // backrelation: the other side of a relation someone else declared. Computed
  // at read time, never stored — see backrelationIDs in derived.go.
  backrelationCollection?: string;
  backrelationProp?: string;
  // formula: expression over other props, {propId} references
  formula?: string;
  // number/rollup/formula: render a numeric value as a plain number (default),
  // a progress bar, or a ring. numberMax is the value that = 100% (default 100).
  numberDisplay?: 'plain' | 'bar' | 'ring';
  numberMax?: number;
  // person (#11): several people may be picked, and the value is then a list
  // of them; and who may be picked at all, by user id — empty means every
  // member, which is how a person property has always behaved.
  personMultiple?: boolean;
  personPool?: string[];
}

export type FilterOp =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'between'
  | 'is_empty'
  | 'is_not_empty';

export interface Filter {
  property: string;
  op?: FilterOp; // default 'is'; legacy empty value = is_not_empty
  value: string;
  /** Several values for is/is_not — "class is none of A, H" as ONE condition
   *  rather than two rows that happen to sit next to each other. When present it
   *  replaces `value`; a filter never carries both. */
  values?: string[];
  /** Upper bound of `between`, inclusive. A range is value…value2. */
  value2?: string;
}

export interface Sort {
  property: string;
  dir: 'asc' | 'desc';
}

/** The one filter condition that is not about a column: whether the row is a
 *  template. A pseudo-property, so it travels in the same Filter shape as
 *  everything else. The server knows this id, and so does the sort picker
 *  below for its own two pseudo-properties. */
export const TEMPLATE_FILTER = '@template';

/** The two orders that are not about a column: when the row was made and when
 *  it was last touched. Pseudo-properties, like the template condition — a view
 *  saves them in the same Sort shape as any column. */
export const SORT_CREATED = '@created';
export const SORT_UPDATED = '@updated';

/** A reference to a column or to one of the system pseudo-properties above:
 *  anything a saved view can point at that no schema edit can remove. */
export const isSystemRef = (id: string) =>
  id === TEMPLATE_FILTER || id === SORT_CREATED || id === SORT_UPDATED;

/** Visible span of calendar and timeline views. */
export type SpanMode = 'day' | 'week' | 'month' | '2months' | 'year';

export interface ViewDef {  id: string;
  name: string;
  type: 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'form' | 'timeline';
  groupBy?: string;
  dateProp?: string; // calendar/timeline view: date property (timeline: start)
  /** Calendar view: which span the grid shows. Older views carry calRange
   *  instead (1 = month, 2 = two months); calMode wins when both are set. */
  calMode?: SpanMode;
  /** Timeline view: which window it shows. Defaults to a month. */
  tlMode?: SpanMode;
  /** Timeline view: the sticky title column is collapsed, leaving the axis. */
  tlHideLabels?: boolean;
  /** Timeline view: shifting a row out of its blockers' way lands on a working
   *  day rather than on a Saturday. */
  tlSkipWeekends?: boolean;
  /** Table view: columns pinned to the left edge, so they stay on screen while
   *  the rest of the table scrolls sideways. Column keys, in pin order. */
  stuckCols?: string[];
  calRange?: 1 | 2; // deprecated: superseded by calMode, still read as a fallback
  endDateProp?: string; // timeline view: optional end-date property (else 1-day bar)
  depProp?: string; // timeline view: self-relation property whose ids block this row
  hidden?: string[]; // property ids hidden in this view
  filters?: Filter[];
  /** OR groups: conditions inside one group are ANDed, groups are ORed. When
   *  present it wins over `filters`; the flat list then mirrors the first
   *  group for older readers. Absent means the flat list is the whole filter. */
  filterGroups?: Filter[][];
  /** The unscheduled tray's own filters (calendar/timeline views). Same shape
   *  as the view's, but scoped to the tray: when present the tray shows rows
   *  passing these instead of `filters`/`filterGroups`. Absent means inherit —
   *  the tray follows the view. Editing them back to the view's collapses to
   *  absent again, so there is never a stale copy to drift. */
  trayFilters?: Filter[];
  trayFilterGroups?: Filter[][];
  sort?: Sort | null;
  formTitle?: string; // form view: heading above the form
  formDesc?: string; // form view: description under the heading
  formSubmit?: string; // form view: submit-button label
  subItemProp?: string; // table view: a self-relation prop whose value = child rows (renders a tree)
  // table view: pixel widths the reader dragged, by property id ('__title' for
  // the name column). A column that is not in here sizes itself to its content;
  // only the ones somebody deliberately set are pinned. Stored on the VIEW, so
  // two views of the same database can be laid out for different jobs.
  colWidths?: Record<string, number>;
}

export interface CollectionConfig {
  schema: PropDef[];
  views: ViewDef[];
  /** New rows are made from this template: duplicating it, then overwriting
   *  with what the + button prescribes (the column, the day). Empty (or a
   *  template that is gone) means plain blank rows. */
  newFromTemplate?: string;
  /** Lightweight business process: which select property is the status and
   *  which rules run on transitions. Absent = no process, everything allowed. */
  workflow?: WorkflowConfig;
}

/** One automation rule in Apple Shortcuts style: When → Then, with an
 *  optional collapsed If precondition and an optional allow-list of sources.
 *  Kept deliberately flat: one trigger, one condition, N actions. */
export interface WorkflowRule {
  id: string;
  /** Trigger: status change or row creation. */
  when: { type: 'status_to'; to: string } | { type: 'created' };
  /** Optional source allow-list: transition is allowed only from these
   *  status option ids. Empty/absent = from anywhere. */
  allowFrom?: string[];
  /** Optional value matchers: the rule fires only when every one holds
   *  against the row (AND). Unlike the precondition below, a mismatch never
   *  blocks — the rule is simply skipped, so sister rules for other values
   *  can take the same transition. */
  whenProps?: WorkflowPropCond[];
  /** Optional precondition, checked against the row BEFORE the transition. */
  precondition?: {
    /** Checklist property id that must be 100% done. */
    checklistProp?: string;
    /** Property id that must be non-empty. */
    requiredProp?: string;
  };
  do: WorkflowAction[];
}

/** A row-value condition: property `prop` is (or is not) `value`. Selects
 *  compare option ids, multiselects contain them, text and numbers compare
 *  as written. Only these four types are offered in the editor. */
export interface WorkflowPropCond {
  prop: string;
  op: 'is' | 'is_not';
  value: string;
}

export type WorkflowAction =
  | { type: 'set_prop'; prop: string; value: unknown }
  | { type: 'set_today'; prop: string }
  | { type: 'assign_me'; prop: string }
  | { type: 'webhook'; url: string }
  /** Ask the mover to fill a property before the move lands. `if_empty`
   *  skips the question when the row already has a value; `always` asks
   *  every time. Doubles as the requirement for API callers, who get a 409
   *  naming the missing property instead of a dialog. */
  | { type: 'require_prop'; prop: string; mode: 'always' | 'if_empty' }
  /** Ask the mover for a comment, posted to the row's own comments.
   *  UI-only: there is nobody to ask over the API. */
  | { type: 'require_comment'; mode: 'always' | 'if_empty' };

export interface WorkflowConfig {
  /** Select property id driving the process. */
  statusPropId: string;
  rules: WorkflowRule[];
}

/** Every condition in a config carries a `value`, even the ones whose question
 *  is asked through `values` (a set) or through nothing at all (is_empty). The
 *  interface writes it that way, and `checkViewFilter` fills it in for anything
 *  an agent saves, so a filter without one is either older than that or came
 *  from a client that did not know. The row matcher resolves relative days
 *  through `value.toLowerCase()` — which is where a missing one took a whole
 *  view down with "Cannot read properties of undefined" — so it is filled in
 *  once, here, before any view reads it. */
export function normalizeCollectionConfig(cfg: CollectionConfig): CollectionConfig {
  const withValue = (f: Filter): Filter => ((f as Filter | undefined)?.value === undefined ? { ...f, value: '' } : f);
  for (const view of cfg.views ?? []) {
    if (view.filters) view.filters = view.filters.map(withValue);
    if (view.filterGroups) view.filterGroups = view.filterGroups.map((g) => g.map(withValue));
  }
  if (!Array.isArray(cfg.views)) cfg.views = [];
  if (!Array.isArray(cfg.schema)) cfg.schema = [];
  if (cfg.workflow && typeof cfg.workflow === 'object') {
    if (typeof cfg.workflow.statusPropId !== 'string') cfg.workflow.statusPropId = '';
    if (!Array.isArray(cfg.workflow.rules)) cfg.workflow.rules = [];
    // A rule is blank (dropped) only when it carries nothing at all: no
    // actions AND no gate or matcher. A pure guard — empty do list but an
    // allow-list, a precondition or value conditions — is meaningful and
    // stays, with do defaulted for the editor.
    const hasGate = (r: WorkflowRule) =>
      (r.allowFrom ?? []).length > 0 || !!r.precondition || (r.whenProps ?? []).length > 0;
    cfg.workflow.rules = cfg.workflow.rules
      .filter((r) => r && r.when && (Array.isArray(r.do) || hasGate(r)))
      .map((r) => ({ ...r, do: Array.isArray(r.do) ? r.do : [] }));
  }
  return cfg;
}

// Public form config served (unauthenticated) at /api/public/form/{token} —
// only the fillable field defs, never rows or the rest of the workspace.
export interface PublicFormConfig {
  title: string;
  icon: string;
  formTitle?: string;
  formDesc?: string;
  formSubmit?: string;
  schema: PropDef[];
}

// Public collection config served (unauthenticated) at /api/public/c/{token} —
// only the shared views and schema, never the rest of the workspace.
export interface PublicCollectionConfig {
  title: string;
  icon: string;
  cover: string;
  description: string;
  type: string;
  schema: PropDef[];
  views: ViewDef[];
  allowDetail: boolean;
}

// One item on the blueprint shelf (see server/library.go). Everything from
// `databases` down is READ OUT OF THE BLUEPRINT by the server, never written
// beside it — the preview built from this cannot promise something the
// blueprint does not contain.
export interface BlueprintEntry {
  id: string;
  title: string;
  tagline: string;
  icon: string;
  accent: string;
  tags: string[];
  price: string; // empty = free
  source: string; // 'built-in'
  databases: BlueprintDatabase[];
  rules: string;
}

export interface BlueprintDatabase {
  title: string;
  icon: string;
  description: string;
  props: BlueprintProp[];
  views: { name: string; type: string }[];
}

export interface BlueprintProp {
  name: string;
  type: string;
  options?: { name: string; color?: string }[];
}

// A connection an agent signed in for (server/oauth_provider.go). The counterpart
// to an API token, except it expires on its own and can be ended from here.
export interface OAuthGrant {
  id: string;
  clientName: string;
  scope: string;
  workspaces: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string;
}

/** What GET /api/update answers. Admins only — a member's browser gets a 403
 *  and the banner renders nothing. `available` is already the comparison's
 *  verdict, so the client never has to know how versions are ordered. */
export type UpdateInfo = {
  available: boolean;
  current: string;
  latest?: string;
  url?: string;
  checkedAt?: string;
  enabled: boolean;
};
