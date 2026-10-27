'use strict';
const LEGACY_KEY = 'shopping-list.v1';
const CACHE_KEY = 'shopping-list.shared-cache.v1';
const CATALOG_CACHE_KEY = 'shopping-list.catalog-cache.v1';
const IMPORT_KEY = 'shopping-list.shared-imported.v1';
const { categories, products: baseProducts } = window.SHOPPING_CATALOG;
const byId = new Map(categories.map(category => [category.id, category]));
const normalize = value => value.normalize('NFKD').replace(/[\u0591-\u05C7]/g, '').replace(/[׳״'"’`]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('he');
let products = [...baseProducts];
let productByName = new Map(products.map(product => [normalize(product.name), product]));
const searchInput = document.querySelector('#product-search');
const warning = document.querySelector('#storage-warning');
const status = document.querySelector('#status');
let items = [];
let activeCategory = null;
let suggestions = [];
let activeOption = -1;
let removedItem = null;
let legacyItems = [];
let hasSnapshot = false;
let sharedReady = false;
let writing = false;
let reading = false;
let epoch = 0;
let catalogOverrides = [];
let catalogDirty = false;
let editingCatalog = false;
let quickCandidates = [];
let listening = false;
let recognition = null;

function showWarning(message) { warning.textContent = message; warning.hidden = false; }
function parseItems(saved) {
  if (!Array.isArray(saved) || !saved.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim() && typeof item.done === 'boolean') || new Set(saved.map(item => item.id)).size !== saved.length) throw new Error('Invalid list');
  return saved.filter(item => !item.done).map(item => ({ ...item, category: byId.has(item.category) ? item.category : (productByName.get(normalize(item.name))?.category || 'other') }));
}
try {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached !== null) { items = parseItems(JSON.parse(cached)); hasSnapshot = true; }
} catch { /* A damaged local cache never replaces shared data. */ }
try {
  const catalogCache = localStorage.getItem(CATALOG_CACHE_KEY);
  if (catalogCache !== null) applyCatalog(JSON.parse(catalogCache));
} catch { /* Fetch the shared catalog if the offline copy is unreadable. */ }
try {
  if (!localStorage.getItem(IMPORT_KEY)) {
    const old = localStorage.getItem(LEGACY_KEY);
    if (old !== null) legacyItems = parseItems(JSON.parse(old));
  }
} catch { showWarning('לא ניתן לקרוא את הרשימה המקומית הקודמת. הרשימה המשותפת אינה מושפעת.'); }
function cacheSnapshot() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items));
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(catalogOverrides));
  } catch { /* Shared writes still persist on the server. */ }
}
function parseCatalog(saved) {
  if (!Array.isArray(saved) || saved.length > 2000 || !saved.every(product => product && typeof product.name === 'string' && product.name.trim() && product.name.length <= 160 && byId.has(product.category) && typeof product.hidden === 'boolean')) throw new Error('Invalid catalog');
  if (new Set(saved.map(product => normalize(product.name))).size !== saved.length) throw new Error('Duplicate catalog product');
  return saved.map(product => ({ name: product.name, category: product.category, hidden: product.hidden })).sort((a, b) => normalize(a.name).localeCompare(normalize(b.name), 'he'));
}
function applyCatalog(saved) {
  const next = parseCatalog(saved);
  if (JSON.stringify(next) === JSON.stringify(catalogOverrides)) return;
  catalogOverrides = next;
  const merged = new Map(baseProducts.map(product => [normalize(product.name), product]));
  for (const product of next) {
    const key = normalize(product.name);
    if (product.hidden) merged.delete(key);
    else merged.set(key, { name: product.name, category: product.category, frequency: merged.get(key)?.frequency || 0 });
  }
  products = [...merged.values()].sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name, 'he'));
  productByName = new Map(products.map(product => [normalize(product.name), product]));
  catalogDirty = true;
}
function applyCatalogProduct(product) {
  const rest = catalogOverrides.filter(existing => normalize(existing.name) !== normalize(product.name));
  applyCatalog([...rest, product]);
}
async function hideCatalogProduct(product) {
  if (!window.confirm(`להסיר את ״${product.name}״ מאפשרויות הבחירה אצל כולם? מוצרים שכבר ברשימת הקניות לא יימחקו.`)) return false;
  const success = await mutate(async () => {
    const data = await request('POST', { action: 'hide-product', name: product.name, category: product.category });
    applyCatalogProduct(data.catalogProduct);
    removedItem = null; toast(`${product.name} הוסר מאפשרויות הבחירה אצל כולם`);
  });
  if (success && activeCategory) searchInput.focus({ preventScroll: true });
  return success;
}
async function restoreCatalogProduct(product) {
  await mutate(async () => {
    const data = await request('POST', { action: 'restore-product', name: product.name, category: product.category });
    applyCatalogProduct(data.catalogProduct);
    removedItem = null; toast(`${product.name} הוחזר לאפשרויות הבחירה אצל כולם`);
  });
}

function announce(message) { status.textContent = message; }
function toast(message, undo = false) {
  document.querySelector('#toast-message').textContent = message;
  document.querySelector('#undo-button').hidden = !undo;
  document.querySelector('#toast').hidden = false;
}
function inList(name) { return items.some(item => normalize(item.name) === normalize(name)); }
function updateConnection() {
  const editable = sharedReady && navigator.onLine && !writing;
  document.querySelector('#sync-label').textContent = !navigator.onLine ? 'אין חיבור — מוצג העדכון האחרון' : writing ? 'שומרים ברשימה המשותפת…' : sharedReady ? 'רשימה אחת לכולם · מתעדכנת אוטומטית' : 'אין חיבור לרשימה המשותפת';
  document.querySelector('#sync-state').classList.toggle('disconnected', !sharedReady || !navigator.onLine);
  document.querySelectorAll('.product-button, .item input, .delete-button, #custom-form button, #custom-search-add, #undo-button, .suggestion, .restore-product').forEach(control => { control.disabled = !editable; });
  document.querySelector('#import-local').disabled = !editable;
  document.querySelector('#import-panel').hidden = legacyItems.length === 0;
  document.querySelector('#import-count').textContent = legacyItems.length;
  document.querySelector('#list-unavailable').hidden = hasSnapshot;
  document.querySelector('#empty-state').hidden = !hasSnapshot || items.length > 0;
  updateQuickControls();
}
async function request(method = 'GET', body) {
  let response;
  try { response = await fetch('./api/list', {
    method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000)
  }); } catch { throw new Error('לא ניתן להתחבר לרשימה המשותפת כרגע. בדקו את החיבור ונסו לרענן.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('הרשימה המשותפת אינה זמינה כרגע. נסו לרענן.'); }
  if (!response.ok) throw new Error(data.error || 'לא ניתן לעדכן את הרשימה המשותפת כרגע.');
  return data;
}
function refreshDisplay() {
  renderItems();
  if (catalogDirty) {
    renderCategories();
    if (activeCategory) renderCategoryProducts();
    catalogDirty = false;
  }
  updateProductStates(); updateConnection();
}
async function refreshShared() {
  if (reading || writing || !navigator.onLine) { updateConnection(); return; }
  reading = true;
  const startEpoch = epoch;
  try {
    const data = await request();
    let nextItems, nextCatalog;
    try { nextItems = parseItems(data.items); nextCatalog = parseCatalog(data.catalog); } catch { throw new Error('לא ניתן לקרוא את הרשימה המשותפת כרגע. נסו לרענן.'); }
    if (startEpoch !== epoch) return;
    const changed = JSON.stringify(nextItems) !== JSON.stringify(items) || JSON.stringify(nextCatalog) !== JSON.stringify(catalogOverrides);
    applyCatalog(nextCatalog);
    items = nextItems; hasSnapshot = true; sharedReady = true; warning.hidden = true; cacheSnapshot();
    if (changed) {
      const focusedRow = document.activeElement?.closest('.item');
      const focusedId = focusedRow?.dataset.id;
      const focusedDelete = document.activeElement?.classList.contains('delete-button');
      refreshDisplay();
      if (focusedId) {
        const row = [...document.querySelectorAll('.item')].find(row => row.dataset.id === focusedId);
        (row?.querySelector(focusedDelete ? 'button' : 'input') || document.querySelector('#list-heading')).focus({ preventScroll: true });
      }
      announce('הרשימה המשותפת עודכנה');
    } else updateConnection();
  } catch (error) {
    if (startEpoch !== epoch) return;
    sharedReady = false;
    showWarning(navigator.onLine ? error.message : 'אין חיבור לאינטרנט. אפשר לעיין בעותק האחרון; לשינויים יש להתחבר מחדש.');
    updateConnection();
  } finally { reading = false; }
}
async function mutate(operation) {
  if (writing) return false;
  if (!sharedReady || !navigator.onLine) { toast('כדי לעדכן את הרשימה של כולם צריך חיבור. לחצו על רענון ונסו שוב.'); return false; }
  writing = true; epoch++; updateConnection();
  try {
    await operation();
    hasSnapshot = true; cacheSnapshot(); warning.hidden = true;
    return true;
  } catch (error) {
    showWarning(`${error.message} לא ניתן לאשר שהפעולה הושלמה; רעננו לפני ניסיון נוסף.`);
    return false;
  } finally {
    writing = false; epoch++; refreshDisplay();
    // Merge only the affected item locally; fetch the server snapshot to include other users' changes.
    void refreshShared();
  }
}
async function addItem(value, categoryId, remember = false) {
  const name = value.trim().slice(0, 160);
  if (!name) return false;
  const known = productByName.get(normalize(name));
  const input = { name: known?.name || name, category: known?.category || categoryId || 'other', remember: remember && !known };
  return mutate(async () => {
    const data = await request('POST', input);
    const [item] = parseItems([data.item]);
    if (data.catalogProduct) applyCatalogProduct(data.catalogProduct);
    removedItem = null;
    if (!items.some(existing => existing.id === item.id)) {
      items = items.filter(existing => normalize(existing.name) !== normalize(item.name)); items.push(item);
    }
    toast(input.remember ? `${item.name} נוסף לרשימה ונשמר לבחירה קבועה` : data.created ? `${item.name} נוסף לרשימה של כולם` : `${item.name} כבר ברשימה המשותפת`);
  });
}
function renderCategories() {
  const grid = document.querySelector('#category-grid'); grid.replaceChildren();
  for (const category of categories) {
    const link = document.createElement('a');
    link.href = `#category/${category.id}`;
    link.className = `category-card${category.id === 'other' ? ' other' : ''}`;
    const symbol = document.createElement('span'); symbol.className = 'category-symbol'; symbol.textContent = category.icon; symbol.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong'); name.textContent = category.name;
    const meta = document.createElement('span'); meta.className = 'category-meta';
    const count = document.createElement('span');
    count.textContent = category.id === 'other' ? 'גם בטקסט חופשי' : `${products.filter(product => product.category === category.id).length} מוצרים`;
    const arrow = document.createElement('span'); arrow.textContent = '←'; arrow.setAttribute('aria-hidden', 'true');
    meta.append(count, arrow); link.append(symbol, name, meta); grid.append(link);
  }
  document.querySelector('#catalog-count').textContent = `${products.length} מוצרים, במקום אחד`;
}
function updateProductStates() {
  document.querySelectorAll('[data-product]').forEach(button => {
    const chosen = inList(button.dataset.product);
    button.classList.toggle('chosen', chosen && !editingCatalog);
    button.classList.toggle('catalog-remove', editingCatalog);
    button.querySelector('.product-state').textContent = editingCatalog ? '×' : chosen ? '✓' : '+';
    button.setAttribute('aria-label', editingCatalog ? `הסרת ${button.dataset.product} מהאפשרויות` : `${button.dataset.product} — ${chosen ? 'כבר ברשימה' : 'הוספה לרשימה'}`);
  });
  if (!document.querySelector('#suggestions-panel').hidden) renderSearch(false);
  updateConnection();
}
function renderCategory(category) {
  activeCategory = category;
  document.querySelector('#category-heading').textContent = category.name;
  document.querySelector('#category-icon').textContent = category.icon;
  document.querySelector('#category-description').textContent = category.description;
  searchInput.value = '';
  closeSearch();
  document.querySelector('#clear-search').hidden = true;
  editingCatalog = false;
  renderCategoryProducts();
  document.querySelector('#custom-details').open = category.id === 'other';
  document.querySelector('#custom-input').value = '';
  updateProductStates();
}
function renderCategoryProducts() {
  const category = activeCategory;
  const categoryProducts = products.filter(product => product.category === category.id);
  document.querySelector('#category-product-count').textContent = `${categoryProducts.length} מוצרים · ${editingCatalog ? 'לחיצה להסרה מהאפשרויות' : 'לחיצה להוספה'}`;
  const grid = document.querySelector('#product-grid'); grid.replaceChildren();
  for (const product of categoryProducts) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'product-button'; button.dataset.product = product.name;
    const name = document.createElement('span'); name.textContent = product.name;
    const state = document.createElement('span'); state.className = 'product-state'; state.setAttribute('aria-hidden', 'true');
    button.append(name, state);
    button.addEventListener('click', () => editingCatalog ? hideCatalogProduct(product) : addItem(product.name, category.id));
    grid.append(button);
  }
  document.querySelector('#manage-catalog').setAttribute('aria-pressed', String(editingCatalog));
  document.querySelector('#manage-catalog').textContent = editingCatalog ? 'סיום עריכה' : 'עריכת מוצרים';
  document.querySelector('#catalog-edit-note').hidden = !editingCatalog;
  document.querySelector('#custom-details').hidden = editingCatalog;
  document.querySelector('.search-help').textContent = editingCatalog ? 'חפשו מוצר ולחצו עליו להסרה מאפשרויות הבחירה אצל כולם.' : 'ההשלמות הן מתוך הקטגוריה הזאת. בחרו מוצר כדי להוסיף לרשימה.';
  const hidden = catalogOverrides.filter(product => product.hidden && product.category === category.id);
  document.querySelector('#hidden-products').hidden = !editingCatalog || hidden.length === 0;
  document.querySelector('#hidden-product-count').textContent = hidden.length;
  const hiddenList = document.querySelector('#hidden-product-list'); hiddenList.replaceChildren();
  for (const product of hidden) {
    const row = document.createElement('div'); row.className = 'hidden-product';
    const name = document.createElement('span'); name.textContent = product.name;
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'restore-product'; restore.textContent = 'שחזור';
    restore.setAttribute('aria-label', `שחזור ${product.name} לאפשרויות`);
    restore.addEventListener('click', () => restoreCatalogProduct(product));
    row.append(name, restore); hiddenList.append(row);
  }
}
document.querySelector('#manage-catalog').addEventListener('click', () => {
  editingCatalog = !editingCatalog; renderCategoryProducts(); updateProductStates();
});
function closeSearch() {
  document.querySelector('#suggestions-panel').hidden = true;
  document.querySelector('#browse-products').hidden = false;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
  suggestions = []; activeOption = -1;
}
function setActiveOption(index) {
  activeOption = index;
  document.querySelectorAll('.suggestion').forEach((option, optionIndex) => option.setAttribute('aria-selected', String(index === optionIndex)));
  if (index >= 0) {
    searchInput.setAttribute('aria-activedescendant', `suggestion-${index}`);
    document.querySelector(`#suggestion-${index}`)?.scrollIntoView({ block: 'nearest' });
  } else searchInput.removeAttribute('aria-activedescendant');
}
async function chooseSuggestion(product) {
  const query = searchInput.value;
  const success = editingCatalog ? await hideCatalogProduct(product) : await addItem(product.name, activeCategory.id);
  if (success && searchInput.value === query) {
    searchInput.value = ''; document.querySelector('#clear-search').hidden = true; closeSearch();
  }
  if (!document.querySelector('#category-view').hidden) searchInput.focus();
}
function renderSearch(resetActive = true) {
  if (!activeCategory) return;
  const query = normalize(searchInput.value);
  document.querySelector('#clear-search').hidden = searchInput.value.length === 0;
  if (!query) { closeSearch(); return; }
  const matching = products.filter(product => product.category === activeCategory.id && normalize(product.name).includes(query));
  matching.sort((a, b) => Number(normalize(b.name).startsWith(query)) - Number(normalize(a.name).startsWith(query)) || b.frequency - a.frequency);
  suggestions = matching.slice(0, 12);
  const results = document.querySelector('#search-results'); results.replaceChildren();
  for (const [index, product] of suggestions.entries()) {
    const option = document.createElement('button');
    option.type = 'button'; option.tabIndex = -1; option.id = `suggestion-${index}`;
    option.className = 'suggestion'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
    const name = document.createElement('span'); name.textContent = product.name;
    const state = document.createElement('span'); state.textContent = editingCatalog ? '× הסרה מהאפשרויות' : inList(product.name) ? 'כבר ברשימה ✓' : '+ הוספה';
    option.append(name, state);
    option.addEventListener('click', () => chooseSuggestion(product));
    results.append(option);
  }
  document.querySelector('#suggestions-panel').hidden = false;
  document.querySelector('#browse-products').hidden = true;
  document.querySelector('#no-results').hidden = suggestions.length > 0;
  document.querySelector('#no-results').textContent = editingCatalog ? 'לא נמצא מוצר מתאים להסרה בקטגוריה.' : 'לא נמצא מוצר מתאים בקטגוריה. אפשר להוסיף אותו ב״אחר״.';
  document.querySelector('#custom-search-add').hidden = editingCatalog;
  document.querySelector('#custom-search-add').textContent = `אחר — הוספת ״${searchInput.value.trim()}״ לרשימה`;
  searchInput.setAttribute('aria-expanded', 'true');
  setActiveOption(resetActive ? -1 : Math.min(activeOption, suggestions.length - 1));
  updateConnection();
  if (resetActive) announce(matching.length ? `${matching.length} מוצרים מתאימים בקטגוריה` : 'אין מוצרים מתאימים. אפשר להוסיף מוצר אחר בטקסט חופשי.');
}
searchInput.addEventListener('input', () => renderSearch());
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) renderSearch(); });
searchInput.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (document.querySelector('#suggestions-panel').hidden) renderSearch();
    if (!suggestions.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    setActiveOption(activeOption < 0 ? (step > 0 ? 0 : suggestions.length - 1) : (activeOption + step + suggestions.length) % suggestions.length);
  }
});
document.querySelector('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!searchInput.value.trim()) return;
  if (document.querySelector('#suggestions-panel').hidden) { renderSearch(); return; }
  if (suggestions.length) chooseSuggestion(suggestions[activeOption < 0 ? 0 : activeOption]);
  else addCustomSearch();
});
async function addCustomSearch() {
  if (editingCatalog) return;
  const query = searchInput.value;
  if (!query.trim()) return;
  const success = await addItem(query, activeCategory.id, true);
  if (success && searchInput.value === query) {
    searchInput.value = ''; closeSearch(); document.querySelector('#clear-search').hidden = true;
  }
  if (!document.querySelector('#category-view').hidden) searchInput.focus();
}
document.querySelector('#custom-search-add').addEventListener('click', addCustomSearch);
document.querySelector('#clear-search').addEventListener('click', () => { searchInput.value = ''; renderSearch(); searchInput.focus(); });
document.querySelector('#custom-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#custom-input');
  if (!input.value.trim()) { input.focus(); return; }
  const value = input.value;
  const success = await addItem(value, activeCategory.id, true);
  if (success && input.value === value) input.value = '';
  if (!document.querySelector('#category-view').hidden) input.focus();
});
async function removeItem(id, purchased) {
  const item = items.find(item => item.id === id);
  if (!item) return;
  const position = [...document.querySelectorAll('.item')].findIndex(row => row.dataset.id === id);
  const success = await mutate(async () => {
    const result = await request('DELETE', item);
    items = items.filter(existing => existing.id !== id);
    removedItem = result.removed ? { item } : null;
    toast(result.removed ? (purchased ? `${item.name} נקנה והוסר מהרשימה של כולם` : `${item.name} הוסר מהרשימה של כולם`) : `${item.name} כבר הוסר על ידי משתתף אחר`, result.removed);
  });
  if (success && !document.querySelector('#list-view').hidden) {
    const rows = document.querySelectorAll('.item');
    (rows[Math.min(position, rows.length - 1)]?.querySelector('input') || document.querySelector('#list-heading')).focus({ preventScroll: true });
  }
}
function renderItems() {
  document.querySelector('#nav-count').textContent = items.length;
  document.querySelector('#list-count').textContent = `${items.length} מוצרים ברשימה`;
  document.querySelector('#empty-state').hidden = items.length > 0;
  const groups = document.querySelector('#shopping-groups'); groups.replaceChildren();
  for (const category of categories) {
    const grouped = items.filter(item => item.category === category.id);
    if (!grouped.length) continue;
    const group = document.createElement('section'); group.className = 'shopping-group';
    const title = document.createElement('h3'); title.className = 'group-title';
    const icon = document.createElement('span'); icon.textContent = category.icon; icon.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('span'); heading.textContent = category.name;
    const count = document.createElement('span'); count.textContent = grouped.length;
    title.append(icon, heading, count);
    const list = document.createElement('ul'); list.setAttribute('aria-label', category.name);
    for (const item of grouped) {
      const row = document.createElement('li'); row.className = 'item'; row.dataset.id = item.id;
      const label = document.createElement('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `${item.name} — סימון כנקנה והסרה מהרשימה`);
      check.addEventListener('change', () => removeItem(item.id, true));
      const name = document.createElement('span'); name.className = 'item-name'; name.textContent = item.name;
      label.append(check, name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-button'; remove.setAttribute('aria-label', `מחיקת ${item.name}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
      remove.addEventListener('click', () => removeItem(item.id, false));
      row.append(label, remove); list.append(row);
    }
    group.append(title, list); groups.append(group);
  }
}
document.querySelector('#undo-button').addEventListener('click', async () => {
  if (!removedItem) return;
  const { item } = removedItem;
  const success = await mutate(async () => {
    const data = await request('POST', item);
    const [restored] = parseItems([data.item]);
    items = items.filter(existing => normalize(existing.name) !== normalize(restored.name));
    items.push(restored); removedItem = null;
    toast(`${restored.name} הוחזר לרשימה של כולם`);
  });
  if (success && !document.querySelector('#list-view').hidden) {
    const row = [...document.querySelectorAll('.item')].find(row => normalize(row.querySelector('.item-name').textContent) === normalize(item.name));
    row?.querySelector('input').focus({ preventScroll: true });
  }
});
document.querySelector('#dismiss-toast').addEventListener('click', () => {
  document.querySelector('#toast').hidden = true;
  const section = !document.querySelector('#list-view').hidden ? 'list' : activeCategory ? 'category' : 'home';
  document.querySelector(`#${section}-heading`).focus();
});
function route(focusHeading = true) {
  const hash = location.hash.slice(1);
  const category = hash.startsWith('category/') ? byId.get(hash.slice(9)) : null;
  const view = hash === 'list' ? 'list' : category ? 'category' : 'home';
  if (view !== 'home' && listening && recognition) recognition.stop();
  for (const id of ['home', 'category', 'list']) document.querySelector(`#${id}-view`).hidden = id !== view;
  document.querySelector('#catalog-tab').toggleAttribute('aria-current', view !== 'list');
  document.querySelector('#list-tab').toggleAttribute('aria-current', view === 'list');
  document.querySelectorAll('.bottom-nav [aria-current]').forEach(tab => tab.setAttribute('aria-current', 'page'));
  if (category) renderCategory(category); else { activeCategory = null; closeSearch(); }
  document.title = `${category ? category.name : view === 'list' ? 'הרשימה המשותפת' : 'בוחרים מוצרים'} — קניות`;
  if (focusHeading) { document.querySelector(`#${view}-heading`).focus(); window.scrollTo(0, 0); }
}
window.addEventListener('hashchange', () => route());
document.querySelector('#refresh-list').addEventListener('click', () => void refreshShared());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshShared(); });
window.addEventListener('online', () => void refreshShared());
window.addEventListener('offline', () => { sharedReady = false; updateConnection(); });
window.addEventListener('focus', () => void refreshShared());
setInterval(() => { if (!document.hidden) void refreshShared(); }, 15000);
document.querySelector('#import-local').addEventListener('click', async () => {
  const success = await mutate(async () => {
    while (legacyItems.length) {
      const old = legacyItems[0];
      const data = await request('POST', { name: old.name.slice(0, 160), category: old.category });
      const [item] = parseItems([data.item]);
      items = items.filter(existing => normalize(existing.name) !== normalize(item.name)); items.push(item);
      legacyItems.shift();
    }
    try { localStorage.setItem(IMPORT_KEY, 'true'); } catch { /* Old data is kept untouched. */ }
    removedItem = null; toast('המוצרים מהרשימה הקודמת נוספו לרשימה של כולם');
  });
  if (!success) updateConnection();
});
function updateQuickControls() {
  document.querySelector('#quick-add').disabled = writing || listening || !sharedReady || !navigator.onLine || quickCandidates.length === 0 || quickCandidates.length > 20;
  document.querySelector('#voice-button').disabled = writing;
  document.querySelector('#quick-input').disabled = writing || listening;
  document.querySelectorAll('.quick-remove').forEach(button => { button.disabled = writing || listening; });
}
function renderQuickPreview() {
  document.querySelector('#quick-preview').hidden = quickCandidates.length === 0;
  document.querySelector('#quick-limit').hidden = quickCandidates.length <= 20;
  const preview = document.querySelector('#quick-products'); preview.replaceChildren();
  for (const product of quickCandidates) {
    const chip = document.createElement('div'); chip.className = 'quick-chip';
    const name = document.createElement('span'); name.textContent = product.name;
    const category = document.createElement('small'); category.textContent = product.known ? byId.get(product.category).name : 'חדש · אחר';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quick-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `הסרת ${product.name} מההוספה המהירה`);
    remove.addEventListener('click', () => {
      quickCandidates = quickCandidates.filter(candidate => candidate !== product); renderQuickPreview();
      document.querySelector('#quick-input').focus();
    });
    chip.append(name, category, remove); preview.append(chip);
  }
  updateQuickControls();
}
function parseQuickInput() {
  quickCandidates = window.QUICK_ENTRY.parse(document.querySelector('#quick-input').value, products);
  renderQuickPreview();
}
document.querySelector('#quick-input').addEventListener('input', parseQuickInput);
document.querySelector('#quick-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (listening || !quickCandidates.length || quickCandidates.length > 20) return;
  const pending = [...quickCandidates];
  const success = await mutate(async () => {
    for (const candidate of pending) {
      const known = productByName.get(normalize(candidate.name));
      const data = await request('POST', { name: known?.name || candidate.name, category: known?.category || 'other', remember: !known });
      const [item] = parseItems([data.item]);
      if (data.catalogProduct) applyCatalogProduct(data.catalogProduct);
      items = items.filter(existing => normalize(existing.name) !== normalize(item.name)); items.push(item);
      quickCandidates = quickCandidates.filter(product => product !== candidate);
    }
    removedItem = null;
    toast('המוצרים נוספו לרשימה של כולם');
  });
  if (success && !quickCandidates.length) document.querySelector('#quick-input').value = '';
  // Successfully saved products leave the preview; failures keep remaining products for retry.
  renderQuickPreview();
});
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const button = document.querySelector('#voice-button'); button.hidden = false;
  button.addEventListener('click', () => {
    if (listening && recognition) { recognition.stop(); return; }
    const input = document.querySelector('#quick-input');
    const before = input.value.trim(); let finalTranscript = ''; let hadError = false;
    recognition = new SpeechRecognition(); recognition.lang = 'he-IL'; recognition.continuous = false; recognition.interimResults = true;
    listening = true; button.setAttribute('aria-pressed', 'true'); button.textContent = 'עצירת הכתבה';
    document.querySelector('#voice-status').textContent = 'מקשיבים… אמרו אילו מוצרים צריך.';
    updateQuickControls();
    recognition.onresult = event => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) finalTranscript += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      if (finalTranscript.trim()) {
        input.value = [before, finalTranscript.trim()].filter(Boolean).join(', ').slice(0, 1200);
        parseQuickInput();
      }
      document.querySelector('#voice-status').textContent = interim ? `שמענו: ${interim}` : 'הטקסט התקבל. בדקו את המוצרים שזיהינו.';
    };
    recognition.onerror = event => {
      hadError = true;
      document.querySelector('#voice-status').textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'אין הרשאה למיקרופון. אפשר לאפשר אותה בדפדפן או להקליד במקום.' : event.error === 'no-speech' ? 'לא שמענו דיבור. נסו שוב או הקלידו את המוצרים.' : 'ההכתבה לא זמינה כרגע. אפשר להקליד או להשתמש במיקרופון שבמקלדת הטלפון.';
    };
    recognition.onend = () => {
      listening = false; recognition = null; button.setAttribute('aria-pressed', 'false'); button.textContent = 'הכתבה קולית';
      if (!hadError) document.querySelector('#voice-status').textContent = finalTranscript.trim() ? 'בדקו את המוצרים ולחצו על הוספה לרשימה.' : 'לא התקבל טקסט. אפשר לנסות שוב או להקליד.';
      updateQuickControls();
    };
    try { recognition.start(); } catch {
      listening = false; recognition = null; button.setAttribute('aria-pressed', 'false'); button.textContent = 'הכתבה קולית';
      document.querySelector('#voice-status').textContent = 'לא ניתן להתחיל הכתבה. נסו להקליד או להשתמש במיקרופון שבמקלדת הטלפון.';
      updateQuickControls();
    }
  });
} else {
  document.querySelector('#voice-status').textContent = 'להכתבה קולית אפשר להשתמש במיקרופון שבמקלדת הטלפון.';
}

renderCategories(); renderItems(); route(false); updateConnection();
void refreshShared();
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event; document.querySelector('#install-panel').hidden = false;
});
document.querySelector('#install-button').addEventListener('click', async () => {
  if (!installPrompt) return;
  try { await installPrompt.prompt(); } finally { installPrompt = null; document.querySelector('#install-panel').hidden = true; }
});
window.addEventListener('appinstalled', () => { document.querySelector('#install-panel').hidden = true; });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {
    showWarning('מצב ללא אינטרנט אינו זמין כרגע. הרשימה המשותפת נשמרת בשרת.');
  }));
}
