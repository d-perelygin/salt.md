import type { WorkflowConfig } from './types';

// Client-side mirror of the server guard (server/workflow.go): instant
// feedback before the drag lands. The server stays the source of truth —
// a 409 rolls the optimistic move back.
export function workflowBlockReason(
  workflow: WorkflowConfig | undefined,
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
): string | null {
  if (!workflow || !workflow.statusPropId || from === to || !to) return null;
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) continue;
    if (r.allowFrom && r.allowFrom.length > 0 && !r.allowFrom.includes(from)) {
      return 'This status cannot be reached from here.';
    }
    if (r.precondition?.checklistProp && !checklistDone(rowProps[r.precondition.checklistProp])) {
      return 'Finish the checklist first.';
    }
    if (r.precondition?.requiredProp && isEmpty(rowProps[r.precondition.requiredProp])) {
      return 'Fill the required property first.';
    }
  }
  return null;
}

function checklistDone(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false;
  return (v as { done?: boolean }[]).every((it) => !!it?.done);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}
