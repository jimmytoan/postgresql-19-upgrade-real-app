// Experiment stages. Each returns plain data that run.mjs writes under results/<run>/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ROOT, NET, DB_NAME, PASSWORD, LIMITS, SERVERS, docker, startServer, stopServer, psql, client, sleep, log, stats, median,
    volumeReset, volumeClone, stallWatch, serverInfo, explicitSettings, fingerprint, sizes, hostState,
} from './util.mjs';
import { makeOps, openDb, captureSql, rng, MIX } from './workload.mjs';
import { serial, closedLoop, openLoop } from './loadgen.mjs';

export const VOL = { v18: 'pg19lab-v18', v19u: 'pg19lab-v19u', v19r: 'pg19lab-v19r', work: 'pg19lab-work', dump: 'pg19lab-dump',
    c18lz4: 'pg19lab-c18lz4', c19lz4: 'pg19lab-c19lz4', c19pglz: 'pg19lab-c19pglz' };
const sql = name => readFileSync(join(ROOT, 'lab/sql', name), 'utf8');
const compression = db => psql(`select coalesce(pg_column_compression(data), 'inline/uncompressed'), count(*) from blog_documents group by 1 order by 1`, { db });

// ---------------------------------------------------------------- seed
export function seed(scale, volume = VOL.v18, server = 'pg18') {
    volumeReset(volume);
    const start = startServer({ server, volume });
    psql('create database blog_seed');
    psql(sql('schema.sql'), { db: 'blog_seed' });
    const t0 = performance.now();
    psql(sql('seed.sql'), { db: 'blog_seed', vars: scale });
    const out = { server: SERVERS[server].label, info: serverInfo(), initAndStartMs: start.readyMs, seedMs: performance.now() - t0, scale,
        sizes: sizes('blog_seed'), fingerprint: fingerprint('blog_seed'), compression: compression('blog_seed') };
    psql('checkpoint');
    out.stopMs = stopServer().stopMs;
    return out;
}

// ---------------------------------------------------------------- upgrade
function parseSteps(text) {
    const steps = {}, extra = {};
    for (const line of text.split('\n')) {
        let m;
        if ((m = /^STEP (\S+) (\d+) (\d+)$/.exec(line))) steps[m[1]] = { ms: Number(m[2]), exit: Number(m[3]) };
        if ((m = /^SIZE (\S+) (\d+)$/.exec(line))) extra[m[1]] = Number(m[2]);
    }
    return { steps, ...extra };
}
/** Start 19 on an upgraded/restored volume and verify it: data identical, app queries run. */
async function verifyNew(scale, expectedFingerprint) {
    const out = {};
    out.statsRowsBeforeAnalyze = Number(psql(`select count(*) from pg_stats where tablename = 'blog_documents'`, { db: 'blog_seed' }));
    const a = docker(['exec', DB_NAME, 'vacuumdb', '-U', 'postgres', '--all', '--analyze-in-stages', '--missing-stats-only'], { allowFail: true });
    out.analyzeMissingStats = { ms: a.ms, exit: a.status, stderr: a.err.split('\n').filter(l => /error|warning/i.test(l)).slice(0, 10) };
    out.fingerprintMatches = fingerprint('blog_seed') === expectedFingerprint;
    out.sizes = sizes('blog_seed'); out.compression = compression('blog_seed'); out.info = serverInfo();
    psql('create database smoke template blog_seed');
    const db = openDb('smoke'), ops = makeOps(scale), r = rng(7); out.appSmoke = {};
    for (const [name, op] of Object.entries(ops)) { try { await op.run(db, r); out.appSmoke[name] = 'ok'; } catch (e) { out.appSmoke[name] = 'ERROR ' + (e.code || '') + ' ' + e.message; } }
    await db.terminate();
    psql('drop database smoke with (force)');
    out.serverLogProblems = docker(['logs', DB_NAME], { allowFail: true }).err.split('\n').filter(l => /ERROR|FATAL|PANIC|WARNING/.test(l)).slice(0, 20);
    return out;
}
export async function pgUpgrade({ mode, scale, expectedFingerprint, keepAs }) {
    const host = hostState(); const wall0 = Date.now(), mono0 = performance.now();
    const clone = volumeClone(VOL.v18, VOL.work);
    const r = docker(['run', '--rm', '--cpus', LIMITS.cpus, '--memory', LIMITS.memory, '--shm-size', LIMITS.shm, '--user', 'postgres',
        '-v', `${VOL.work}:/var/lib/postgresql`, SERVERS.pg19lab.image, 'lab-upgrade.sh', mode, '2'], { allowFail: true });
    const out = { method: 'pg_upgrade --' + mode, from: SERVERS.pg18.label, to: SERVERS.pg19.label, host, cloneMs: clone.ms, containerMs: r.ms, exit: r.status, ...parseSteps(r.out), log: r.out.slice(-6000) + r.err.slice(-2000) };
    if (r.status !== 0) return { ...out, failed: true };
    out.firstStartMs = startServer({ server: 'pg19', volume: VOL.work }).readyMs;
    Object.assign(out, await verifyNew(scale, expectedFingerprint));
    out.stopMs = stopServer().stopMs;
    // Service is unavailable from stopping 18 until 19 accepts connections.
    out.wallSkewMs = Math.round((Date.now() - wall0) - (performance.now() - mono0)); out.suspect = Math.abs(out.wallSkewMs) > 500;
    out.downtimeMs = out.steps.check.ms + out.steps.upgrade.ms + out.steps.carry_pg_hba.ms + out.firstStartMs;
    if (keepAs) volumeClone(VOL.work, keepAs);
    return out;
}
function toolRun(script) { // pg client tools from the 19 image, on the lab network, same CPU limit
    return docker(['run', '--rm', '--network', NET, '--cpus', LIMITS.cpus, '--memory', LIMITS.memory, '-e', `PGPASSWORD=${PASSWORD}`, '-e', `PGHOST=${DB_NAME}`, '-e', 'PGUSER=postgres',
        '-v', `${VOL.dump}:/dump`, SERVERS.pg19.image, 'bash', '-c', `step() { local n=$1; shift; local s e rc; s=$(date +%s%N); "$@" > "/tmp/step.$n.log" 2>&1; rc=$?; e=$(date +%s%N); echo "STEP $n $(( (e - s) / 1000000 )) $rc"; grep -iE "error|warning" "/tmp/step.$n.log" | head -5 | sed "s/^/NOTE $n: /"; return 0; }\n${script}`], { allowFail: true });
}
export async function dumpRestore({ scale, expectedFingerprint, keepAs }) {
    const host = hostState(); const wall0 = Date.now(), mono0 = performance.now();
    volumeClone(VOL.v18, VOL.work); volumeReset(VOL.dump);
    startServer({ server: 'pg18', volume: VOL.work });
    const d = toolRun(`step dump_globals pg_dumpall --globals-only -f /dump/globals.sql
step dump_db pg_dump -d blog_seed -Fd -j 2 -f /dump/blog_seed
echo "SIZE dump_mb $(du -sm /dump | cut -f1)"`);
    stopServer(); volumeReset(VOL.work);
    const out = { method: 'pg_dump -Fd -j 2 (19 client) + pg_restore -j 2', from: SERVERS.pg18.label, to: SERVERS.pg19.label, host, ...parseSteps(d.out), notes: [] };
    out.notes.push(...d.out.split('\n').filter(l => l.startsWith('NOTE')));
    out.initdbAndFirstStartMs = startServer({ server: 'pg19', volume: VOL.work }).readyMs;
    const r = toolRun(`step restore_globals psql -d postgres -f /dump/globals.sql
step createdb createdb blog_seed
step restore_db pg_restore -d blog_seed -j 2 /dump/blog_seed
step analyze vacuumdb --all --analyze`);
    Object.assign(out.steps, parseSteps(r.out).steps);
    out.notes.push(...r.out.split('\n').filter(l => l.startsWith('NOTE')));
    out.exit = Math.max(d.status, r.status, ...Object.values(out.steps).map(s => s.exit));
    Object.assign(out, await verifyNew(scale, expectedFingerprint));
    out.stopMs = stopServer().stopMs;
    // Writes must stop before the dump starts; service returns when the restore and ANALYZE finish.
    const s = out.steps;
    out.wallSkewMs = Math.round((Date.now() - wall0) - (performance.now() - mono0)); out.suspect = Math.abs(out.wallSkewMs) > 500;
    out.downtimeMs = s.dump_globals.ms + s.dump_db.ms + out.initdbAndFirstStartMs + s.restore_globals.ms + s.createdb.ms + s.restore_db.ms + s.analyze.ms;
    if (keepAs) volumeClone(VOL.work, keepAs);
    return out;
}

// ---------------------------------------------------------------- benchmark
export const VARIANTS = {
    'pg18': { server: 'pg18', volume: VOL.v18, settings: {}, note: '18.7 defaults (jit=on)' },
    'pg18-jit-off': { server: 'pg18', volume: VOL.v18, settings: { jit: 'off' }, note: '18.7 with jit=off' },
    'pg19-upgraded': { server: 'pg19', volume: VOL.v19u, settings: {}, note: '19 RC 2 defaults (jit=off) on the pg_upgrade result' },
    'pg19-upgraded-jit-on': { server: 'pg19', volume: VOL.v19u, settings: { jit: 'on' }, note: '19 RC 2 with jit=on' },
    'pg19-restored': { server: 'pg19', volume: VOL.v19r, settings: {}, note: '19 RC 2 defaults on the dump/restore result (lz4 TOAST)' },
    // Controls: the same in-place rewrite + VACUUM FULL on each, differing only in TOAST compression.
    'pg19-rewritten-pglz': { server: 'pg19', volume: VOL.c19pglz, settings: {}, control: true, note: '19 RC 2, pg_upgrade result, large values rewritten with pglz, table rebuilt' },
    'pg19-rewritten-lz4': { server: 'pg19', volume: VOL.c19lz4, settings: {}, control: true, note: '19 RC 2, pg_upgrade result, large values rewritten with lz4, table rebuilt' },
    'pg18-rewritten-lz4': { server: 'pg18', volume: VOL.c18lz4, settings: {}, control: true, note: '18.7, large values rewritten with lz4, table rebuilt' },
};
const CONTROLS = [
    { key: 'pg19-rewritten-pglz', from: VOL.v19u, method: 'pglz' },
    { key: 'pg19-rewritten-lz4', from: VOL.v19u, method: 'lz4' },
    { key: 'pg18-rewritten-lz4', from: VOL.v18, method: 'lz4' },
];
/** Build the control clusters. Logical data stays identical; only storage of large values changes. */
export function buildControls(expectedFingerprint) {
    return CONTROLS.map(c => {
        const v = VARIANTS[c.key];
        volumeClone(c.from, v.volume); startServer(v);
        const t0 = performance.now();
        psql(`SET default_toast_compression = ${c.method};
            UPDATE blog_documents SET data = (data::text)::jsonb WHERE pg_column_compression(data) IS NOT NULL;
            VACUUM (FULL, ANALYZE) blog_documents; CHECKPOINT;`, { db: 'blog_seed' });
        const out = { variant: c.key, note: v.note, rewriteMs: performance.now() - t0, compression: compression('blog_seed'), sizes: sizes('blog_seed'),
            fingerprintMatches: fingerprint('blog_seed') === expectedFingerprint };
        stopServer();
        log(`  ${c.key}: ${out.compression.replace(/\n/g, ', ')}, table ${(out.sizes.totalBytes / 2 ** 20).toFixed(0)} MB, data identical: ${out.fingerprintMatches}`);
        return out;
    });
}
// Not issued by the app: a reporting-style aggregate, included only to show where JIT matters.
export const ANALYTICAL_SQL = `SELECT data->>'type' AS type, count(*) AS events, avg((data->>'durationMs')::numeric) AS avg_ms,
  count(DISTINCT data->>'sessionId') AS sessions, max((data#>>'{createdAt,seconds}')::bigint) AS last_seen
  FROM blog_documents WHERE namespace = 'blog' AND collection_path = 'analytics-events' GROUP BY 1 ORDER BY 2 DESC`;

async function explain(c, text, args) {
    const plan = (await c.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + text, args)).rows[0]['QUERY PLAN'][0];
    const nodes = []; (function walk(n) { nodes.push(n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')); (n.Plans || []).forEach(walk); })(plan.Plan);
    return { totalCost: plan.Plan['Total Cost'], jitUsed: Boolean(plan.JIT), jitMs: plan.JIT?.Timing?.Total ?? 0, executionMs: plan['Execution Time'], nodes };
}
export async function benchVariant(key, { scale, serialN, mixedSeconds, round, withPlans }) {
    const v = VARIANTS[key];
    startServer(v);
    psql('create database bench template blog_seed');
    const out = { variant: key, note: v.note, round, host: hostState(), info: serverInfo(), explicitSettings: explicitSettings(), serial: {}, raw: {} };
    const db = openDb('bench'), ops = makeOps(scale), c = await client('bench');
    const watchdog = stallWatch();
    for (const op of Object.values(ops)) await serial(db, op, op.heavy ? 3 : 10, 99, 0); // warm caches
    await c.query(ANALYTICAL_SQL);
    for (const [name, op] of Object.entries(ops)) {
        const r = await serial(db, op, op.heavy ? Math.ceil(serialN / 4) : serialN, 1000 + round);
        out.serial[name] = { ...stats(r.ms), errors: r.errors }; out.raw[name] = r.ms;
    }
    const an = [];
    for (let i = 0; i < Math.max(5, Math.ceil(serialN / 20)); i++) { const t0 = performance.now(); await c.query(ANALYTICAL_SQL); an.push(Math.round((performance.now() - t0) * 100) / 100); }
    out.analytical = stats(an); out.raw.analytical = an;
    if (withPlans) {
        out.plans = { analytical: await explain(c, ANALYTICAL_SQL, []) };
        for (const [name, op] of Object.entries(ops)) if (op.kind === 'read') {
            const seen = await captureSql(db, op, rng(5));
            out.plans[name] = await explain(c, seen[0].sql, seen[0].args); out.plans[name].sql = seen[0].sql.replace(/\s+/g, ' ');
        }
    }
    await db.terminate(); await c.end();
    const m = await closedLoop({ dbName: 'bench', scale, seconds: mixedSeconds, seed: 10 + round });
    const byOp = {};
    for (const rec of m.records) (byOp[rec.op] ||= []).push(rec.ms);
    out.mixed = { clients: 8, seconds: Math.round(m.elapsed * 10) / 10, throughput: Math.round(m.throughput * 10) / 10, errors: m.records.filter(x => !x.ok).length,
        errorCodes: [...new Set(m.records.filter(x => !x.ok).map(x => x.code))], all: stats(m.records.map(x => x.ms)), byOp: Object.fromEntries(Object.entries(byOp).map(([k, a]) => [k, stats(a)])) };
    out.stall = watchdog.stop();
    psql('drop database bench with (force)');
    stopServer();
    return out;
}

// ---------------------------------------------------------------- maintenance under load
const BLOAT_SQL = `BEGIN;
UPDATE blog_documents SET data = data || '{"processed": true}', version = version + 1 WHERE collection_path = 'analytics-events';
DELETE FROM blog_documents WHERE collection_path = 'analytics-events' AND right(id, 1) IN ('0', '2', '4', '6', '8');
UPDATE blog_documents SET data = data || jsonb_build_object('rev', version), version = version + 1 WHERE collection_path IN ('blog-posts', 'content-embeddings', 'ai-conversations');
UPDATE blog_documents SET data = jsonb_set(data, '{analytics,views}', to_jsonb((data #>> '{analytics,views}')::int + 1)) WHERE collection_path = 'blog-posts';
COMMIT;
VACUUM blog_documents;
CHECKPOINT;`;
export function ensureBloat() {
    if (psql(`select 1 from pg_database where datname = 'bloat_tpl'`) === '1') return { reused: true, sizes: sizes('bloat_tpl') };
    psql('create database bloat_tpl template blog_seed');
    const before = sizes('bloat_tpl'); const t0 = performance.now();
    psql(BLOAT_SQL, { db: 'bloat_tpl' });
    return { reused: false, bloatMs: performance.now() - t0, cleanSizes: before, sizes: sizes('bloat_tpl') };
}
function windowStats(records, from, to, mode = 'overlap') {
    // A request belongs to a window if any part of it (scheduled time .. completion) falls inside,
    // except the baseline, which only counts requests that finished before the command started.
    const w = records.filter(x => mode === 'before' ? x.t >= from && x.t + x.ms < to : mode === 'after' ? x.t >= from && x.t < to : x.t < to && x.t + x.ms >= from), part = kind => w.filter(x => x.kind === kind);
    const one = a => ({ ...stats(a.map(x => x.ms)), errors: a.filter(x => !x.ok).length, over1s: a.filter(x => x.ms > 1000).length });
    return { all: one(w), read: one(part('read')), write: one(part('write')), errorCodes: [...new Set(w.filter(x => !x.ok).map(x => String(x.code)))] };
}
/**
 * Run `command` on database `dbName` while the app workload arrives at a fixed rate.
 * Returns command duration, client latency before/during/after, and what a 100 ms lock sampler saw.
 */
export async function underLoad({ dbName, scale, command, rate, baselineMs = 8000, afterMs = 8000, seed = 3, mix = MIX }) {
    const maint = await client(dbName), watch = await client(dbName);
    const pid = (await maint.query('select pg_backend_pid() p')).rows[0].p;
    const lsn0 = (await watch.query('select pg_current_wal_insert_lsn() l')).rows[0].l;
    const samples = []; let busy = false;
    const watchdog = stallWatch();
    const load = openLoop({ dbName, scale, rate, seed, mix });
    const timer = setInterval(async () => {
        if (busy) return; busy = true;
        try {
            const r = (await watch.query(`select (select count(*)::int from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock') waiting,
                (select array_agg(distinct mode) from pg_locks l join pg_class c on c.oid = l.relation where l.pid = $1 and l.granted and c.relname = 'blog_documents') modes,
                pg_database_size(current_database()) db_bytes`, [pid])).rows[0];
            samples.push({ t: Math.round(load.now()), waiting: r.waiting, modes: r.modes || [], dbBytes: Number(r.db_bytes) });
        } catch { /* sampler must never break the run */ } finally { busy = false; }
    }, 100);
    await sleep(baselineMs);
    const start = load.now(); let error = null;
    if (command) { try { await maint.query(command); } catch (e) { error = `${e.code || ''} ${e.message}`; } } else await sleep(5000);
    const end = load.now();
    await sleep(afterMs);
    clearInterval(timer);
    const records = await load.stop();
    const stall = watchdog.stop();
    const walBytes = Number((await watch.query('select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1) b', [lsn0])).rows[0].b);
    await maint.end(); await watch.end();
    const during = samples.filter(s => s.t >= start && s.t <= end);
    const span = pred => { // total time covered by samples matching pred, using gaps between samples
        let ms = 0; for (let i = 1; i < samples.length; i++) if (pred(samples[i]) && samples[i].t >= start - 150 && samples[i].t <= end + 150) ms += samples[i].t - samples[i - 1].t; return ms;
    };
    return {
        command: command || '(no maintenance, control)', error, stall, peakDatabaseBytes: Math.max(0, ...samples.map(x => x.dbBytes)), startDatabaseBytes: samples[0]?.dbBytes ?? 0, durationMs: Math.round(end - start), rate, walBytes,
        baseline: windowStats(records, 1000, start, 'before'), during: windowStats(records, start, end), after: windowStats(records, end, end + afterMs, 'after'),
        locks: { samplesDuring: during.length, maxWaitingSessions: Math.max(0, ...during.map(s => s.waiting)), msWithWaiters: span(s => s.waiting > 0),
            msAccessExclusiveHeld: span(s => s.modes.includes('AccessExclusiveLock')), modesSeen: [...new Set(during.flatMap(s => s.modes))].sort() },
        records, samples,
    };
}
const WRITE_HEAVY = { postBySlug: 30, listRecent: 20, viewIncrement: 30, trackEvent: 20 };
export const MAINT_CASES = [
    { key: 'pg18 VACUUM FULL', variant: 'pg18', command: 'VACUUM (FULL) blog_documents' },
    { key: 'pg18 control', variant: 'pg18', command: null },
    { key: 'pg19 VACUUM FULL', variant: 'pg19-upgraded', command: 'VACUUM (FULL) blog_documents' },
    { key: 'pg19 REPACK', variant: 'pg19-upgraded', command: 'REPACK blog_documents' },
    { key: 'pg19 REPACK (CONCURRENTLY)', variant: 'pg19-upgraded', command: 'REPACK (CONCURRENTLY) blog_documents' },
    { key: 'pg19 control', variant: 'pg19-upgraded', command: null },
    // Same command with twice the arrival rate and half of all requests writing to the table being repacked.
    { key: 'pg19 REPACK (CONCURRENTLY), write-heavy', variant: 'pg19-upgraded', command: 'REPACK (CONCURRENTLY) blog_documents', rateFactor: 2, mix: WRITE_HEAVY, fullOnly: true },
    { key: 'pg19 control, write-heavy', variant: 'pg19-upgraded', command: null, rateFactor: 2, mix: WRITE_HEAVY, fullOnly: true },
];
export async function maintenance({ scale, rate, repeats, extended = false }) {
    const results = [], raw = [];
    for (const variant of ['pg18', 'pg19-upgraded']) {
        startServer(VARIANTS[variant]);
        const bloat = ensureBloat(); const info = serverInfo();
        for (let rep = 0; rep < repeats; rep++) for (const c of MAINT_CASES.filter(x => x.variant === variant && (extended || !x.fullOnly))) {
            psql('create database rp template bloat_tpl'); psql('checkpoint');
            const before = sizes('rp'), host = hostState();
            let r, discarded = 0;
            for (;;) {
                r = await underLoad({ dbName: 'rp', scale, command: c.command, rate: rate * (c.rateFactor || 1), mix: c.mix || MIX, seed: 3 + rep });
                if (!r.stall.suspect || discarded >= 3) break;
                discarded++; log(`  ${c.key} #${rep}: host stalled (${JSON.stringify(r.stall)}), discarding and repeating`);
                psql('drop database rp with (force)'); psql('create database rp template bloat_tpl'); psql('checkpoint');
            }
            const after = sizes('rp');
            const { records, samples, ...summary } = r;
            results.push({ case: c.key, repeat: rep, server: info.version, host, discardedAttempts: discarded, bloatTemplate: bloat, ...summary, sizeBefore: before, sizeAfter: after });
            raw.push({ case: c.key, repeat: rep, records, samples });
            log(`  ${c.key} #${rep}: ${r.durationMs} ms, ${(before.totalBytes / 2 ** 20).toFixed(0)} -> ${(after.totalBytes / 2 ** 20).toFixed(0)} MB, during p99 ${r.during.all.p99} ms, max ${r.during.all.max} ms, errors ${r.during.all.errors}${r.error ? ', COMMAND ERROR ' + r.error : ''}`);
            psql('drop database rp with (force)');
        }
        stopServer();
    }
    return { results, raw };
}

// ---------------------------------------------------------------- new features
const INSERT_HEAD = 'INSERT INTO blog_documents(namespace,path,collection_path,id,data) VALUES($1,$2,$3,$4,$5::jsonb)';
export async function features({ scale, n }) {
    const out = { releaseStatus: SERVERS.pg19.label };
    // 1. PostgreSQL 18 must reject the new syntax; that proves the feature is really new.
    startServer(VARIANTS.pg18);
    psql('create database feat template blog_seed');
    let c = await client('feat');
    const doSelect = INSERT_HEAD + ' ON CONFLICT(namespace,path) DO SELECT RETURNING data, version';
    const args = id => ['blog', 'newsletter-subscribers/' + id, 'newsletter-subscribers', id, JSON.stringify({ email: id + '@example.test', status: 'active' })];
    try { await c.query(doSelect, args('x1')); out.pg18 = 'UNEXPECTED: accepted'; } catch (e) { out.pg18 = `rejected: ${e.code} ${e.message}`; }
    await c.end(); psql('drop database feat with (force)'); stopServer();

    startServer(VARIANTS['pg19-upgraded']);
    psql('create database feat template blog_seed');
    c = await client('feat');
    const existing = i => 's' + String(1 + (i * 7919) % scale.subs).padStart(8, '0');
    // correctness: existing row comes back untouched, new row is inserted
    const hit = await c.query(doSelect, args(existing(1))), miss = await c.query(doSelect, args('brand-new'));
    out.correctness = { existingReturned: hit.rows.length === 1 && hit.rows[0].data.email.startsWith('user') && Number(hit.rows[0].version) === 1,
        newInserted: miss.rows.length === 1 && miss.rows[0].data.email === 'brand-new@example.test' };
    const db = openDb('feat');
    const approaches = {
        'app today: SERIALIZABLE txn, SELECT then INSERT (5 round trips)': async id => db.runTransaction(async tx => { const ref = db.doc('newsletter-subscribers/' + id); const s = await tx.get(ref); if (!s.exists) tx.create(ref, { email: id + '@example.test', status: 'active' }); }),
        'classic: SELECT, then INSERT ON CONFLICT DO NOTHING': async id => {
            const a = args(id); let r = await c.query('SELECT data FROM blog_documents WHERE namespace=$1 AND path=$2', a.slice(0, 2));
            if (!r.rows.length) { r = await c.query(INSERT_HEAD + ' ON CONFLICT(namespace,path) DO NOTHING RETURNING data', a); if (!r.rows.length) await c.query('SELECT data FROM blog_documents WHERE namespace=$1 AND path=$2', a.slice(0, 2)); }
        },
        'hack: ON CONFLICT DO UPDATE SET data = existing (1 round trip, writes)': async id => c.query(INSERT_HEAD + ' ON CONFLICT(namespace,path) DO UPDATE SET data = blog_documents.data RETURNING data', args(id)),
        '19: ON CONFLICT DO SELECT (1 round trip, no write on hit)': async id => c.query(doSelect, args(id)),
    };
    out.getOrCreate = { n, hitRatio: 0.8, approaches: {} }; out.raw = {};
    let k = 0;
    for (const [name, fn] of Object.entries(approaches)) {
        k++; for (let i = 0; i < 20; i++) await fn(existing(i + 5));
        const lsn0 = (await c.query('select pg_current_wal_insert_lsn() l')).rows[0].l, ms = [];
        const dead0 = Number((await c.query(`select pg_stat_force_next_flush()`), await c.query(`select n_tup_upd from pg_stat_user_tables where relname = 'blog_documents'`)).rows[0].n_tup_upd); // force this session's counters out before reading them
        for (let i = 0; i < n; i++) {
            const id = i % 5 === 4 ? `new-${k}-${i}` : existing(i + 100);
            const t0 = performance.now(); await fn(id); ms.push(Math.round((performance.now() - t0) * 1000) / 1000);
        }
        const wal = Number((await c.query('select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1) b', [lsn0])).rows[0].b);
        const dead1 = Number((await c.query(`select pg_stat_force_next_flush()`), await c.query(`select n_tup_upd from pg_stat_user_tables where relname = 'blog_documents'`)).rows[0].n_tup_upd);
        out.getOrCreate.approaches[name] = { ...stats(ms), walBytesPerCall: Math.round(wal / n), rowUpdates: dead1 - dead0 };
        out.raw[name] = ms;
    }
    await db.terminate(); await c.end();
    out.info = serverInfo();
    out.extensions = psql(`select name || ' ' || default_version from pg_available_extensions where name ~ 'advice' order by 1`);
    psql('drop database feat with (force)'); stopServer();
    return out;
}
export { median, MIX };
