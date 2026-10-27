'use strict';
(function (root) {
  const normalize = value => value.normalize('NFKD').replace(/[\u0591-\u05C7]/g, '').replace(/[׳״'"’`]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('he');
  const words = value => normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
  const aliases = {
    'עגבניה': 'עגבניות', 'עגבנייה': 'עגבניות', 'מלפפון': 'מלפפונים', 'בננה': 'בננות',
    'תפוח': 'תפוחים', 'ביצה': 'ביצים', 'תפוז': 'תפוזים', 'תות': 'תותים',
    'גבינת קוטג': 'קוטג', 'עגבניות שרי': 'שרי', 'שקיות זבל': 'שקיות אשפה'
  };
  function parse(text, products) {
    const byName = new Map(products.map(product => [normalize(product.name), product]));
    const terms = products.map(product => ({ tokens: words(product.name), product })).filter(term => term.tokens.length);
    for (const [alias, name] of Object.entries(aliases)) {
      const product = byName.get(normalize(name));
      if (product) terms.push({ tokens: words(alias), product });
    }
    terms.sort((a, b) => b.tokens.length - a.tokens.length || (b.product.frequency || 0) - (a.product.frequency || 0));
    const starts = new Set(terms.map(term => term.tokens[0]));
    function matchAll(tokens) {
      const memo = new Map();
      function visit(index) {
        if (index === tokens.length) return [];
        if (memo.has(index)) return memo.get(index);
        if (/^ו?\d+$/.test(tokens[index]) || ['ו', 'וגם', 'גם'].includes(tokens[index])) {
          const rest = visit(index + 1); memo.set(index, rest); return rest;
        }
        for (const term of terms) {
          if (!term.tokens.every((token, offset) => {
            const actual = tokens[index + offset];
            return actual === token || (offset === 0 && actual === `ו${token}`);
          })) continue;
          const rest = visit(index + term.tokens.length);
          if (rest !== null) { const result = [term.product, ...rest]; memo.set(index, result); return result; }
        }
        memo.set(index, null); return null;
      }
      return visit(0);
    }
    const found = [];
    for (let segment of text.split(/[,،;\n]+/)) {
      segment = segment.trim();
      // Remove common request framing, but leave unknown product descriptions intact.
      let previous;
      do {
        previous = segment;
        segment = segment.replace(/^(?:אני רוצה|אני צריך|אני צריכה|אנחנו צריכים|אפשר להוסיף|לרשימת הקניות|שתוסיף|תקנה|תוסיף|תוסיפי|תוסיפו|להוסיף|צריך|צריכה|צריכים|רוצה|לקנות|לרשימה|לקניות|בבקשה|לי|לנו|את|וגם|גם)(?:\s+|$)/u, '').trim();
      } while (previous !== segment);
      segment = segment.replace(/(?:\s+(?:בבקשה|לרשימה|לקניות|לרשימת הקניות))+[.!?]?$/u, '').trim();
      if (!segment) continue;
      // Split a conjunction only when its next word starts a known product.
      const chunks = segment.split(/\s+(?=ו\S)/u).reduce((result, part) => {
        const first = words(part)[0];
        if (result.length && first?.startsWith('ו') && !starts.has(first) && starts.has(first.slice(1))) result.push(part.slice(1));
        else if (result.length) result[result.length - 1] += ` ${part}`;
        else result.push(part);
        return result;
      }, []);
      for (const chunk of chunks) {
        const tokens = words(chunk);
        if (!tokens.length || tokens.every(token => /^\d+$/.test(token))) continue;
        const matches = matchAll(tokens);
        if (matches?.length) found.push(...matches.map(product => ({ name: product.name, category: product.category, known: true })));
        else {
          const name = chunk.replace(/^\d+\s+/, '').trim().slice(0, 160);
          if (name) found.push({ name, category: 'other', known: false });
        }
      }
    }
    const unique = new Map();
    for (const product of found) if (!unique.has(normalize(product.name))) unique.set(normalize(product.name), product);
    return [...unique.values()];
  }
  root.QUICK_ENTRY = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QUICK_ENTRY;
})(globalThis);
