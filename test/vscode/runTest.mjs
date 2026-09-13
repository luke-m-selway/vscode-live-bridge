import { mkdtemp, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const root = await mkdtemp('/tmp/vlb-e2e-');
const workspace = path.join(root, 'workspace');
const ipc = path.join(root, 'ipc');
const userData = path.join(root, 'user-data');
const extensions = path.join(root, 'extensions');
await Promise.all([workspace, ipc, userData, extensions].map(dir => mkdir(dir, { recursive: true })));

await writeFile(path.join(workspace, 'note.md'), 'base line\n');
await writeFile(path.join(root, 'outside.md'), 'outside\n');
await writeFile(path.join(workspace, 'book.ipynb'), JSON.stringify({
  cells: [
    { cell_type: 'code', execution_count: null, id: 'base-code', metadata: {}, outputs: [], source: ["print('base')"] },
    { cell_type: 'markdown', id: 'base-markdown', metadata: {}, source: ['base markdown'] }
  ],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5
}, null, 1));

const installedExtensions = path.join(os.homedir(), '.vscode', 'extensions');
for (const name of await readdir(installedExtensions)) {
  if (/^(ms-toolsai\.(jupyter|jupyter-keymap|jupyter-renderers|vscode-jupyter)|ms-python\.(python|debugpy|vscode-python-envs|vscode-pylance))-/.test(name)) {
    await symlink(path.join(installedExtensions, name), path.join(extensions, name));
  }
}

process.env.VSCODE_LIVE_BRIDGE_ROOT = ipc;
console.log(`acceptanceRoot=${root}`);
await runTests({
  version: '1.137.0',
  extensionDevelopmentPath: repoRoot,
  extensionTestsPath: path.join(repoRoot, 'dist-vscode-test', 'test', 'vscode', 'acceptance.js'),
  launchArgs: [
    workspace,
    '--disable-workspace-trust',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--disable-updates'
  ]
});
