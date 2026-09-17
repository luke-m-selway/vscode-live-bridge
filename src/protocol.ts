import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1 as const;

export type Operation =
  | 'status'
  | 'list'
  | 'readText'
  | 'readNotebook'
  | 'replaceText'
  | 'replaceCell'
  | 'insertCell'
  | 'deleteCell';

export interface SnapshotExpectation {
  documentVersion?: number;
  documentHash?: string;
  notebookVersion?: number;
  cellId?: string;
  cellHash?: string;
}

export interface ReadNotebookParams {
  includeOutputs?: boolean;
}

export interface NotebookOutputLimits {
  rawBytes: number;
  items: number;
  groups: number;
}

export interface SerializedNotebookOutputItem {
  mime: string;
  byteLength: number;
  encoding: 'utf8' | 'base64';
  data?: string;
  omitted?: true;
  reason?: 'OUTPUT_LIMIT_EXCEEDED';
}

export interface SerializedNotebookOutputGroup {
  items: SerializedNotebookOutputItem[];
  metadata?: unknown;
  omittedItems?: number;
}

export interface NotebookOutputReadSummary {
  limits: NotebookOutputLimits;
  rawBytesIncluded: number;
  rawBytesOmitted: number;
  itemsRepresented: number;
  itemsOmitted: number;
  groupsRepresented: number;
  groupsOmitted: number;
  truncated: boolean;
}

export interface BridgeRequest {
  protocolVersion: 1;
  id: string;
  operation: Operation;
  target?: string;
  expected?: SnapshotExpectation;
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  protocolVersion: 1;
  id: string;
  status: 'ok' | 'conflict' | 'error' | 'unavailable';
  reason?: string;
  result?: unknown;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const operations: Operation[] = ['status', 'list', 'readText', 'readNotebook', 'replaceText', 'replaceCell', 'insertCell', 'deleteCell'];
  return v.protocolVersion === PROTOCOL_VERSION
    && typeof v.id === 'string'
    && operations.includes(v.operation as Operation);
}
