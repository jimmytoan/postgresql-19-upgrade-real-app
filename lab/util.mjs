// Shared helpers: process execution, Docker lifecycle, psql access, statistics, result files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import pg from 'pg';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NET = 'pg19lab-net';
export const DB_NAME = 'pg19lab-db';
export const PORT = 55519;
export const PASSWORD = 'lab'; // throwaway credential for local, loopback-only containers

export const SERVERS = {
    pg18: { image: 'postgres:18.7', major: 18, label: 'PostgreSQL 18.7' },
    pg19: { image: 'postgres:19rc2', major: 19, label: 'PostgreSQL 19 RC 2 (pre-release, not GA)' },
    // Same 19rc2 server binaries plus the 18.7 binaries that pg_upgrade needs. Used only for pg_upgrade.
    pg19lab: { image: 'pg19lab-19:rc2', major: 19, label: 'PostgreSQL 19 RC 2 (pre-release, not GA) + 18.7 binaries' },
};
export const LIMITS = { cpus: '2', memory: '2g', shm: '1g' };
// Identical explicit settings on both versions. Anything not listed keeps that version's
// own default, because changed defaults (jit, default_toast_compression, ...) are the subject.
export const BASE_SETTINGS = {
    shared_buffers: '512MB', effective_cache_size: '1GB', work_mem: '16MB', maintenance_work_mem: '256MB',
    max_wal_size: '4GB', checkpoint_timeout: '15min', random_page_cost: '1.1', max_connections: '60',
};

export function run(cmd, args, { input, allowFail = false, timeout = 3 * 3600e3 } = {}) {
    const t0 = performance.now();
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 1 << 29, timeout });
    const ms = performance.now() - t0;
    if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 12).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || String(r.error || '')).slice(-3000)}`);
    return { ms, out: r.stdout || '', err: r.stderr || '', status: r.status };
}
export const docker = (args, opts) => run('docker', args, opts);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function ensureNet() { docker(['network', 'create', NET], { allowFail: true }); }
export function removeContainer(name) { docker(['rm', '-f', name], { allowFail: true }); }
export function volumeReset(name) {
    if (!name.startsWith('pg19lab-')) throw new Error('refusing to touch a non-lab volume');
    removeContainer(DB_NAME); // a crashed earlier run may still hold the volume
    docker(['volume', 'rm', '-f', name]); docker(['volume', 'create', name]);
}
export function volumeExists(name) { return docker(['volume', 'inspect', name], { allowFail: true }).status === 0; }
export function volumeClone(from, to) {
    volumeReset(to);
    return docker(['run', '--rm', '-v', `${from}:/from:ro`, '-v', `${to}:/to`, 'postgres:18.7', 'bash', '-c', 'cp -a /from/. /to/ && sync']);
}

/** Start the single lab server. Only one runs at a time, so versions never compete for CPU. */
export function startServer({ server, volume, settings = {} }) {
    removeContainer(DB_NAME); ensureNet();
    const s = SERVERS[server];
    const args = ['run', '-d', '--name', DB_NAME, '--network', NET, '--cpus', LIMITS.cpus, '--memory', LIMITS.memory,
        '--shm-size', LIMITS.shm, '-p', `127.0.0.1:${PORT}:5432`, '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
        '-v', `${volume}:/var/lib/postgresql`, s.image, 'postgres'];
    for (const [k, v] of Object.entries({ ...BASE_SETTINGS, ...settings })) args.push('-c', `${k}=${v}`);
    const t0 = performance.now();
    docker(args);
    for (let i = 0; ; i++) {
        // TCP check: the image's temporary init server listens on the socket only.
        const r = docker(['exec', '-e', `PGPASSWORD=${PASSWORD}`, DB_NAME, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-AtXc', 'select 1'], { allowFail: true });
        if (r.status === 0) break;
        if (i > 600) throw new Error('server did not become ready: ' + docker(['logs', '--tail', '30', DB_NAME], { allowFail: true }).err);
        spawnSync('sleep', ['0.2']);
    }
    return { readyMs: performance.now() - t0 };
}
export function stopServer() {
    const r = docker(['stop', '-t', '120', DB_NAME], { allowFail: true });
    removeContainer(DB_NAME);
    return { stopMs: r.ms };
}
/** Run SQL through psql inside the server container (unix socket). Returns stdout. */
export function psql(sql, { db = 'postgres', vars = {}, allowFail = false } = {}) {
    const args = ['exec', '-i', DB_NAME, 'psql', '-U', 'postgres', '-d', db, '-AtX', '-v', 'ON_ERROR_STOP=1'];
    for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
    const r = docker(args, { input: sql, allowFail });
    return allowFail ? r : r.out.trim();
}
export const url = db => `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/${db}`;
export async function client(db) { const c = new pg.Client({ connectionString: url(db) }); await c.connect(); return c; }

export function serverInfo() {
    const names = ['server_version', 'jit', 'jit_above_cost', 'default_toast_compression', 'shared_buffers', 'work_mem', 'wal_level',
        'io_method', 'log_lock_waits', 'max_locks_per_transaction', 'data_checksums', 'max_repack_replication_slots'];
    const rows = psql(`select name || '=' || setting from pg_settings where name = any('{${names.join(',')}}') order by 1`);
    const info = Object.fromEntries(rows.split('\n').map(l => l.split('=')));
    info.version = psql('select version()'); // pg_jit_available() is false whenever jit=off, so ask with jit switched on for this session.
    info.jit_provider_installed = psql('set jit = on; select pg_jit_available()').split('\n').pop() === 't';
    return info;
}
/** Non-default settings and where they came from: proves both versions run the same explicit config. */
export function explicitSettings() {
    return psql(`select name || '=' || setting from pg_settings where source = 'command line' order by 1`).split('\n');
}
export const FINGERPRINT_SQL = `select collection_path, count(*), md5(string_agg(md5(path || data::text), '' order by path collate "C"))
  from blog_documents group by 1 order by 1`;
export function fingerprint(db) { return psql(FINGERPRINT_SQL, { db }); }
export function sizes(db) {
    const r = psql(`select pg_total_relation_size('blog_documents'), pg_relation_size('blog_documents'), pg_indexes_size('blog_documents'),
        coalesce(pg_total_relation_size(reltoastrelid), 0), pg_database_size(current_database())
        from pg_class where oid = 'blog_documents'::regclass`, { db }).split('|').map(Number);
    return { totalBytes: r[0], heapBytes: r[1], indexBytes: r[2], toastBytes: r[3], databaseBytes: r[4] };
}

export function stats(values) {
    const a = [...values].sort((x, y) => x - y), n = a.length;
    if (!n) return { n: 0 };
    const q = p => a[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
    const r = x => Math.round(x * 1000) / 1000;
    return { n, mean: r(a.reduce((s, x) => s + x, 0) / n), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), min: r(a[0]), max: r(a[n - 1]) };
}
export const median = values => stats(values).p50;

export function hostState() {
    const others = docker(['ps', '--format', '{{.Names}}'], { allowFail: true }).out.trim().split('\n').filter(n => n && !n.startsWith('pg19lab-'));
    return { at: new Date().toISOString(), loadavg: os.loadavg().map(x => Math.round(x * 100) / 100), otherContainers: others };
}
export function environment() {
    const d = docker(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}']).out.trim();
    const vm = docker(['info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes']).out.trim();
    const digest = image => docker(['image', 'inspect', image, '--format', '{{.Id}} {{join .RepoDigests ","}}'], { allowFail: true }).out.trim();
    return {
        date: new Date().toISOString(), host: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} cores (${os.cpus()[0].model}), ${Math.round(os.totalmem() / 2 ** 30)} GB`,
        docker: d, dockerVm: vm, node: process.version, pgDriver: pg.version || '8.23.1',
        images: Object.fromEntries(Object.entries(SERVERS).map(([k, s]) => [k, { image: s.image, label: s.label, id: digest(s.image) }])),
        limits: LIMITS, baseSettings: BASE_SETTINGS,
        releaseStatus: 'PostgreSQL 19 is NOT generally available (checked 2026-11-17: no postgres:19 or 19.0 image exists). Latest official pre-release is 19 RC 2 (2026-11-12). All "19" numbers are RC 2.',
    };
}
export function save(runDir, name, data) {
    mkdirSync(join(ROOT, 'results', runDir), { recursive: true });
    const file = join(ROOT, 'results', runDir, name);
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n');
    return file;
}
export function load(runDir, name) {
    const file = join(ROOT, 'results', runDir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
export const SCALES = {
    tiny: { posts: 200, events: 5000, subs: 2000, embeddings: 100, conversations: 100 },
    pilot: { posts: 2000, events: 200000, subs: 20000, embeddings: 2000, conversations: 2000 },
    full: { posts: 10000, events: 2000000, subs: 100000, embeddings: 10000, conversations: 10000 },
};

/**
 * Detects a suspended host (laptop sleep, App Nap) during a measurement. Two signals:
 * the event loop stops ticking, or the wall clock moves ahead of the monotonic clock.
 * A measurement with either signal is invalid and must be discarded.
 */
export function stallWatch() {
    const wall0 = Date.now(), mono0 = performance.now();
    let last = mono0, lastWall = wall0, maxGap = 0;
    const timer = setInterval(() => { const n = performance.now(), w = Date.now(); maxGap = Math.max(maxGap, n - last - 100, w - lastWall - 100); last = n; lastWall = w; }, 100);
    return { stop() { clearInterval(timer); const wallSkewMs = Math.round((Date.now() - wall0) - (performance.now() - mono0)); const maxLoopGapMs = Math.round(maxGap);
        return { maxLoopGapMs, wallSkewMs, suspect: maxLoopGapMs > 1000 || Math.abs(wallSkewMs) > 500 }; } };
}
