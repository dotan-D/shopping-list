'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installRedisAdapter } = require('./redis-adapter.cjs');
const adapter = installRedisAdapter();
const { readList, addItem, removeItem } = require('../server/shared-list.cjs');
const handler = require('../api/list.js');
async function call(method, body, extraHeaders = {}) {
  const headers = { host: 'shopping.example.test', 'content-type': 'application/json', ...extraHeaders };
  const req = { method, headers, body };
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res); return res;
}
test('shared list persistence, concurrent operations, validation and failure handling', async t => {
  // Never FLUSHDB: touch only the explicit key in an isolated test instance.
  adapter.command(['DEL', 'shopping-list:shared:v1']);
  await t.test('all readers see additions; independent additions do not overwrite each other', async () => {
    await Promise.all([addItem({ name: 'חלב', category: 'dairy' }), addItem({ name: 'לחם', category: 'bakery' })]);
    const firstReader = await readList(); const secondReader = await readList();
    assert.deepEqual(firstReader, secondReader); assert.equal(firstReader.length, 2);
  });
  await t.test('atomic same-name additions deduplicate normalized Hebrew names', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => addItem({ name: i % 2 ? 'קוטג׳' : 'קוטג', category: 'dairy' })));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.item.id)).size, 1);
    assert.equal((await readList()).length, 3);
  });
  await t.test('a stale deletion cannot delete a newer re-addition of the same product', async () => {
    const original = (await readList()).find(item => item.name === 'חלב');
    assert.equal((await removeItem(original)).removed, true);
    const restored = (await addItem(original)).item;
    assert.notEqual(restored.id, original.id);
    assert.equal((await removeItem(original)).removed, false);
    assert((await readList()).some(item => item.id === restored.id));
  });
  await t.test('two removals of one item remove it only once', async () => {
    const item = (await readList())[0];
    const removed = await Promise.all([removeItem(item), removeItem(item)]);
    assert.equal(removed.filter(result => result.removed).length, 1);
  });
  await t.test('invalid input, foreign origins and unsupported methods are rejected', async () => {
    assert.equal((await call('POST', { name: ' ', category: 'other' })).code, 400);
    assert.equal((await call('POST', { name: 'x'.repeat(161), category: 'other' })).code, 400);
    assert.equal((await call('POST', { name: 'x', category: 'invalid' })).code, 400);
    assert.equal((await call('POST', '{')).code, 400);
    assert.equal((await call('POST', { name: 'x', category: 'other' }, { origin: 'https://unrelated.example.test' })).code, 403);
    assert.equal((await call('POST', {}, { 'content-type': 'text/plain' })).code, 415);
    assert.equal((await call('POST', {}, { 'content-length': '3000' })).code, 413);
    assert.equal((await call('PUT', {})).code, 405);
    const read = await call('GET'); assert.equal(read.code, 200); assert.equal(read.headers['Cache-Control'], 'no-store, max-age=0');
  });
  await t.test('database failures and missing configuration never report success', async () => {
    adapter.setUnavailable(true);
    assert.equal((await call('GET')).code, 502);
    assert.equal((await call('POST', { name: 'לא נשמר', category: 'other' })).code, 502);
    adapter.setUnavailable(false);
    assert(!(await readList()).some(item => item.name === 'לא נשמר'));
    const token = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_TOKEN;
    assert.equal((await call('GET')).code, 503);
    process.env.KV_REST_API_TOKEN = token;
  });
  await t.test('list capacity is enforced atomically', async () => {
    adapter.command(['DEL', 'shopping-list:shared:v1']);
    const pairs = [];
    for (let i = 0; i < 500; i++) pairs.push(`test-${i}`, JSON.stringify({ name: `פריט ${i}`, category: 'other', id: `test-${i}`, createdAt: i, done: false }));
    adapter.command(['HSET', 'shopping-list:shared:v1', ...pairs]);
    await assert.rejects(addItem({ name: 'פריט נוסף', category: 'other' }), error => error.status === 409);
    assert.equal((await readList()).length, 500);
    adapter.command(['DEL', 'shopping-list:shared:v1']);
  });
  adapter.restore();
});
