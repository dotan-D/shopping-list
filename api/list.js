'use strict';
const { readList, addItem, removeItem, readCatalog, saveProduct } = require('../server/shared-list.cjs');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return res.status(405).json({ error: 'פעולה לא נתמכת.' });
    }
    if (req.method === 'GET') {
      const [items, catalog] = await Promise.all([readList(), readCatalog()]);
      return res.status(200).json({ items, catalog });
    }
    // JSON-only mutations and no CORS prevent writes from unrelated browser origins.
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'סוג הבקשה אינו נתמך.' });
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({ error: 'הבקשה אינה מורשית.' }); }
      if (origin.host !== req.headers.host) return res.status(403).json({ error: 'הבקשה אינה מורשית.' });
    }
    if (Number(req.headers['content-length']) > 2048) return res.status(413).json({ error: 'הבקשה ארוכה מדי.' });
    let body;
    try {
      if (req.body !== undefined) body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      else {
        let content = '';
        for await (const chunk of req) {
          content += chunk;
          if (Buffer.byteLength(content) > 2048) return res.status(413).json({ error: 'הבקשה ארוכה מדי.' });
        }
        body = JSON.parse(content);
      }
      if (Buffer.byteLength(JSON.stringify(body) || '') > 2048) return res.status(413).json({ error: 'הבקשה ארוכה מדי.' });
    } catch { return res.status(400).json({ error: 'פרטי הבקשה אינם תקינים.' }); }
    let result;
    if (req.method === 'POST' && body?.action === 'hide-product') result = await saveProduct(body, true);
    else if (req.method === 'POST' && body?.action === 'restore-product') result = await saveProduct(body, false);
    else if (body?.action !== undefined) return res.status(400).json({ error: 'פעולה לא נתמכת.' });
    else result = req.method === 'POST' ? await addItem(body) : await removeItem(body);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'אירעה תקלה. נסו שוב.' });
  }
};
