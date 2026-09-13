import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const libDir = path.join(os.homedir(), '.local', 'lib', 'vscode-live-bridge');
const binDir = path.join(os.homedir(), '.local', 'bin');
const binPath = path.join(binDir, 'vscode-live-bridge');
await fs.mkdir(libDir, { recursive: true });
await fs.mkdir(binDir, { recursive: true });
for (const name of ['cli.js', 'ipc.js', 'protocol.js']) {
  await fs.copyFile(path.resolve('dist', name), path.join(libDir, name));
}
await fs.writeFile(binPath, `#!/bin/sh\nexec node ${JSON.stringify(path.join(libDir, 'cli.js'))} \"$@\"\n`, { mode: 0o755 });
console.log(binPath);
