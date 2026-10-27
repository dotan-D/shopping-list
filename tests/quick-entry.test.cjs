'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parse } = require('../quick-entry.js');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../catalog.js'), 'utf8'), sandbox);
const products = sandbox.window.SHOPPING_CATALOG.products;
const names = value => parse(value, products).map(product => product.name);
test('Hebrew quick entry recognizes framed requests, conjunctions and longest product names', () => {
  assert.deepEqual(names('תוסיף חלב, לחם וביצים'), ['חלב', 'לחם', 'ביצים']);
  assert.deepEqual(names('אני רוצה לקנות חלב וגבינה צהובה בבקשה'), ['חלב', 'גבינה צהובה']);
  assert.deepEqual(names('תוסיף לי לרשימה חלב ולחם בבקשה'), ['חלב', 'לחם']);
  assert.deepEqual(names('חלב לחם ביצים'), ['חלב', 'לחם', 'ביצים']);
  assert.deepEqual(names('קוטג׳ וגבינת שמנת'), ['קוטג', 'גבינת שמנת']);
  assert.deepEqual(names('עגבניה, מלפפון ובננה'), ['עגבניות', 'מלפפונים', 'בננות']);
});
test('quick entry keeps unknown descriptions intact rather than guessing partial products', () => {
  const result = parse('תה מיוחד, מוצר מהבית וחלב', products);
  assert.deepEqual(result.map(product => product.name), ['תה מיוחד', 'מוצר מהבית', 'חלב']);
  assert.equal(result[0].category, 'other'); assert.equal(result[0].known, false);
  assert.equal(result[2].category, 'dairy'); assert.equal(result[2].known, true);
});
test('quick entry deduplicates and handles empty requests, quantities and non-word catalog names', () => {
  assert.deepEqual(names('חלב, חלב, וביצים'), ['חלב', 'ביצים']);
  assert.deepEqual(names('תוסיף לרשימה'), []);
  assert.deepEqual(names('  , ; \n '), []);
  assert.deepEqual(names('2 חלב ו3 ביצים'), ['חלב', 'ביצים']);
  assert.doesNotThrow(() => parse('חלב', [...products, { name: '🍎', category: 'other' }]));
});
test('quick entry respects hidden products and recognizes new shared custom products', () => {
  const visible = products.filter(product => product.name !== 'חלב');
  const result = parse('חלב', visible);
  assert.equal(result[0].known, false); assert.equal(result[0].category, 'other');
  assert.equal(parse('המוצר שלנו', [...visible, { name: 'המוצר שלנו', category: 'dairy' }])[0].known, true);
  assert.equal(parse(Array.from({ length: 21 }, (_, index) => `חדש ${index}`).join(','), products).length, 21);
});
