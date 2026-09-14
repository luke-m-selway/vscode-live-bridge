import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';

interface CliResult {
  code: number;
  response: any;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCli(args: string[]): Promise<CliResult> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return reject(new Error(`CLI produced no JSON. stderr=${stderr}`));
      try { resolve({ code: code ?? 0, response: JSON.parse(line) }); }
      catch (error) { reject(new Error(`CLI JSON parse failed: ${line}\nstderr=${stderr}\n${String(error)}`)); }
    });
  });
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

async function replaceLiveText(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange(doc), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await sleep(100);
}

export async function run(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'acceptance workspace is required');
  assert.equal(vscode.workspace.isTrusted, true, 'workspace must be trusted');

  const extension = vscode.extensions.getExtension('luke-m-selway.vscode-live-bridge');
  assert.ok(extension, 'bridge extension must be available');
  await extension.activate();
  await vscode.commands.executeCommand('vscodeLiveBridge.enable');
  await sleep(300);

  const root = workspace.uri.fsPath;
  const textPath = path.join(root, 'note.md');
  const notebookPath = path.join(root, 'book.ipynb');
  const outsidePath = path.join(path.dirname(root), 'outside.md');

  const textDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(textPath));
  const textEditor = await vscode.window.showTextDocument(textDoc);
  await textEditor.edit(builder => builder.insert(textDoc.positionAt(textDoc.getText().length), 'manual-unsaved\n'));
  assert.equal(textDoc.isDirty, true);

  let cli = await runCli(['read', textPath]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  assert.match(cli.response.result.text, /manual-unsaved/);
  const textSnap = cli.response.result;

  cli = await runCli([
    'replace-text', textPath,
    '--document-version', String(textSnap.version),
    '--document-hash', textSnap.hash,
    '--start', '0', '--end', '4', '--text', 'agent'
  ]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  assert.match(textDoc.getText(), /^agent/);
  assert.match(textDoc.getText(), /manual-unsaved/);
  assert.equal(textDoc.isDirty, true);

  await vscode.window.showTextDocument(textDoc);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await sleep(300);
  await vscode.commands.executeCommand('undo');
  await sleep(200);
  assert.match(textDoc.getText(), /^base/);
  assert.match(textDoc.getText(), /manual-unsaved/);
  assert.equal(textDoc.isDirty, true);

  cli = await runCli(['read', outsidePath]);
  assert.equal(cli.code, 1);
  assert.equal(cli.response.reason, 'TARGET_OUTSIDE_TRUSTED_WORKSPACE');

  await vscode.commands.executeCommand('vscodeLiveBridge.disable');
  await sleep(100);
  cli = await runCli(['list']);
  assert.equal(cli.code, 1);
  assert.equal(cli.response.status, 'unavailable');
  assert.equal(cli.response.reason, 'BRIDGE_DISABLED');
  await vscode.commands.executeCommand('vscodeLiveBridge.enable');
  await sleep(100);

  const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
  await vscode.window.showNotebookDocument(notebook);
  assert.ok(notebook.cellCount >= 2);
  const first = notebook.cellAt(0);
  await replaceLiveText(first.document, "print('manual')");
  assert.equal(notebook.isDirty, true);

  cli = await runCli(['read-notebook', notebookPath]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  assert.equal(cli.response.result.cells[0].source, "print('manual')");
  let notebookSnap = cli.response.result;

  const secondSnap = notebookSnap.cells[1];
  cli = await runCli([
    'replace-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', secondSnap.cellId,
    '--cell-hash', secondSnap.hash,
    '--document-version', String(secondSnap.documentVersion),
    '--text', 'agent changed markdown'
  ]);
  assert.equal(cli.code, 0);
  assert.equal(notebook.cellAt(1).document.getText(), 'agent changed markdown');
  assert.equal(notebook.isDirty, true);

  const activeNotebookEditor = vscode.window.activeNotebookEditor;
  assert.ok(activeNotebookEditor);
  activeNotebookEditor.selection = new vscode.NotebookRange(1, 2);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('notebook.focusTop');
  await sleep(300);
  await vscode.commands.executeCommand('undo');
  await sleep(200);
  assert.equal(notebook.cellAt(0).document.getText(), "print('manual')");
  assert.notEqual(notebook.cellAt(1).document.getText(), 'agent changed markdown');

  cli = await runCli(['read-notebook', notebookPath]);
  notebookSnap = cli.response.result;
  const freshFirst = notebookSnap.cells[0];
  cli = await runCli([
    'replace-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', freshFirst.cellId,
    '--cell-hash', freshFirst.hash,
    '--document-version', String(freshFirst.documentVersion),
    '--text', "print('agent-after-manual')"
  ]);
  assert.equal(cli.code, 0);
  assert.equal(notebook.cellAt(0).document.getText(), "print('agent-after-manual')");

  cli = await runCli(['read-notebook', notebookPath]);
  notebookSnap = cli.response.result;
  const staleFirst = notebookSnap.cells[0];
  await replaceLiveText(notebook.cellAt(0).document, "print('agent-after-manual')\n# user changed");
  cli = await runCli([
    'replace-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', staleFirst.cellId,
    '--cell-hash', staleFirst.hash,
    '--document-version', String(staleFirst.documentVersion),
    '--text', "print('stale overwrite')"
  ]);
  assert.equal(cli.code, 3);
  assert.equal(cli.response.status, 'conflict');
  assert.equal(cli.response.reason, 'STALE_SNAPSHOT');
  assert.match(notebook.cellAt(0).document.getText(), /# user changed/);

  cli = await runCli(['read-notebook', notebookPath]);
  notebookSnap = cli.response.result;
  const chainRef = notebookSnap.cells[0];
  let delayedSettleScheduled = false;
  const settleProbe = vscode.workspace.onDidChangeNotebookDocument(event => {
    if (event.notebook !== notebook || delayedSettleScheduled) return;
    delayedSettleScheduled = true;
    setTimeout(() => {
      const followup = new vscode.WorkspaceEdit();
      followup.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({
        ...notebook.metadata,
        bridgeAcceptanceSettleProbe: true
      })]);
      void vscode.workspace.applyEdit(followup);
    }, 25);
  });
  cli = await runCli([
    'insert-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', chainRef.cellId,
    '--cell-hash', chainRef.hash,
    '--kind', 'code', '--position', 'after', '--text', 'chain = 1'
  ]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  const afterInsert = cli.response.result;
  await sleep(75);
  settleProbe.dispose();
  assert.equal(delayedSettleScheduled, true);
  const inserted = afterInsert.cells.find((cell: any) => cell.source === 'chain = 1');
  assert.ok(inserted);

  cli = await runCli([
    'replace-cell', notebookPath,
    '--notebook-version', String(afterInsert.version),
    '--cell-id', inserted.cellId,
    '--cell-hash', inserted.hash,
    '--document-version', String(inserted.documentVersion),
    '--text', 'chain = 2'
  ]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  const afterReplace = cli.response.result;
  const replaced = afterReplace.cells.find((cell: any) => cell.cellId === inserted.cellId);
  assert.ok(replaced);
  assert.equal(replaced.source, 'chain = 2');

  cli = await runCli([
    'delete-cell', notebookPath,
    '--notebook-version', String(afterReplace.version),
    '--cell-id', replaced.cellId,
    '--cell-hash', replaced.hash
  ]);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  assert.equal(cli.response.result.cells.some((cell: any) => cell.source === 'chain = 2'), false);

  cli = await runCli(['read-notebook', notebookPath]);
  notebookSnap = cli.response.result;
  const insertRef = notebookSnap.cells[0];
  const beforeInsertCount = notebook.cellCount;
  cli = await runCli([
    'insert-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', insertRef.cellId,
    '--cell-hash', insertRef.hash,
    '--kind', 'code', '--position', 'after', '--text', 'x = 1'
  ]);
  assert.equal(cli.code, 0);
  assert.equal(notebook.cellCount, beforeInsertCount + 1);
  await vscode.commands.executeCommand('undo');
  await sleep(150);
  assert.equal(notebook.cellCount, beforeInsertCount);

  cli = await runCli(['read-notebook', notebookPath]);
  notebookSnap = cli.response.result;
  const deleteTarget = notebookSnap.cells[1];
  const beforeDeleteCount = notebook.cellCount;
  cli = await runCli([
    'delete-cell', notebookPath,
    '--notebook-version', String(notebookSnap.version),
    '--cell-id', deleteTarget.cellId,
    '--cell-hash', deleteTarget.hash
  ]);
  assert.equal(cli.code, 0);
  assert.equal(notebook.cellCount, beforeDeleteCount - 1);
  await vscode.commands.executeCommand('undo');
  await sleep(150);
  assert.equal(notebook.cellCount, beforeDeleteCount);
  assert.equal(notebook.isDirty, true);

  cli = await runCli(['status']);
  assert.equal(cli.code, 0);
  assert.equal(cli.response.status, 'ok');
  assert.equal(cli.response.result.enabled, true);
  assert.equal(cli.response.result.workspaceTrusted, true);
}
