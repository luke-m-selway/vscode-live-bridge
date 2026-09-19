import * as vscode from 'vscode';
import { promises as fs, watch as watchFs, FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, bridgePaths, ensureBridgeDirs } from './ipc';
import { BridgeRequest, BridgeResponse, DEFAULT_EXECUTION_TIMEOUT_MS, isBridgeRequest, MAX_EXECUTION_TIMEOUT_MS, PROTOCOL_VERSION, ReadNotebookParams, sha256 } from './protocol';
import { checkCellFreshness, checkNotebookFreshness, checkTextFreshness } from './freshness';
import { createNotebookOutputBudget, notebookOutputSummary, serializeNotebookOutputGroups } from './notebookOutputs';

const ENABLED_KEY = 'vscodeLiveBridge.enabled';
const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';
const JUPYTER_NOTEBOOK_TYPE = 'jupyter-notebook';
// Notebook providers can emit follow-up version changes after applyEdit resolves.
const NOTEBOOK_SETTLE_QUIET_MS = 150;
const NOTEBOOK_SETTLE_TIMEOUT_MS = 1500;
const cellIds = new WeakMap<vscode.NotebookCell, string>();
let requestWatcher: FSWatcher | undefined;
let fallbackTimer: NodeJS.Timeout | undefined;
let processing = false;
let output: vscode.OutputChannel;

async function waitForNotebookQuiescence(notebook: vscode.NotebookDocument): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let listener: vscode.Disposable | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      listener?.dispose();
      resolve();
    };

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, NOTEBOOK_SETTLE_QUIET_MS);
    };

    listener = vscode.workspace.onDidChangeNotebookDocument(event => {
      if (event.notebook === notebook) armQuietTimer();
    });
    timeoutTimer = setTimeout(finish, NOTEBOOK_SETTLE_TIMEOUT_MS);
    armQuietTimer();
  });
}

function cellId(cell: vscode.NotebookCell): string {
  let id = cellIds.get(cell);
  if (!id) {
    id = randomUUID();
    cellIds.set(cell, id);
  }
  return id;
}

function response(id: string, status: BridgeResponse['status'], reason?: string, result?: unknown): BridgeResponse {
  return { protocolVersion: PROTOCOL_VERSION, id, status, ...(reason ? { reason } : {}), ...(result === undefined ? {} : { result }) };
}

function samePath(uri: vscode.Uri, target: string): boolean {
  if (uri.scheme !== 'file') return false;
  return path.resolve(uri.fsPath) === path.resolve(target);
}

function isTargetAllowed(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false;
  const openText = vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString());
  const openNotebook = vscode.workspace.notebookDocuments.some(doc => doc.uri.toString() === uri.toString());
  return openText || openNotebook || vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

async function resolveText(target: string): Promise<vscode.TextDocument> {
  const open = vscode.workspace.textDocuments.find(doc => samePath(doc.uri, target) && doc.uri.scheme === 'file');
  if (open) return open;
  const uri = vscode.Uri.file(target);
  if (!isTargetAllowed(uri)) throw new Error('TARGET_OUTSIDE_TRUSTED_WORKSPACE');
  return vscode.workspace.openTextDocument(uri);
}

async function resolveNotebook(target: string): Promise<vscode.NotebookDocument> {
  const open = vscode.workspace.notebookDocuments.find(doc => samePath(doc.uri, target));
  if (open) return open;
  const uri = vscode.Uri.file(target);
  if (!isTargetAllowed(uri)) throw new Error('TARGET_OUTSIDE_TRUSTED_WORKSPACE');
  return vscode.workspace.openNotebookDocument(uri);
}

function textSnapshot(doc: vscode.TextDocument) {
  const text = doc.getText();
  return { uri: doc.uri.toString(), languageId: doc.languageId, version: doc.version, isDirty: doc.isDirty, text, hash: sha256(text) };
}

function notebookSnapshot(doc: vscode.NotebookDocument, includeOutputs = false) {
  const outputBudget = includeOutputs ? createNotebookOutputBudget() : undefined;
  const snapshot = {
    uri: doc.uri.toString(),
    version: doc.version,
    isDirty: doc.isDirty,
    cells: doc.getCells().map((cell, index) => {
      const source = cell.document.getText();
      const isCode = cell.kind === vscode.NotebookCellKind.Code;
      const base = {
        cellId: cellId(cell),
        index,
        kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
        languageId: cell.document.languageId,
        documentVersion: cell.document.version,
        source,
        hash: sha256(source)
      };
      if (!outputBudget || !isCode) return base;
      const executionSummary = cell.executionSummary;
      return {
        ...base,
        outputs: serializeNotebookOutputGroups(cell.outputs, outputBudget),
        ...(executionSummary ? {
          executionSummary: {
            executionOrder: executionSummary.executionOrder,
            success: executionSummary.success,
            ...(executionSummary.timing ? {
              timing: {
                startTime: executionSummary.timing.startTime,
                endTime: executionSummary.timing.endTime
              }
            } : {})
          }
        } : {})
      };
    })
  };
  if (!outputBudget) return snapshot;
  return { ...snapshot, outputRead: notebookOutputSummary(outputBudget) };
}

function requireTextFresh(req: BridgeRequest, doc: vscode.TextDocument): BridgeResponse | undefined {
  const freshness = checkTextFreshness(req.expected, doc.version, doc.getText());
  if (freshness === 'missing') return response(req.id, 'error', 'MISSING_SNAPSHOT_EXPECTATION');
  if (freshness === 'stale') return response(req.id, 'conflict', 'STALE_SNAPSHOT');
  return undefined;
}

function requireNotebookFresh(req: BridgeRequest, notebook: vscode.NotebookDocument): BridgeResponse | undefined {
  const freshness = checkNotebookFreshness(req.expected, notebook.version);
  if (freshness === 'missing') return response(req.id, 'error', 'MISSING_SNAPSHOT_EXPECTATION');
  if (freshness === 'stale') return response(req.id, 'conflict', 'STALE_SNAPSHOT');
  return undefined;
}

function findExpectedCell(req: BridgeRequest, notebook: vscode.NotebookDocument): { cell?: vscode.NotebookCell; error?: BridgeResponse } {
  const expectedId = req.expected?.cellId;
  const cell = expectedId ? notebook.getCells().find(item => cellId(item) === expectedId) : undefined;
  const freshness = checkCellFreshness(
    req.expected,
    notebook.version,
    cell ? cellId(cell) : undefined,
    cell?.document.getText(),
    cell?.document.version,
    req.operation === 'replaceCell' || req.operation === 'executeCell'
  );
  if (freshness === 'missing') return { error: response(req.id, 'error', 'MISSING_SNAPSHOT_EXPECTATION') };
  if (freshness === 'stale' || !cell) return { error: response(req.id, 'conflict', 'STALE_SNAPSHOT') };
  return { cell };
}

async function requireSelectedJupyterKernel(req: BridgeRequest, notebook: vscode.NotebookDocument): Promise<BridgeResponse | undefined> {
  if (notebook.notebookType !== JUPYTER_NOTEBOOK_TYPE) {
    return response(req.id, 'error', 'UNSUPPORTED_NOTEBOOK_TYPE');
  }
  const extension = vscode.extensions.getExtension<any>(JUPYTER_EXTENSION_ID);
  if (!extension) return response(req.id, 'error', 'JUPYTER_EXTENSION_UNAVAILABLE');

  try {
    const api = await extension.activate();
    if (api?.ready) await api.ready;
    const hasEnvironmentApi = typeof api?.getPythonEnvironment === 'function';
    const environment = hasEnvironmentApi ? await api.getPythonEnvironment(notebook.uri) : undefined;
    if (environment) return undefined;

    const kernels = api?.kernels;
    const hasKernelApi = typeof kernels?.getKernel === 'function';
    if (!hasEnvironmentApi && !hasKernelApi) {
      return response(req.id, 'error', 'JUPYTER_KERNEL_STATE_UNAVAILABLE');
    }
    const kernel = hasKernelApi ? await kernels.getKernel(notebook.uri) : undefined;
    if (kernel) return undefined;
    return response(req.id, 'error', 'NO_SELECTED_JUPYTER_KERNEL');
  } catch {
    return response(req.id, 'error', 'JUPYTER_KERNEL_STATE_UNAVAILABLE');
  }
}

async function applyText(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const doc = await resolveText(req.target);
  const stale = requireTextFresh(req, doc); if (stale) return stale;
  const next = req.params?.text;
  if (typeof next !== 'string') return response(req.id, 'error', 'TEXT_REQUIRED');
  const current = doc.getText();
  const startRaw = req.params?.start;
  const endRaw = req.params?.end;
  const start = startRaw === undefined ? 0 : Number(startRaw);
  const end = endRaw === undefined ? current.length : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > current.length) return response(req.id, 'error', 'INVALID_RANGE');
  const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
  const visibleEditor = vscode.window.visibleTextEditors.find(editor => editor.document === doc);
  if (visibleEditor) {
    const applied = await visibleEditor.edit(builder => builder.replace(range, next), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) return response(req.id, 'error', 'APPLY_EDIT_FAILED');
  } else {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, next);
    if (!await vscode.workspace.applyEdit(edit)) return response(req.id, 'error', 'APPLY_EDIT_FAILED');
  }
  return response(req.id, 'ok', undefined, textSnapshot(doc));
}

async function replaceCell(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const notebook = await resolveNotebook(req.target);
  const found = findExpectedCell(req, notebook); if (found.error || !found.cell) return found.error!;
  const next = req.params?.text;
  if (typeof next !== 'string') return response(req.id, 'error', 'TEXT_REQUIRED');
  const cell = found.cell;
  const index = notebook.getCells().indexOf(cell);
  const stableId = cellId(cell);
  const data = new vscode.NotebookCellData(cell.kind, next, cell.document.languageId);
  data.metadata = cell.metadata;
  data.outputs = [...cell.outputs];
  data.executionSummary = cell.executionSummary;
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [data])]);
  if (!await vscode.workspace.applyEdit(edit)) return response(req.id, 'error', 'APPLY_EDIT_FAILED');
  const replacement = notebook.cellAt(index);
  cellIds.set(replacement, stableId);
  await waitForNotebookQuiescence(notebook);
  return response(req.id, 'ok', undefined, notebookSnapshot(notebook));
}

async function insertCell(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const notebook = await resolveNotebook(req.target);
  const found = findExpectedCell(req, notebook); if (found.error || !found.cell) return found.error!;
  const ref = found.cell;
  const index = notebook.getCells().indexOf(ref);
  const position = req.params?.position === 'before' ? 'before' : 'after';
  const kind = req.params?.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
  const source = typeof req.params?.text === 'string' ? req.params.text : '';
  const languageId = typeof req.params?.languageId === 'string'
    ? req.params.languageId
    : kind === vscode.NotebookCellKind.Markup ? 'markdown' : (ref.document.languageId || 'python');
  const data = new vscode.NotebookCellData(kind, source, languageId);
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index + (position === 'after' ? 1 : 0), [data])]);
  if (!await vscode.workspace.applyEdit(edit)) return response(req.id, 'error', 'APPLY_EDIT_FAILED');
  await waitForNotebookQuiescence(notebook);
  return response(req.id, 'ok', undefined, notebookSnapshot(notebook));
}

async function deleteCell(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const notebook = await resolveNotebook(req.target);
  const found = findExpectedCell(req, notebook); if (found.error || !found.cell) return found.error!;
  const index = notebook.getCells().indexOf(found.cell);
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(index, index + 1))]);
  if (!await vscode.workspace.applyEdit(edit)) return response(req.id, 'error', 'APPLY_EDIT_FAILED');
  await waitForNotebookQuiescence(notebook);
  return response(req.id, 'ok', undefined, notebookSnapshot(notebook));
}

async function saveNotebook(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const notebook = await resolveNotebook(req.target);
  const stale = requireNotebookFresh(req, notebook); if (stale) return stale;
  if (notebook.isUntitled || notebook.uri.scheme !== 'file') return response(req.id, 'error', 'NOTEBOOK_NOT_FILE_BACKED');
  if (!await notebook.save()) return response(req.id, 'error', 'SAVE_FAILED');
  return response(req.id, 'ok', undefined, notebookSnapshot(notebook));
}

function outputFingerprint(cell: vscode.NotebookCell): string {
  return JSON.stringify(cell.outputs.map(group => ({
    metadata: group.metadata,
    items: group.items.map(item => ({ mime: item.mime, data: Buffer.from(item.data).toString('base64') }))
  })));
}

function hasExecutionError(cell: vscode.NotebookCell): boolean {
  return cell.outputs.some(group => group.items.some(item => item.mime === 'application/vnd.code.notebook.error'));
}

async function executeNotebookCell(
  notebook: vscode.NotebookDocument,
  index: number,
  timeoutMs: number
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      vscode.commands.executeCommand('notebook.cell.execute', {
        ranges: [new vscode.NotebookRange(index, index + 1)],
        document: notebook.uri,
        autoReveal: false
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('EXECUTION_TIMEOUT')), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeCell(req: BridgeRequest): Promise<BridgeResponse> {
  if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
  const notebook = await resolveNotebook(req.target);
  let found = findExpectedCell(req, notebook); if (found.error || !found.cell) return found.error!;
  if (found.cell.kind !== vscode.NotebookCellKind.Code) return response(req.id, 'error', 'CELL_NOT_EXECUTABLE');
  const kernelError = await requireSelectedJupyterKernel(req, notebook); if (kernelError) return kernelError;
  // Kernel-state discovery can activate Jupyter and yield; revalidate immediately before running code.
  found = findExpectedCell(req, notebook); if (found.error || !found.cell) return found.error!;
  const cell = found.cell;
  if (cell.kind !== vscode.NotebookCellKind.Code) return response(req.id, 'error', 'CELL_NOT_EXECUTABLE');
  const index = notebook.getCells().indexOf(cell);
  const beforeSummary = JSON.stringify(cell.executionSummary ?? null);
  const beforeOutputs = outputFingerprint(cell);
  const requestedTimeout = req.params?.timeoutMs;
  const timeoutMs = requestedTimeout === undefined ? DEFAULT_EXECUTION_TIMEOUT_MS : Number(requestedTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
    return response(req.id, 'error', 'INVALID_EXECUTION_TIMEOUT');
  }
  try {
    await executeNotebookCell(notebook, index, timeoutMs);
  } catch (error) {
    return response(req.id, 'error', error instanceof Error ? error.message : 'EXECUTION_FAILED');
  }
  await waitForNotebookQuiescence(notebook);
  const current = notebook.getCells().find(item => cellId(item) === req.expected?.cellId);
  if (!current) return response(req.id, 'error', 'EXECUTED_CELL_MISSING');
  const summaryChanged = JSON.stringify(current.executionSummary ?? null) !== beforeSummary;
  const outputsChanged = outputFingerprint(current) !== beforeOutputs;
  if (!summaryChanged && !outputsChanged) return response(req.id, 'error', 'EXECUTION_NOT_CONFIRMED');
  const snapshot = notebookSnapshot(notebook, true);
  const executed = snapshot.cells.find(item => item.cellId === req.expected?.cellId);
  const success = current.executionSummary?.success ?? !hasExecutionError(current);
  return response(req.id, 'ok', undefined, {
    execution: {
      completed: true,
      success,
      executionOrder: current.executionSummary?.executionOrder
    },
    notebook: snapshot,
    cell: executed
  });
}

async function handle(req: BridgeRequest, context: vscode.ExtensionContext): Promise<BridgeResponse> {
  if (req.operation === 'status') {
    return response(req.id, 'ok', undefined, {
      enabled: context.globalState.get<boolean>(ENABLED_KEY, false),
      workspaceTrusted: vscode.workspace.isTrusted,
      bridgeRoot: bridgePaths().root
    });
  }
  if (!context.globalState.get<boolean>(ENABLED_KEY, false)) return response(req.id, 'unavailable', 'BRIDGE_DISABLED');
  if (!vscode.workspace.isTrusted) return response(req.id, 'unavailable', 'WORKSPACE_UNTRUSTED');

  switch (req.operation) {
    case 'list':
      return response(req.id, 'ok', undefined, {
        textDocuments: vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file').map(textSnapshot),
        notebooks: vscode.workspace.notebookDocuments.map(doc => notebookSnapshot(doc))
      });
    case 'readText': {
      if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
      const uri = vscode.Uri.file(req.target); if (!isTargetAllowed(uri)) return response(req.id, 'error', 'TARGET_OUTSIDE_TRUSTED_WORKSPACE');
      return response(req.id, 'ok', undefined, textSnapshot(await resolveText(req.target)));
    }
    case 'readNotebook': {
      if (!req.target) return response(req.id, 'error', 'TARGET_REQUIRED');
      const uri = vscode.Uri.file(req.target); if (!isTargetAllowed(uri)) return response(req.id, 'error', 'TARGET_OUTSIDE_TRUSTED_WORKSPACE');
      const params = req.params as ReadNotebookParams | undefined;
      if (params?.includeOutputs !== undefined && typeof params.includeOutputs !== 'boolean') {
        return response(req.id, 'error', 'INVALID_INCLUDE_OUTPUTS');
      }
      return response(req.id, 'ok', undefined, notebookSnapshot(await resolveNotebook(req.target), params?.includeOutputs === true));
    }
    case 'saveNotebook': return saveNotebook(req);
    case 'executeCell': return executeCell(req);
    case 'replaceText': return applyText(req);
    case 'replaceCell': return replaceCell(req);
    case 'insertCell': return insertCell(req);
    case 'deleteCell': return deleteCell(req);
  }
}

async function appendLog(req: BridgeRequest, result: BridgeResponse): Promise<void> {
  const paths = bridgePaths();
  const line = JSON.stringify({ timestamp: new Date().toISOString(), requestId: req.id, target: req.target, operation: req.operation, status: result.status, reason: result.reason });
  await fs.appendFile(path.join(paths.logs, 'bridge.log'), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function processRequests(context: vscode.ExtensionContext): Promise<void> {
  if (processing) return;
  processing = true;
  const paths = bridgePaths();
  try {
    const names = (await fs.readdir(paths.requests)).filter(name => name.endsWith('.json')).sort();
    for (const name of names) {
      const file = path.join(paths.requests, name);
      let req: BridgeRequest | undefined;
      let result: BridgeResponse;
      try {
        const raw = await fs.readFile(file, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isBridgeRequest(parsed)) {
          result = response(path.basename(name, '.json'), 'error', 'INVALID_REQUEST');
        } else {
          req = parsed;
          try { result = await handle(req, context); }
          catch (error) { result = response(req.id, 'error', error instanceof Error ? error.message : 'UNEXPECTED_ERROR'); }
        }
        await atomicWriteJson(path.join(paths.responses, `${result.id}.json`), result);
        if (req) await appendLog(req, result);
      } finally {
        await fs.unlink(file).catch(() => undefined);
      }
    }
  } catch (error) {
    output.appendLine(`request processing error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    processing = false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('VS Code Live Bridge');
  context.subscriptions.push(output);
  const paths = bridgePaths();
  await ensureBridgeDirs(paths);

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeLiveBridge.enable', async () => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('VS Code Live Bridge requires a trusted workspace.'); return; }
      await context.globalState.update(ENABLED_KEY, true);
      void vscode.window.showInformationMessage('VS Code Live Bridge enabled.');
    }),
    vscode.commands.registerCommand('vscodeLiveBridge.disable', async () => {
      await context.globalState.update(ENABLED_KEY, false);
      void vscode.window.showInformationMessage('VS Code Live Bridge disabled.');
    }),
    vscode.commands.registerCommand('vscodeLiveBridge.status', () => {
      const enabled = context.globalState.get<boolean>(ENABLED_KEY, false);
      void vscode.window.showInformationMessage(`VS Code Live Bridge: ${enabled ? 'enabled' : 'disabled'}; workspace ${vscode.workspace.isTrusted ? 'trusted' : 'untrusted'}.`);
    }),
    vscode.commands.registerCommand('vscodeLiveBridge.showLog', async () => {
      const logFile = path.join(paths.logs, 'bridge.log');
      await fs.appendFile(logFile, '', { encoding: 'utf8', mode: 0o600 });
      const logDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(logFile));
      await vscode.window.showTextDocument(logDocument, { preview: true });
    })
  );

  requestWatcher = watchFs(paths.requests, () => { void processRequests(context); });
  fallbackTimer = setInterval(() => { void processRequests(context); }, 250);
  context.subscriptions.push({ dispose: () => requestWatcher?.close() }, { dispose: () => { if (fallbackTimer) clearInterval(fallbackTimer); } });
  void processRequests(context);
}

export function deactivate(): void {
  requestWatcher?.close();
  if (fallbackTimer) clearInterval(fallbackTimer);
}