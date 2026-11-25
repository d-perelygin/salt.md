import { createContext, useContext } from 'react';
import type { PropDef, WorkflowConfig } from './types';
import { workflowBlockReason } from './workflow';

// Marking the status select with the process's own answer.
//
// A status under a workflow accepts some moves and refuses others, and the
// refusal depends on the whole row ("only from Working", "if Type is Reel",
// "needs filled Deadline"). The select used to offer every option as if all of
// them worked, and the person found out from a toast after the fact. This
// context carries the process down to the property cells, and the hook answers
// which options are refused right now — the same guard the save goes through,
// so the mark cannot disagree with what happens on click.
//
// Marks are per option: hidden options would be worse than the toast, because
// a status you cannot see is a status you cannot plan against.

export interface StatusGate {
  workflow?: WorkflowConfig;
  schema: PropDef[];
}

const GateContext = createContext<StatusGate | null>(null);

export const StatusGateProvider = GateContext.Provider;

/** Reasons the status options are refused for this row, keyed by option id.
 *  Undefined when the property is not the process's status (or nothing is
 *  known about the row) — the select then behaves exactly as before. */
export function useBlockedStatuses(
  def: PropDef,
  value: unknown,
  rowProps?: Record<string, unknown>,
): Record<string, string> | undefined {
  const gate = useContext(GateContext);
  const wf = gate?.workflow;
  const schema = gate?.schema;
  if (!wf?.statusPropId || !schema || !rowProps || def.id !== wf.statusPropId) return undefined;
  const from = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  const out: Record<string, string> = {};
  for (const o of def.options ?? []) {
    if (!o || !o.id || o.id === from) continue;
    const why = workflowBlockReason(wf, schema, rowProps, from, o.id);
    if (why) out[o.id] = why.message;
  }
  return out;
}
