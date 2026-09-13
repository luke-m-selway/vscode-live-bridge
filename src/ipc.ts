import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BridgePaths {
  root: string;
  requests: string;
  responses: string;
  logs: string;
  state: string;
}

export function bridgePaths(root = process.env.VSCODE_LIVE_BRIDGE_ROOT ?? path.join(os.homedir(), '.vscode-live-bridge')): BridgePaths {
  return {
    root,
    requests: path.join(root, 'requests'),
    responses: path.join(root, 'responses'),
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state')
  };
}

export async function ensureBridgeDirs(paths = bridgePaths()): Promise<void> {
  const dirs = [paths.root, paths.requests, paths.responses, paths.logs, paths.state];
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await Promise.all(dirs.slice(1).map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  if (process.platform !== 'win32') {
    await Promise.all(dirs.map(dir => fs.chmod(dir, 0o700).catch(() => undefined)));
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}
