#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, bridgePaths, ensureBridgeDirs } from './ipc';
import { BridgeRequest, BridgeResponse, DEFAULT_EXECUTION_TIMEOUT_MS, PROTOCOL_VERSION } from './protocol';

function die(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const BOOLEAN_FLAGS = new Set(['include-outputs']);

function parseArgs(argv: string[]) {
  const command = argv[0];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else {
        const name = arg.slice(2);
        if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
        else flags[name] = true;
      }
    } else positional.push(arg);
  }
  return { command, positional, flags };
}

function num(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flags[name];
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) die(`--${name} must be numeric`);
  return parsed;
}

function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function bool(flags: Record<string, string | boolean>, name: string): boolean {
  const value = flags[name];
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  die(`--${name} must be true or false`);
}

function expectation(flags: Record<string, string | boolean>) {
  return {
    documentVersion: num(flags, 'document-version'),
    documentHash: str(flags, 'document-hash'),
    notebookVersion: num(flags, 'notebook-version'),
    cellId: str(flags, 'cell-id'),
    cellHash: str(flags, 'cell-hash')
  };
}

async function send(req: BridgeRequest, timeoutMs: number): Promise<BridgeResponse> {
  const paths = bridgePaths();
  await ensureBridgeDirs(paths);
  const requestFile = path.join(paths.requests, `${req.id}.json`);
  const responseFile = path.join(paths.responses, `${req.id}.json`);
  await atomicWriteJson(requestFile, req);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(responseFile, 'utf8');
      await fs.unlink(responseFile).catch(() => undefined);
      return JSON.parse(raw) as BridgeResponse;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await fs.unlink(requestFile).catch(() => undefined);
  return { protocolVersion: PROTOCOL_VERSION, id: req.id, status: 'unavailable', reason: 'NO_EXTENSION_RESPONSE' };
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write([
      'vscode-live-bridge status|list|read|read-notebook|save-notebook|execute-cell|replace-text|replace-cell|insert-cell|delete-cell',
      'read-notebook <notebook> [--include-outputs]',
      'save-notebook <notebook> --notebook-version <version>',
      'execute-cell <notebook> --notebook-version <version> --cell-id <id> --cell-hash <sha256> --document-version <version> [--execution-timeout <ms>]'
    ].join('\n') + '\n');
    return;
  }
  const id = randomUUID();
  const target = positional[0] ? path.resolve(positional[0]) : undefined;
  const base = { protocolVersion: PROTOCOL_VERSION, id } as const;
  let req: BridgeRequest;
  let responseTimeoutMs = num(flags, 'timeout') ?? 5000;
  switch (command) {
    case 'status': req = { ...base, operation: 'status' }; break;
    case 'list': req = { ...base, operation: 'list' }; break;
    case 'read':
      if (!target) die('read requires <document>');
      req = { ...base, operation: 'readText', target }; break;
    case 'read-notebook':
      if (!target) die('read-notebook requires <notebook>');
      req = {
        ...base,
        operation: 'readNotebook',
        target,
        ...(bool(flags, 'include-outputs') ? { params: { includeOutputs: true } } : {})
      };
      break;
    case 'save-notebook':
      if (!target) die('save-notebook requires <notebook>');
      req = { ...base, operation: 'saveNotebook', target, expected: expectation(flags) };
      break;
    case 'execute-cell': {
      if (!target) die('execute-cell requires <notebook>');
      const executionTimeout = num(flags, 'execution-timeout') ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      if (flags['timeout'] === undefined) responseTimeoutMs = executionTimeout + 5000;
      req = { ...base, operation: 'executeCell', target, expected: expectation(flags), params: { timeoutMs: executionTimeout } };
      break;
    }
    case 'replace-text': {
      if (!target) die('replace-text requires <document>');
      const text = str(flags, 'text'); if (text === undefined) die('replace-text requires --text');
      req = { ...base, operation: 'replaceText', target, expected: expectation(flags), params: { text, start: num(flags, 'start'), end: num(flags, 'end') } };
      break;
    }
    case 'replace-cell': {
      if (!target) die('replace-cell requires <notebook>');
      const text = str(flags, 'text'); if (text === undefined) die('replace-cell requires --text');
      req = { ...base, operation: 'replaceCell', target, expected: expectation(flags), params: { text } };
      break;
    }
    case 'insert-cell': {
      if (!target) die('insert-cell requires <notebook>');
      req = { ...base, operation: 'insertCell', target, expected: expectation(flags), params: { text: str(flags, 'text') ?? '', kind: str(flags, 'kind') ?? 'code', position: str(flags, 'position') ?? 'after' } };
      break;
    }
    case 'delete-cell':
      if (!target) die('delete-cell requires <notebook>');
      req = { ...base, operation: 'deleteCell', target, expected: expectation(flags) }; break;
    default: die(`unknown command: ${command}`);
  }
  const response = await send(req, responseTimeoutMs);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (response.status !== 'ok') process.exitCode = response.status === 'conflict' ? 3 : 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
