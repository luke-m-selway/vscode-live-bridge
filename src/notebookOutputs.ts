import {
  NotebookOutputLimits,
  NotebookOutputReadSummary,
  SerializedNotebookOutputGroup
} from './protocol';

export const DEFAULT_NOTEBOOK_OUTPUT_LIMITS: NotebookOutputLimits = {
  rawBytes: 1024 * 1024,
  items: 100,
  groups: 100
};

export interface NotebookOutputItemLike {
  mime: string;
  data: Uint8Array;
}

export interface NotebookOutputGroupLike {
  items: readonly NotebookOutputItemLike[];
  metadata?: unknown;
}

export interface NotebookOutputBudget {
  readonly limits: NotebookOutputLimits;
  rawBytesIncluded: number;
  rawBytesOmitted: number;
  itemsRepresented: number;
  itemsOmitted: number;
  groupsRepresented: number;
  groupsOmitted: number;
}

export function createNotebookOutputBudget(
  limits: NotebookOutputLimits = DEFAULT_NOTEBOOK_OUTPUT_LIMITS
): NotebookOutputBudget {
  return {
    limits,
    rawBytesIncluded: 0,
    rawBytesOmitted: 0,
    itemsRepresented: 0,
    itemsOmitted: 0,
    groupsRepresented: 0,
    groupsOmitted: 0
  };
}

function normalizedMime(mime: string): string {
  return mime.split(';', 1)[0].trim().toLowerCase();
}

export function outputEncoding(mime: string): 'utf8' | 'base64' {
  const value = normalizedMime(mime);
  if (
    value.startsWith('text/')
    || value === 'application/json'
    || value.endsWith('+json')
    || value === 'application/javascript'
    || value === 'application/xml'
    || value.endsWith('+xml')
    || value === 'image/svg+xml'
    || value === 'application/vnd.code.notebook.stdout'
    || value === 'application/vnd.code.notebook.stderr'
    || value === 'application/vnd.code.notebook.error'
  ) return 'utf8';
  return 'base64';
}

function omitWholeGroup(group: NotebookOutputGroupLike, budget: NotebookOutputBudget): void {
  budget.groupsOmitted += 1;
  budget.itemsOmitted += group.items.length;
  budget.rawBytesOmitted += group.items.reduce((total, item) => total + item.data.byteLength, 0);
}

export function serializeNotebookOutputGroups(
  groups: readonly NotebookOutputGroupLike[],
  budget: NotebookOutputBudget
): SerializedNotebookOutputGroup[] {
  const result: SerializedNotebookOutputGroup[] = [];

  for (const group of groups) {
    if (budget.groupsRepresented >= budget.limits.groups) {
      omitWholeGroup(group, budget);
      continue;
    }

    budget.groupsRepresented += 1;
    const serialized: SerializedNotebookOutputGroup = {
      items: [],
      ...(group.metadata === undefined ? {} : { metadata: group.metadata })
    };
    let omittedItems = 0;

    for (const item of group.items) {
      const byteLength = item.data.byteLength;
      if (budget.itemsRepresented >= budget.limits.items) {
        budget.itemsOmitted += 1;
        budget.rawBytesOmitted += byteLength;
        omittedItems += 1;
        continue;
      }

      budget.itemsRepresented += 1;
      const encoding = outputEncoding(item.mime);
      const base = { mime: item.mime, byteLength, encoding } as const;
      if (budget.rawBytesIncluded + byteLength > budget.limits.rawBytes) {
        budget.itemsOmitted += 1;
        budget.rawBytesOmitted += byteLength;
        serialized.items.push({ ...base, omitted: true, reason: 'OUTPUT_LIMIT_EXCEEDED' });
        continue;
      }

      budget.rawBytesIncluded += byteLength;
      serialized.items.push({
        ...base,
        data: Buffer.from(item.data).toString(encoding)
      });
    }

    if (omittedItems > 0) serialized.omittedItems = omittedItems;
    result.push(serialized);
  }

  return result;
}

export function notebookOutputSummary(budget: NotebookOutputBudget): NotebookOutputReadSummary {
  return {
    limits: budget.limits,
    rawBytesIncluded: budget.rawBytesIncluded,
    rawBytesOmitted: budget.rawBytesOmitted,
    itemsRepresented: budget.itemsRepresented,
    itemsOmitted: budget.itemsOmitted,
    groupsRepresented: budget.groupsRepresented,
    groupsOmitted: budget.groupsOmitted,
    truncated: budget.rawBytesOmitted > 0 || budget.itemsOmitted > 0 || budget.groupsOmitted > 0
  };
}
