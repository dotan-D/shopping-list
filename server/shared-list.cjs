'use strict';
const { createHash, randomUUID } = require('node:crypto');
const KEY = 'shopping-list:shared:v1';
const CATALOG_KEY = 'shopping-list:catalog:v1';
const CATEGORIES = new Set(['produce', 'dairy', 'bakery', 'meat', 'canned', 'pantry', 'baking', 'snacks', 'drinks', 'frozen', 'cleaning', 'care', 'home', 'other']);
const ADD = `local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current and redis.call('HLEN', KEYS[1]) >= 500 then return {-1, '', ''} end
if ARGV[3] ~= '' and redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 and redis.call('HLEN', KEYS[2]) >= 2000 then return {-2, '', ''} end
local catalog = ''
if ARGV[3] ~= '' then
  local saved = redis.call('HGET', KEYS[2], ARGV[1])
  if saved and not cjson.decode(saved).hidden then catalog = saved
  else
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
    catalog = ARGV[3]
  end
end
if current then return {0, current, catalog} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return {1, ARGV[2], catalog}`;
const SAVE_PRODUCT = `if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= 2000 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;
const REMOVE = `local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then return 0 end
if cjson.decode(current).id ~= ARGV[2] then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])`;
function normalize(value) {
  return value.normalize('NFKD').replace(/[\u0591-\u05C7]/g, '').replace(/[׳״'"’`]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('he');
}
function fieldFor(name) { return createHash('sha256').update(normalize(name)).digest('hex'); }
function failure(status, message) { return Object.assign(new Error(message), { status }); }
function validateItem(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 || !normalize(input.name) || !CATEGORIES.has(input.category)) throw failure(400, 'פרטי המוצר אינם תקינים.');
  return { name: input.name.trim(), category: input.category };
}
function getConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw failure(503, 'הרשימה המשותפת עדיין אינה זמינה.');
  let parsed;
  try { parsed = new URL(url); } catch { throw failure(503, 'הרשימה המשותפת עדיין אינה זמינה.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw failure(503, 'הרשימה המשותפת עדיין אינה זמינה.');
  return { url: parsed.href, token };
}
async function command(parts) {
  const { url, token } = getConfig();
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parts), signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!response.ok) throw new Error('Database request failed');
    const body = await response.json();
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Database response invalid');
    return body.result;
  } catch { throw failure(502, 'לא ניתן להגיע לרשימה המשותפת כרגע. נסו שוב.'); }
}
async function readList() {
  const result = await command(['HGETALL', KEY]);
  if (!Array.isArray(result) || result.length % 2) throw failure(502, 'לא ניתן לטעון את הרשימה כרגע.');
  try {
    const items = [];
    for (let index = 1; index < result.length; index += 2) {
      const item = JSON.parse(result[index]); validateItem(item);
      if (typeof item.id !== 'string' || typeof item.createdAt !== 'number') throw new Error('Invalid item');
      items.push({ id: item.id, name: item.name, category: item.category, done: false, createdAt: item.createdAt });
    }
    return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  } catch { throw failure(502, 'לא ניתן לטעון את הרשימה כרגע.'); }
}
async function addItem(input) {
  const value = validateItem(input);
  if (input.remember !== undefined && typeof input.remember !== 'boolean') throw failure(400, 'פרטי המוצר אינם תקינים.');
  const item = { ...value, id: randomUUID(), done: false, createdAt: Date.now() };
  const catalog = input.remember ? { ...value, hidden: false } : null;
  const result = await command(['EVAL', ADD, '2', KEY, CATALOG_KEY, fieldFor(value.name), JSON.stringify(item), catalog ? JSON.stringify(catalog) : '']);
  if (!Array.isArray(result) || result.length !== 3) throw failure(502, 'לא ניתן לשמור את המוצר כרגע.');
  if (result[0] === -2) throw failure(409, 'קטלוג המוצרים מלא. לא ניתן לשמור מוצר נוסף כרגע.');
  if (result[0] === -1) throw failure(409, 'הרשימה מלאה. אפשר להוסיף מוצר אחרי הסרת פריטים שנקנו.');
  try {
    const saved = JSON.parse(result[1]); validateItem(saved);
    if (typeof saved.id !== 'string' || typeof saved.createdAt !== 'number') throw new Error('Invalid item');
    return { item: saved, created: result[0] === 1, catalogProduct: result[2] ? JSON.parse(result[2]) : null };
  } catch { throw failure(502, 'לא ניתן לאשר שהמוצר נשמר. רעננו את הרשימה.'); }
}
async function removeItem(input) {
  const value = validateItem(input);
  if (typeof input.id !== 'string' || !/^[a-f\d-]{36}$/i.test(input.id)) throw failure(400, 'מזהה המוצר אינו תקין.');
  const result = await command(['EVAL', REMOVE, '1', KEY, fieldFor(value.name), input.id]);
  if (result !== 0 && result !== 1) throw failure(502, 'לא ניתן לאשר שהמוצר הוסר. רעננו את הרשימה.');
  return { removed: result === 1 };
}
async function readCatalog() {
  const result = await command(['HGETALL', CATALOG_KEY]);
  if (!Array.isArray(result) || result.length % 2) throw failure(502, 'לא ניתן לטעון את אפשרויות הבחירה כרגע.');
  try {
    const catalog = [];
    for (let index = 1; index < result.length; index += 2) {
      const product = JSON.parse(result[index]); validateItem(product);
      if (typeof product.hidden !== 'boolean') throw new Error('Invalid product');
      catalog.push({ name: product.name, category: product.category, hidden: product.hidden });
    }
    return catalog;
  } catch { throw failure(502, 'לא ניתן לטעון את אפשרויות הבחירה כרגע.'); }
}
async function saveProduct(input, hidden) {
  const value = validateItem(input);
  const product = { ...value, hidden };
  const result = await command(['EVAL', SAVE_PRODUCT, '1', CATALOG_KEY, fieldFor(value.name), JSON.stringify(product)]);
  if (result === 0) throw failure(409, 'קטלוג המוצרים מלא. לא ניתן לעדכן אותו כרגע.');
  if (result !== 1) throw failure(502, 'לא ניתן לעדכן את אפשרויות הבחירה כרגע.');
  return { catalogProduct: product };
}
module.exports = { readList, addItem, removeItem, readCatalog, saveProduct };
