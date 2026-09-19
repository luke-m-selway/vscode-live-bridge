import test from 'node:test';
import assert from 'node:assert/strict';
import { isBridgeRequest, sha256 } from '../src/protocol';

test('sha256 is deterministic', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('request guard validates the protocol envelope and operation', () => {
  assert.equal(isBridgeRequest({ protocolVersion: 1, id: 'x', operation: 'status' }), true);
  assert.equal(isBridgeRequest({ protocolVersion: 1, id: 'x', operation: 'saveNotebook' }), true);
  assert.equal(isBridgeRequest({ protocolVersion: 1, id: 'x', operation: 'executeCell' }), true);
  assert.equal(isBridgeRequest({ protocolVersion: 2, id: 'x', operation: 'status' }), false);
  assert.equal(isBridgeRequest({ protocolVersion: 1, id: 'x', operation: 'shell' }), false);
});