import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCellFreshness, checkNotebookFreshness, checkTextFreshness } from '../src/freshness';
import { sha256 } from '../src/protocol';

test('text edits require and validate both version and hash', () => {
  const text = 'current';
  assert.equal(checkTextFreshness(undefined, 3, text), 'missing');
  assert.equal(checkTextFreshness({ documentVersion: 3, documentHash: sha256(text) }, 3, text), 'fresh');
  assert.equal(checkTextFreshness({ documentVersion: 2, documentHash: sha256(text) }, 3, text), 'stale');
  assert.equal(checkTextFreshness({ documentVersion: 3, documentHash: sha256('old') }, 3, text), 'stale');
});

test('cell edits reject notebook, identity, hash, and document-version drift', () => {
  const source = 'print(1)';
  const expected = { notebookVersion: 7, documentVersion: 4, cellId: 'cell-a', cellHash: sha256(source) };
  assert.equal(checkCellFreshness(expected, 7, 'cell-a', source, 4, true), 'fresh');
  assert.equal(checkCellFreshness(expected, 8, 'cell-a', source, 4, true), 'stale');
  assert.equal(checkCellFreshness(expected, 7, 'cell-b', source, 4, true), 'stale');
  assert.equal(checkCellFreshness(expected, 7, 'cell-a', 'changed', 4, true), 'stale');
  assert.equal(checkCellFreshness(expected, 7, 'cell-a', source, 5, true), 'stale');
});


test('notebook actions require and validate notebook version', () => {
  assert.equal(checkNotebookFreshness(undefined, 5), 'missing');
  assert.equal(checkNotebookFreshness({ notebookVersion: 5 }, 5), 'fresh');
  assert.equal(checkNotebookFreshness({ notebookVersion: 4 }, 5), 'stale');
});
