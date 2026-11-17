// Load generation. Latency is wall-clock time around the app-level call, measured on the client.
import { makeOps, picker, rng, openDb, MIX } from './workload.mjs';

/** One client, one op at a time: per-query latency without concurrency effects. */
export async function serial(db, op, n, seed, warmup = 5) {
    const r = rng(seed), ms = [];
    let errors = 0;
    for (let i = 0; i < warmup + n; i++) {
        const t0 = performance.now();
        try { await op.run(db, r); } catch { errors++; }
        if (i >= warmup) ms.push(Math.round((performance.now() - t0) * 1000) / 1000);
    }
    return { ms, errors };
}

/** Closed loop: `instances` app processes (pool of 4 each), 4 workers per instance, for `seconds`. */
export async function closedLoop({ dbName, scale, instances = 2, seconds, seed = 1, mix = MIX, ops = makeOps(scale) }) {
    const dbs = Array.from({ length: instances }, () => openDb(dbName));
    const records = [], t0 = performance.now(), end = t0 + seconds * 1000;
    await Promise.all(dbs.flatMap((db, i) => Array.from({ length: 4 }, async (_, w) => {
        const r = rng(seed * 1000 + i * 10 + w), pick = picker(mix, r);
        while (performance.now() < end) {
            const name = pick(), s = performance.now();
            let ok = true, code;
            try { await ops[name].run(db, r); } catch (e) { ok = false; code = e.code || e.message; }
            records.push({ op: name, t: Math.round(s - t0), ms: Math.round((performance.now() - s) * 1000) / 1000, ok, ...(ok ? {} : { code }) });
        }
    })));
    const elapsed = (performance.now() - t0) / 1000;
    await Promise.all(dbs.map(db => db.terminate()));
    return { records, elapsed, throughput: records.filter(x => x.ok).length / elapsed };
}

/**
 * Open loop: requests are scheduled at a fixed rate whether or not earlier ones finished, the way
 * real visitors arrive. Latency counts from the scheduled time, so time spent queued behind a
 * lock (or waiting for one of the pool's 4 connections) is included instead of hidden.
 */
export function openLoop({ dbName, scale, rate, seed = 1, mix = MIX, ops = makeOps(scale) }) {
    const db = openDb(dbName), r = rng(seed), pick = picker(mix, r);
    const records = [], t0 = performance.now(), pending = new Set();
    let n = 0, stopped = false;
    const timer = setInterval(() => {
        const due = Math.floor((performance.now() - t0) / 1000 * rate);
        while (n < due && !stopped) {
            const name = pick(), scheduled = t0 + (n++ / rate) * 1000;
            const p = (async () => {
                let ok = true, code;
                try { await ops[name].run(db, r); } catch (e) { ok = false; code = e.code || e.message; }
                records.push({ op: name, kind: ops[name].kind, t: Math.round(scheduled - t0), ms: Math.round((performance.now() - scheduled) * 100) / 100, ok, ...(ok ? {} : { code }) });
            })();
            pending.add(p); p.finally(() => pending.delete(p));
        }
    }, 5);
    return {
        now: () => performance.now() - t0,
        async stop() { stopped = true; clearInterval(timer); await Promise.all([...pending]); await db.terminate(); return records.sort((a, b) => a.t - b.t); },
    };
}
