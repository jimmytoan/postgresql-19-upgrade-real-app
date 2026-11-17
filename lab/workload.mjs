// The workload calls the blog's real storage layer (vendor/blog-storage.mjs, bundled from
// blog/src/lib/storage/postgres.ts). Every statement PostgreSQL sees is produced by the app's
// own query builder, sent through the same node-postgres driver and the same 4-connection pool.
import { Database, FieldValue, Timestamp } from '../vendor/blog-storage.mjs';
import { url } from './util.mjs';

export function rng(seed) { // mulberry32: reproducible op and key sequences
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n, w) => String(n).padStart(w, '0');
const CATEGORIES = ['technology', 'ai', 'career', 'finance', 'learning', 'tools'];

export function openDb(dbName) { return new Database(url(dbName), 'blog'); }

/** name -> { kind, run(db, r) }. `r` is a seeded random function. */
export function makeOps(scale) {
    const int = (r, n) => 1 + Math.floor(r() * n);
    const postId = r => 'p' + pad(int(r, scale.posts), 7);
    const posts = db => db.collection('blog-posts');
    return {
        postBySlug: { kind: 'read', run: (db, r) => posts(db).where('slug', '==', 'post-' + int(r, scale.posts)).where('status', '==', 'published').limit(1).get() },
        docGet: { kind: 'read', run: (db, r) => db.doc('blog-posts/' + postId(r)).get() },
        listRecent: { kind: 'read', run: db => posts(db).where('status', '==', 'published').orderBy('publishDate', 'desc').limit(10).get() },
        listCategory: { kind: 'read', run: (db, r) => posts(db).where('category', '==', CATEGORIES[int(r, 6) - 1]).where('status', '==', 'published').orderBy('publishDate', 'desc').limit(10).get() },
        listTag: { kind: 'read', run: (db, r) => posts(db).where('tags', 'array-contains', 't' + (int(r, 40) - 1)).where('status', '==', 'published').orderBy('publishDate', 'desc').limit(10).get() },
        popular: { kind: 'read', heavy: true, run: db => posts(db).where('status', '==', 'published').orderBy('analytics.views', 'desc').limit(5).get() },
        search100: { kind: 'read', heavy: true, run: db => posts(db).where('status', '==', 'published').orderBy('publishDate', 'desc').limit(100).get() },
        adminList: { kind: 'read', run: db => posts(db).orderBy('createdAt', 'desc').limit(50).select('title', 'slug', 'status', 'category').get() },
        countPublished: { kind: 'read', heavy: true, run: db => posts(db).where('status', '==', 'published').count().get() },
        eventsForPosts: { kind: 'read', heavy: true, run: (db, r) => db.collection('analytics-events').where('postId', 'in', Array.from({ length: 10 }, () => postId(r))).get() },
        subscriberLookup: { kind: 'read', run: (db, r) => db.collection('newsletter-subscribers').whereNormalizedEmail(`User${int(r, scale.subs)}@Example.test `).limit(1).get() },
        viewIncrement: { kind: 'write', run: (db, r) => db.doc('blog-posts/' + postId(r)).update({ 'analytics.views': FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }) },
        trackEvent: { kind: 'write', run: (db, r) => db.collection('analytics-events').add({ type: 'pageview', postId: postId(r), sessionId: pad(int(r, 1e9), 10), path: '/technology/post-' + int(r, scale.posts), referrer: '', userAgent: 'lab-loadgen', durationMs: int(r, 180000), createdAt: Timestamp.now() }) },
        subscribe: { kind: 'write', run: async (db, r) => {
            const email = `new${int(r, 1e9)}@example.test`;
            const found = await db.collection('newsletter-subscribers').whereNormalizedEmail(email).limit(1).get();
            if (found.empty) await db.collection('newsletter-subscribers').add({ email, status: 'active', source: 'footer', tags: [], createdAt: Timestamp.now() });
        } },
    };
}
// Rough page-view mix for a content site: mostly reads, a write on each view, rare admin work.
export const MIX = { postBySlug: 30, docGet: 10, listRecent: 15, listCategory: 10, listTag: 5, popular: 5, search100: 2, adminList: 2,
    countPublished: 3, eventsForPosts: 3, subscriberLookup: 2, viewIncrement: 8, trackEvent: 4, subscribe: 1 };

export function picker(mix, r) {
    const entries = Object.entries(mix), total = entries.reduce((s, [, w]) => s + w, 0);
    return () => { let x = r() * total; for (const [name, w] of entries) { if ((x -= w) < 0) return name; } return entries[0][0]; };
}

/** Record the SQL and arguments the app issues for one call of a read op (for EXPLAIN). */
export async function captureSql(db, op, r) {
    const pool = db.pool, original = pool.query.bind(pool), seen = [];
    pool.query = (sql, args) => { seen.push({ sql, args }); return original(sql, args); };
    try { await op.run(db, r); } finally { pool.query = original; }
    return seen;
}
