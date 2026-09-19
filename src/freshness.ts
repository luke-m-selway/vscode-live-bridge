import { SnapshotExpectation, sha256 } from './protocol';

export type Freshness = 'fresh' | 'missing' | 'stale';

export function checkTextFreshness(expected: SnapshotExpectation | undefined, version: number, text: string): Freshness {
  if (expected?.documentVersion === undefined || !expected.documentHash) return 'missing';
  return expected.documentVersion === version && expected.documentHash === sha256(text) ? 'fresh' : 'stale';
}

export function checkNotebookFreshness(expected: SnapshotExpectation | undefined, version: number): Freshness {
  if (expected?.notebookVersion === undefined) return 'missing';
  return expected.notebookVersion === version ? 'fresh' : 'stale';
}

export function checkCellFreshness(
  expected: SnapshotExpectation | undefined,
  notebookVersion: number,
  cellId: string | undefined,
  source: string | undefined,
  documentVersion?: number,
  requireDocumentVersion = false
): Freshness {
  if (expected?.notebookVersion === undefined || !expected.cellId || !expected.cellHash) return 'missing';
  if (requireDocumentVersion && expected.documentVersion === undefined) return 'missing';
  if (cellId === undefined || source === undefined) return 'stale';
  if (expected.notebookVersion !== notebookVersion || expected.cellId !== cellId || expected.cellHash !== sha256(source)) return 'stale';
  if (requireDocumentVersion && expected.documentVersion !== documentVersion) return 'stale';
  return 'fresh';
}