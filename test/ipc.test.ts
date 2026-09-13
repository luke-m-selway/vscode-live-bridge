import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, bridgePaths, ensureBridgeDirs } from '../src/ipc';

test('IPC directories and atomic JSON writes work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vlb-'));
  const paths = bridgePaths(root);
  await ensureBridgeDirs(paths);
  const file = path.join(paths.requests, 'x.json');
  await atomicWriteJson(file, { ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ok: true });
  const mode = (await fs.stat(root)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o700);
});
