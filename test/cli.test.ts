import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist', 'cli.js'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('CLI help documents opt-in notebook output reads', async () => {
  const result = await runCli(['--help'], process.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /read-notebook <notebook> \[--include-outputs\]/);
});

test('CLI timeout removes an unclaimed request instead of leaving a delayed edit queued', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vlb-cli-'));
  const result = await runCli(['status', '--timeout', '100'], { ...process.env, VSCODE_LIVE_BRIDGE_ROOT: root });
  assert.equal(result.code, 1, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.status, 'unavailable');
  assert.equal(response.reason, 'NO_EXTENSION_RESPONSE');
  assert.deepEqual(await fs.readdir(path.join(root, 'requests')), []);
});
