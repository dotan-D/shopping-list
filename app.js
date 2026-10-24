'use strict';
const STORAGE_KEY = 'shopping-list.v1';
const { categories, products } = window.SHOPPING_CATALOG;
const byId = new Map(categories.map(category => [category.id, category]));
const normalize = value => value.normalize('NFKD').replace(/[\u0591-\u05C7]/g, '').replace(/[׳״'"’`]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('he');
const productByName = new Map(products.map(product => [normalize(product.name), product]));
const searchInput = document.querySelector('#product-search');
const warning = document.querySelector('#storage-warning');
const status = document.querySelector('#status');
let items = [];
let storageReadable = true;
let activeCategory = null;
let suggestions = [];
let activeOption = -1;
let removedItem = null;

function showWarning(message) { warning.textContent = message; warning.hidden = false; }
function parseItems(raw) {
  if (raw === null) return [];
  const saved = JSON.parse(raw);
  if (!Array.isArray(saved) || !saved.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim() && typeof item.done === 'boolean') || new Set(saved.map(item => item.id)).size !== saved.length) throw new Error('Invalid saved list');
  // Older versions kept purchased items. Only pending items belong in the new shopping view.
  return saved.filter(item => !item.done).map(item => ({
    ...item,
    category: byId.has(item.category) ? item.category : (productByName.get(normalize(item.name))?.category || 'other')
  }));
}
try { items = parseItems(localStorage.getItem(STORAGE_KEY)); }
catch {
  storageReadable = false;
  showWarning('לא ניתן לקרוא את הרשימה השמורה. אפשר להשתמש ברשימה זמנית; הנתונים הקודמים לא יידרסו.');
}
function save() {
  if (!storageReadable) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); warning.hidden = true; }
  catch { showWarning('השמירה במכשיר אינה זמינה כרגע. השינויים נשמרים רק עד לסגירת העמוד.'); }
}
function announce(message) { status.textContent = message; }
function toast(message, undo = false) {
  document.querySelector('#toast-message').textContent = message;
  document.querySelector('#undo-button').hidden = !undo;
  document.querySelector('#toast').hidden = false;
}
function inList(name) { return items.some(item => normalize(item.name) === normalize(name)); }
function addItem(value, categoryId) {
  const name = value.trim().slice(0, 160);
  if (!name) return false;
  removedItem = null;
  if (inList(name)) { toast(`${name} כבר ברשימה`); return false; }
  const knownProduct = productByName.get(normalize(name));
  items.push({ id: crypto.randomUUID(), name: knownProduct?.name || name, done: false, category: knownProduct?.category || categoryId || 'other' });
  save(); renderItems(); updateProductStates();
  toast(`${knownProduct?.name || name} נוסף לרשימה`);
  return true;
}
function renderCategories() {
  const grid = document.querySelector('#category-grid');
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
    button.classList.toggle('chosen', chosen);
    button.querySelector('.product-state').textContent = chosen ? '✓' : '+';
    button.setAttribute('aria-label', `${button.dataset.product} — ${chosen ? 'כבר ברשימה' : 'הוספה לרשימה'}`);
  });
  if (!document.querySelector('#suggestions-panel').hidden) renderSearch(false);
}
function renderCategory(category) {
  activeCategory = category;
  document.querySelector('#category-heading').textContent = category.name;
  document.querySelector('#category-icon').textContent = category.icon;
  document.querySelector('#category-description').textContent = category.description;
  searchInput.value = '';
  closeSearch();
  document.querySelector('#clear-search').hidden = true;
  const categoryProducts = products.filter(product => product.category === category.id);
  document.querySelector('#category-product-count').textContent = `${categoryProducts.length} מוצרים · לחיצה להוספה`;
  const grid = document.querySelector('#product-grid'); grid.replaceChildren();
  for (const product of categoryProducts) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'product-button'; button.dataset.product = product.name;
    const name = document.createElement('span'); name.textContent = product.name;
    const state = document.createElement('span'); state.className = 'product-state'; state.setAttribute('aria-hidden', 'true');
    button.append(name, state);
    button.addEventListener('click', () => addItem(product.name, category.id));
    grid.append(button);
  }
  document.querySelector('#custom-details').open = category.id === 'other';
  document.querySelector('#custom-input').value = '';
  updateProductStates();
}
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
function chooseSuggestion(product) {
  addItem(product.name, activeCategory.id);
  searchInput.value = '';
  document.querySelector('#clear-search').hidden = true;
  closeSearch(); searchInput.focus();
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
    const state = document.createElement('span'); state.textContent = inList(product.name) ? 'כבר ברשימה ✓' : '+ הוספה';
    option.append(name, state);
    option.addEventListener('click', () => chooseSuggestion(product));
    results.append(option);
  }
  document.querySelector('#suggestions-panel').hidden = false;
  document.querySelector('#browse-products').hidden = true;
  document.querySelector('#no-results').hidden = suggestions.length > 0;
  document.querySelector('#custom-search-add').textContent = `אחר — הוספת ״${searchInput.value.trim()}״ לרשימה`;
  searchInput.setAttribute('aria-expanded', 'true');
  setActiveOption(resetActive ? -1 : Math.min(activeOption, suggestions.length - 1));
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
function addCustomSearch() {
  if (!searchInput.value.trim()) return;
  addItem(searchInput.value, activeCategory.id);
  searchInput.value = ''; closeSearch(); document.querySelector('#clear-search').hidden = true; searchInput.focus();
}
document.querySelector('#custom-search-add').addEventListener('click', addCustomSearch);
document.querySelector('#clear-search').addEventListener('click', () => { searchInput.value = ''; renderSearch(); searchInput.focus(); });
document.querySelector('#custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.querySelector('#custom-input');
  if (!input.value.trim()) { input.focus(); return; }
  addItem(input.value, activeCategory.id); input.value = ''; input.focus();
});
function removeItem(id, purchased) {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return;
  const position = [...document.querySelectorAll('.item')].findIndex(row => row.dataset.id === id);
  const [item] = items.splice(index, 1);
  removedItem = { item, index };
  save(); renderItems(); updateProductStates();
  toast(purchased ? `${item.name} נקנה והוסר מהרשימה` : `${item.name} הוסר מהרשימה`, true);
  const rows = document.querySelectorAll('.item');
  (rows[Math.min(position, rows.length - 1)]?.querySelector('input') || document.querySelector('#list-heading')).focus();
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
document.querySelector('#undo-button').addEventListener('click', () => {
  if (!removedItem) return;
  const { item, index } = removedItem; removedItem = null;
  if (!inList(item.name)) items.splice(Math.min(index, items.length), 0, item);
  save(); renderItems(); updateProductStates(); toast(`${item.name} הוחזר לרשימה`);
  if (!document.querySelector('#list-view').hidden) {
    const row = [...document.querySelectorAll('.item')].find(row => row.dataset.id === item.id);
    row?.querySelector('input').focus();
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
  for (const id of ['home', 'category', 'list']) document.querySelector(`#${id}-view`).hidden = id !== view;
  document.querySelector('#catalog-tab').toggleAttribute('aria-current', view !== 'list');
  document.querySelector('#list-tab').toggleAttribute('aria-current', view === 'list');
  document.querySelectorAll('.bottom-nav [aria-current]').forEach(tab => tab.setAttribute('aria-current', 'page'));
  if (category) renderCategory(category); else { activeCategory = null; closeSearch(); }
  document.title = `${category ? category.name : view === 'list' ? 'הרשימה שלי' : 'בוחרים מוצרים'} — קניות`;
  if (focusHeading) { document.querySelector(`#${view}-heading`).focus(); window.scrollTo(0, 0); }
}
window.addEventListener('hashchange', () => route());
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    items = parseItems(event.newValue); storageReadable = true; removedItem = null;
    renderItems(); updateProductStates(); document.querySelector('#toast').hidden = true;
    announce('הרשימה עודכנה מחלון אחר');
  } catch { showWarning('לא ניתן לקרוא את הרשימה שעודכנה בחלון אחר. רעננו את הדף לפני שינויים נוספים.'); storageReadable = false; }
});
renderCategories(); renderItems(); route(false);
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
    showWarning('מצב ללא אינטרנט אינו זמין כרגע. הרשימה עדיין נשמרת במכשיר.');
  }));
}
