import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotebookOutputBudget,
  notebookOutputSummary,
  outputEncoding,
  serializeNotebookOutputGroups
} from '../src/notebookOutputs';

const bytes = (value: string) => new TextEncoder().encode(value);

test('notebook output serializer keeps textual, error, and rich text MIME data readable', () => {
  const budget = createNotebookOutputBudget();
  const groups = serializeNotebookOutputGroups([
    { items: [
      { mime: 'application/vnd.code.notebook.stdout', data: bytes('hello\n') },
      { mime: 'text/html', data: bytes('<b>hello</b>') },
      { mime: 'application/vnd.code.notebook.error', data: bytes('{"name":"Error","message":"boom"}') }
    ] }
  ], budget);

  assert.equal(groups[0].items[0].encoding, 'utf8');
  assert.equal(groups[0].items[0].data, 'hello\n');
  assert.equal(groups[0].items[1].data, '<b>hello</b>');
  assert.match(groups[0].items[2].data ?? '', /boom/);
  assert.equal(notebookOutputSummary(budget).truncated, false);
});

test('notebook output serializer treats JSON MIME data as UTF-8', () => {
  assert.equal(outputEncoding('application/json'), 'utf8');
  assert.equal(outputEncoding('application/vnd.example+json'), 'utf8');
});

test('notebook output serializer shares one budget across successive cell output groups', () => {
  const budget = createNotebookOutputBudget({ rawBytes: 5, items: 10, groups: 10 });
  serializeNotebookOutputGroups([{ items: [{ mime: 'text/plain', data: bytes('1234') }] }], budget);
  const second = serializeNotebookOutputGroups([{ items: [{ mime: 'text/plain', data: bytes('56') }] }], budget);
  assert.equal(second[0].items[0].omitted, true);
  assert.equal(notebookOutputSummary(budget).rawBytesIncluded, 4);
  assert.equal(notebookOutputSummary(budget).rawBytesOmitted, 2);
});

test('notebook output serializer base64-encodes binary MIME data', () => {
  assert.equal(outputEncoding('image/png'), 'base64');
  const budget = createNotebookOutputBudget();
  const groups = serializeNotebookOutputGroups([
    { items: [{ mime: 'image/png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }] }
  ], budget);
  assert.equal(groups[0].items[0].encoding, 'base64');
  assert.equal(groups[0].items[0].data, 'iVBORw==');
});

test('notebook output serializer represents byte-limit omission without partial payloads', () => {
  const budget = createNotebookOutputBudget({ rawBytes: 4, items: 10, groups: 10 });
  const groups = serializeNotebookOutputGroups([
    { items: [
      { mime: 'text/plain', data: bytes('1234') },
      { mime: 'image/png', data: Uint8Array.from([1, 2]) }
    ] }
  ], budget);

  assert.equal(groups[0].items[0].data, '1234');
  assert.equal(groups[0].items[1].data, undefined);
  assert.equal(groups[0].items[1].omitted, true);
  assert.equal(groups[0].items[1].reason, 'OUTPUT_LIMIT_EXCEEDED');
  const summary = notebookOutputSummary(budget);
  assert.equal(summary.truncated, true);
  assert.equal(summary.rawBytesIncluded, 4);
  assert.equal(summary.rawBytesOmitted, 2);
  assert.equal(summary.itemsOmitted, 1);
});

test('notebook output serializer reports item-cap omissions in the aggregate summary', () => {
  const budget = createNotebookOutputBudget({ rawBytes: 1024, items: 1, groups: 10 });
  const groups = serializeNotebookOutputGroups([
    { items: [
      { mime: 'text/plain', data: bytes('first') },
      { mime: 'text/plain', data: bytes('second') }
    ] }
  ], budget);

  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].omittedItems, 1);
  const summary = notebookOutputSummary(budget);
  assert.equal(summary.truncated, true);
  assert.equal(summary.itemsRepresented, 1);
  assert.equal(summary.itemsOmitted, 1);
  assert.equal(summary.groupsOmitted, 0);
});

test('notebook output serializer reports whole-group omissions in the aggregate summary', () => {
  const budget = createNotebookOutputBudget({ rawBytes: 1024, items: 10, groups: 1 });
  const groups = serializeNotebookOutputGroups([
    { items: [{ mime: 'text/plain', data: bytes('first') }] },
    { items: [
      { mime: 'text/plain', data: bytes('second') },
      { mime: 'text/plain', data: bytes('third') }
    ] }
  ], budget);

  assert.equal(groups.length, 1);
  const summary = notebookOutputSummary(budget);
  assert.equal(summary.truncated, true);
  assert.equal(summary.groupsRepresented, 1);
  assert.equal(summary.groupsOmitted, 1);
  assert.equal(summary.itemsOmitted, 2);
});
