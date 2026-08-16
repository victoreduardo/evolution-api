import assert from 'node:assert/strict';

import { fromJobSafe, toJobSafe } from '../src/queues/job-serializer';

function run() {
  const original = {
    key: { id: 'ABC123', remoteJid: '5511999999999@s.whatsapp.net' },
    message: { imageMessage: { mediaKey: new Uint8Array([1, 2, 3, 250, 255]), caption: 'oi' } },
    nested: { list: [new Uint8Array([9, 8]), { deeper: new Uint8Array([7]) }] },
  };

  const restored = fromJobSafe(JSON.parse(JSON.stringify(toJobSafe(original))));

  assert.ok(restored.message.imageMessage.mediaKey instanceof Uint8Array, 'mediaKey should be Uint8Array');
  assert.deepEqual(Array.from(restored.message.imageMessage.mediaKey), [1, 2, 3, 250, 255], 'mediaKey bytes preserved');
  assert.ok(restored.nested.list[0] instanceof Uint8Array, 'array element Uint8Array preserved');
  assert.ok(restored.nested.list[1].deeper instanceof Uint8Array, 'nested Uint8Array preserved');
  assert.equal(restored.message.imageMessage.caption, 'oi', 'plain string preserved');
  assert.equal(restored.key.id, 'ABC123', 'plain string preserved');

  // Regression: must reconstruct as a real Buffer, not just a Uint8Array. Baileys' getStream()
  // does a strict Buffer.isBuffer() check on raw media content (e.g. outbound audio) and falls
  // through to a `.url`-reading branch that crashes on a plain Uint8Array - caught live sending
  // a real audio message through the wa-outbound queue.
  assert.ok(
    Buffer.isBuffer(restored.message.imageMessage.mediaKey),
    'mediaKey must be a real Buffer, not just Uint8Array',
  );
  assert.ok(Buffer.isBuffer(restored.nested.list[0]), 'array element must be a real Buffer');

  // non-object/array/Uint8Array primitives pass through untouched
  assert.equal(fromJobSafe(toJobSafe(null)), null, 'null passes through');
  assert.equal(fromJobSafe(toJobSafe(42)), 42, 'number passes through');
  assert.equal(fromJobSafe(toJobSafe('text')), 'text', 'string passes through');
  assert.equal(fromJobSafe(toJobSafe(true)), true, 'boolean passes through');

  // empty Uint8Array round-trips
  const empty = fromJobSafe(JSON.parse(JSON.stringify(toJobSafe(new Uint8Array([])))));
  assert.ok(empty instanceof Uint8Array, 'empty Uint8Array preserved as Uint8Array');
  assert.equal(empty.length, 0, 'empty Uint8Array has length 0');

  console.log('job-serializer: OK');
}

run();
