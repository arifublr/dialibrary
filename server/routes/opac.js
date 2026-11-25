'use strict';
/** OPAC: public-catalogue search, record view, facets, new arrivals. */
const express = require('express');
const { sql } = require('../db');
const settings = require('../settings');
const circ = require('../circ');
const { wrap, str, int, HttpError } = require('../util');

const r = express.Router();

r.use((req, res, next) => {
  if (!req.user && !settings.get().publicSearch) return next(new HttpError(401, 'Please sign in to search the catalogue'));
  next();
});

const FIELDS = { all: null, title: 'title', author: 'author', subject: 'subjects', isbn: 'isbn', callno: 'call_number' };

const shape = (b, av) => ({
  id: b.id, title: b.title, author: b.author, year: b.year, publisher: b.publisher, language: b.language,
  subjects: b.subjects ? b.subjects.split('|') : [], searchAliases: b.search_aliases ? b.search_aliases.split('|') : [],
  callNumber: b.call_number, isbn: b.isbn,
  copies: (av[b.id] || {}).copies || 0, available: (av[b.id] || {}).available || 0, nextDue: (av[b.id] || {}).nextDue || null,
});

r.get('/search', wrap(async (req, res) => {
  const q = str(req.query.q, { max: 120 });
  const field = FIELDS[req.query.field] !== undefined ? req.query.field : 'all';
  const subject = str(req.query.subject, { max: 80 });
  const language = str(req.query.language, { max: 40 });
  const onlyAvail = req.query.available === '1';
  const page = int(req.query.page, { min: 1, max: 500, def: 1, name: 'page' });
  const per = 12;

  const where = [], args = [];
  const from = 'biblio b';
  if (q) {
    const op = sql.isPg ? 'ILIKE' : 'LIKE';
    const term = `%${q}%`;
    if (field === 'title') {
      where.push(`(b.title ${op} ? OR b.search_aliases ${op} ?)`); args.push(term, term);
    } else if (field === 'author') {
      where.push(`(b.author ${op} ? OR b.search_aliases ${op} ?)`); args.push(term, term);
    } else if (field === 'subject') {
      where.push(`b.subjects ${op} ?`); args.push(term);
    } else if (field === 'isbn') {
      where.push(`b.isbn ${op} ?`); args.push(term);
    } else if (field === 'callno') {
      where.push(`b.call_number ${op} ?`); args.push(term);
    } else {
      where.push(`(b.title ${op} ? OR b.author ${op} ? OR b.search_aliases ${op} ? OR b.subjects ${op} ? OR b.isbn ${op} ? OR b.call_number ${op} ? OR b.publisher ${op} ? OR b.description ${op} ?)`);
      args.push(term, term, term, term, term, term, term, term);
    }
  }
  if (subject) { where.push(`('|'||b.subjects||'|') LIKE ?`); args.push(`%|${subject.replace(/[%_]/g, '')}|%`); }
  if (language) { where.push('b.language = ?'); args.push(language); }
  if (onlyAvail) where.push(`EXISTS (SELECT 1 FROM items i WHERE i.biblio_id=b.id AND i.status='available')`);
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = 'ORDER BY LOWER(b.title)';

  const total = (await sql.prepare(`SELECT COUNT(*) c FROM ${from} ${W}`).get(...args)).c;
  const rows = await sql.prepare(`SELECT b.* FROM ${from} ${W} ${order} LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
  const av = await circ.availabilityMap(rows.map((b) => b.id));

  // facets over the whole filtered set
  const ids = await sql.prepare(`SELECT b.subjects s, b.language l FROM ${from} ${W}`).all(...args);
  const sc = {}, lc = {};
  for (const x of ids) {
    for (const s of x.s ? x.s.split('|') : []) sc[s] = (sc[s] || 0) + 1;
    lc[x.l] = (lc[x.l] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  res.json({ total, page, per, results: rows.map((b) => shape(b, av)), facets: { subjects: top(sc, 12), languages: top(lc, 6) } });
}));

r.get('/offline-catalogue', wrap(async (req, res) => {
  const rows = await sql.prepare(`SELECT b.*, COUNT(i.id) copies,
    SUM(CASE WHEN i.status='available' THEN 1 ELSE 0 END) available
    FROM biblio b LEFT JOIN items i ON i.biblio_id=b.id
    GROUP BY b.id ORDER BY LOWER(b.title), b.id`).all();
  const copies = await sql.prepare('SELECT biblio_id, location, shelf_number, status FROM items ORDER BY biblio_id, id').all();
  const copiesByBook = new Map();
  for (const copy of copies) {
    if (!copiesByBook.has(copy.biblio_id)) copiesByBook.set(copy.biblio_id, []);
    copiesByBook.get(copy.biblio_id).push({
      location: copy.location, shelfNumber: copy.shelf_number, status: copy.status,
    });
  }
  res.json({
    generatedAt: new Date().toISOString(),
    results: rows.map((b) => ({
      ...shape(b, { [b.id]: { copies: Number(b.copies), available: Number(b.available) } }),
      description: b.description,
      searchAliases: b.search_aliases ? b.search_aliases.split('|') : [],
      items: copiesByBook.get(b.id) || [],
    })),
  });
}));

r.get('/new', wrap(async (req, res) => {
  const rows = await sql.prepare(`SELECT * FROM biblio ORDER BY id DESC LIMIT 8`).all();
  const av = await circ.availabilityMap(rows.map((b) => b.id));
  res.json({ results: rows.map((b) => shape(b, av)) });
}));

r.get('/biblio/:id', wrap(async (req, res) => {
  const id = int(req.params.id, { min: 1, name: 'id' });
  const b = await sql.prepare(`SELECT * FROM biblio WHERE id=?`).get(id);
  if (!b) throw new HttpError(404, 'Record not found');
  const av = await circ.availabilityMap([id]);
  const items = await sql.prepare(`SELECT i.id, i.barcode, i.location, i.shelf_number, i.status,
    (SELECT due_at FROM loans WHERE item_id=i.id AND returned_at IS NULL) dueAt FROM items i WHERE biblio_id=? ORDER BY i.id`).all(id);
  const holds = (await circ.pendingHolds(id)).length;
  const out = {
    ...shape(b, av), description: b.description,
    items: items.map((i) => ({
      id: i.id, location: i.location, shelfNumber: i.shelf_number, status: i.status, dueAt: i.dueAt,
      barcode: req.user && req.user.role !== 'student' ? i.barcode : undefined,
    })),
    holds,
  };
  if (req.user && req.user.role === 'student') {
    const { nosql } = require('../db');
    out.myHold = await nosql.holds.findOneAsync({ patronId: req.user._id, biblioId: id, status: { $in: ['pending', 'waiting'] } });
    const shelf = await nosql.shelves.findOneAsync({ _id: req.user._id });
    out.saved = !!(shelf && shelf.biblioIds.includes(id));
  }
  res.json(out);
}));

module.exports = r;
