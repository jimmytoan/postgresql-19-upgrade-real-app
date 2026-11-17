// Builds results/<run>/SUMMARY.md from the JSON files. Run alone: node lab/report.mjs pilot
import { load, save, median } from './util.mjs';

const mb = b => (b / 2 ** 20).toFixed(0);
const sec = ms => (ms / 1000).toFixed(2);
const range = a => a.length > 1 ? `${Math.min(...a)}–${Math.max(...a)}` : String(a[0]);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
const groupBy = (a, f) => a.reduce((m, x) => ((m[f(x)] ||= []).push(x), m), {});

export function report(dir) {
    const meta = load(dir, 'meta.json'), seed = load(dir, 'seed.json'), up = load(dir, 'upgrade.json'), bench = load(dir, 'bench.json'),
        maint = load(dir, 'maintenance.json'), feat = load(dir, 'features.json'), controls = load(dir, 'controls.json');
    const out = [`# ${dir} results`, '',
        `**${meta.environment.releaseStatus}**`, '',
        `- Compared: ${meta.environment.images.pg18.label} (\`${meta.environment.images.pg18.image}\`) and ${meta.environment.images.pg19.label} (\`${meta.environment.images.pg19.image}\`).`,
        `- Host: ${meta.environment.host}; Docker ${meta.environment.docker} (${meta.environment.dockerVm}). Server container limits: ${meta.environment.limits.cpus} CPUs, ${meta.environment.limits.memory} RAM.`,
        `- Same explicit settings on both: ${Object.entries(meta.environment.baseSettings).map(([k, v]) => `${k}=${v}`).join(', ')}. Everything else is each version's default.`,
        `- Scale: ${Object.entries(meta.scale).map(([k, v]) => `${v} ${k}`).join(', ')}.`, ''];
    const hosts = [...(up || []), ...(bench || []), ...(maint || [])].map(x => x.host).filter(Boolean);
    if (hosts.length) {
        const loads = hosts.map(h => h.loadavg[0]), others = [...new Set(hosts.flatMap(h => h.otherContainers))];
        out.push(`- Contention: host 1-minute load average was ${Math.min(...loads)}–${Math.max(...loads)} across measurements (10 cores); other containers running: ${others.join(', ') || 'none'}. Other labs shared this laptop, so small differences are noise.`, '');
    }
    const suspect = [...(up || []).filter(x => x.suspect).map(x => x.method), ...(bench || []).filter(x => x.stall?.suspect).map(x => x.variant), ...(maint || []).filter(x => x.stall?.suspect).map(x => x.case)];
    const discarded = (maint || []).reduce((n, x) => n + (x.discardedAttempts || 0), 0);
    out.push(`- Host stall check (laptop sleep or a frozen process): ${suspect.length ? 'SUSPECT RUNS, DO NOT QUOTE: ' + suspect.join(', ') : 'no measurement in these results was taken during a stall'}${discarded ? `; ${discarded} stalled attempts were discarded and repeated` : ''}. Runs recorded before the check existed carry no stall field.`, '');
    if (seed) out.push('## Dataset', '', `Seeded on 18.7 in ${sec(seed.seedMs)} s. Table \`blog_documents\` ${mb(seed.sizes.totalBytes)} MB total (heap ${mb(seed.sizes.heapBytes)} MB, TOAST ${mb(seed.sizes.toastBytes)} MB, indexes ${mb(seed.sizes.indexBytes)} MB).`, '');

    if (up) {
        out.push('## Upgrade 18.7 → 19 RC 2', '');
        const g = groupBy(up, x => x.method);
        out.push(table(['Method', 'Runs', 'Downtime s (median)', 'Range s', 'Main steps (median s)', 'Data identical', 'Stats present before ANALYZE', 'Table MB after', 'App smoke test'],
            Object.entries(g).map(([m, rs]) => {
                const ok = rs.filter(r => !r.failed);
                if (!ok.length) return [m, rs.length, 'FAILED', '', '', '', '', '', ''];
                const steps = Object.keys(ok[0].steps).map(s => `${s} ${sec(median(ok.map(r => r.steps[s].ms)))}`).join(', ');
                const start = ok[0].firstStartMs ? `, first start ${sec(median(ok.map(r => r.firstStartMs)))}` : `, initdb+start ${sec(median(ok.map(r => r.initdbAndFirstStartMs)))}`;
                const smoke = ok.every(r => Object.values(r.appSmoke).every(v => v === 'ok')) ? 'all ops ok' : 'ERRORS';
                return [m, `${ok.length}/${rs.length} ok`, sec(median(ok.map(r => r.downtimeMs))), range(ok.map(r => Number(sec(r.downtimeMs)))), steps + start,
                    ok.every(r => r.fingerprintMatches) ? 'yes' : 'NO', ok.every(r => r.statsRowsBeforeAnalyze > 0) ? 'yes' : 'no', mb(median(ok.map(r => r.sizes.totalBytes))), smoke];
            })), '');
        const first = m => up.find(r => r.method.includes(m) && !r.failed);
        const c = first('--copy'), d = first('pg_dump');
        if (c && d) out.push(`TOAST compression after pg_upgrade: \`${c.compression.replace(/\n/g, ', ')}\`; after dump/restore: \`${d.compression.replace(/\n/g, ', ')}\`.`, '');
        const notes = [...new Set(up.flatMap(r => [...(r.notes || []), ...(r.serverLogProblems || []), ...(r.analyzeMissingStats?.stderr || [])]))];
        out.push('Warnings and errors seen:', '', ...(notes.length ? notes.slice(0, 15).map(n => `- \`${n.replace(/^\S+ \S+ \S+ \[\d+\] /, '').slice(0, 220)}\``) : ['- none']), '');
    }
    if (controls) out.push('## Compression controls', '', 'Each control is a copy of a cluster whose large values were rewritten in place with one compression method, then `VACUUM FULL`. Same logical data.', '',
        table(['Control', 'Compression of stored values', 'Table MB', 'TOAST MB', 'Data identical'], controls.map(c => [c.variant, c.compression.replace(/\n/g, ', ').replace(/\|/g, ' '), mb(c.sizes.totalBytes), mb(c.sizes.toastBytes), c.fingerprintMatches ? 'yes' : 'NO'])), '');
    if (bench) {
        const v = groupBy(bench, x => x.variant), keys = Object.keys(v), ops = Object.keys(bench[0].serial);
        out.push('## Query latency, one client (p50 ms, median of rounds)', '', `Rounds per variant: ${v[keys[0]].length}. Ratio column is 19-upgraded / 18.`, '');
        const med = (k, f) => median(v[k].map(f));
        out.push(table(['Operation', ...keys, '19/18'], [...ops.map(o => [o, ...keys.map(k => med(k, r => r.serial[o].p50).toFixed(2)),
            v.pg18 && v['pg19-upgraded'] ? (med('pg19-upgraded', r => r.serial[o].p50) / med('pg18', r => r.serial[o].p50)).toFixed(2) : '']),
        ['*analytical (not an app query)*', ...keys.map(k => med(k, r => r.analytical.p50).toFixed(1)), v.pg18 && v['pg19-upgraded'] ? (med('pg19-upgraded', r => r.analytical.p50) / med('pg18', r => r.analytical.p50)).toFixed(2) : '']]), '');
        const errs = bench.reduce((s, r) => s + Object.values(r.serial).reduce((a, x) => a + x.errors, 0) + r.mixed.errors, 0);
        out.push('## Mixed workload, 8 clients (2 app instances × pool of 4)', '',
            table(['Variant', 'Throughput ops/s (median)', 'Per round', 'p50 ms', 'p95 ms', 'p99 ms', 'Errors'], keys.map(k => [k, med(k, r => r.mixed.throughput), v[k].map(r => r.mixed.throughput).join(', '),
                med(k, r => r.mixed.all.p50), med(k, r => r.mixed.all.p95), med(k, r => r.mixed.all.p99), v[k].reduce((s, r) => s + r.mixed.errors, 0)])), '', `Total errors across all benchmark runs: ${errs}.`, '');
        const p18 = v.pg18?.find(r => r.plans), p19 = v['pg19-upgraded-jit-on']?.find(r => r.plans);
        if (p18) out.push('## Planner cost and JIT (jit_above_cost = 100000)', '', table(['Query', 'Plan cost on 18', 'JIT fired on 18 (default on)', 'JIT fired on 19 with jit=on', 'JIT compile ms (18)'],
            Object.keys(p18.plans).map(o => [o, Math.round(p18.plans[o].totalCost), p18.plans[o].jitUsed ? 'yes' : 'no', p19 ? (p19.plans[o].jitUsed ? 'yes' : 'no') : '', p18.plans[o].jitMs ? p18.plans[o].jitMs.toFixed(1) : ''])), '');
    }
    if (maint) {
        const g = groupBy(maint, x => x.case), m = (rs, f) => median(rs.map(f));
        out.push('## Reclaiming a bloated table while the app is under load', '',
            `Open-loop load at ${maint[0].rate} requests/s (write-heavy cases: double) through one app instance (pool of 4, 30 s statement timeout). Bloat template: ${mb(maint[0].bloatTemplate.sizes.totalBytes)} MB on 18.`, '',
            table(['Case', 'Runs', 'Duration s', 'Table MB before → after', 'WAL MB', 'Baseline p99 ms', 'During p50 / p99 / max ms', 'Requests >1 s', 'Failed requests', 'Peak extra disk MB', 'ACCESS EXCLUSIVE held ms', 'Time with blocked sessions ms', 'Command error'],
                Object.entries(g).map(([k, rs]) => [k, rs.length, sec(m(rs, r => r.durationMs)), `${mb(m(rs, r => r.sizeBefore.totalBytes))} → ${mb(m(rs, r => r.sizeAfter.totalBytes))}`, mb(m(rs, r => r.walBytes)),
                    m(rs, r => r.baseline.all.p99), `${m(rs, r => r.during.all.p50)} / ${m(rs, r => r.during.all.p99)} / ${m(rs, r => r.during.all.max)}`, m(rs, r => r.during.all.over1s),
                    rs.reduce((s, r) => s + r.during.all.errors + r.after.all.errors, 0), rs[0].peakDatabaseBytes ? mb(m(rs, r => r.peakDatabaseBytes - r.startDatabaseBytes)) : '', m(rs, r => r.locks.msAccessExclusiveHeld), m(rs, r => r.locks.msWithWaiters), [...new Set(rs.map(r => r.error).filter(Boolean))].join('; ') || 'none'])), '');
        const codes = [...new Set(maint.flatMap(r => [...r.during.errorCodes, ...r.after.errorCodes]))];
        if (codes.length) out.push(`Request error codes seen: ${codes.join(', ')}.`, '');
    }
    if (feat) {
        out.push('## INSERT … ON CONFLICT DO SELECT (19 RC 2)', '', `- PostgreSQL 18.7: ${feat.pg18}`, `- 19 RC 2 correctness: existing row returned unchanged = ${feat.correctness.existingReturned}, new row inserted = ${feat.correctness.newInserted}`, '',
            `Get-or-create, ${feat.getOrCreate.n} calls, ${feat.getOrCreate.hitRatio * 100}% already exist, one client, on 19 RC 2:`, '',
            table(['Approach', 'p50 ms', 'p95 ms', 'WAL bytes per call', 'Row updates caused'], Object.entries(feat.getOrCreate.approaches).map(([k, a]) => [k, a.p50, a.p95, a.walBytesPerCall, a.rowUpdates])), '',
            `Advice extensions available in the image: ${feat.extensions.replace(/\n/g, ', ') || 'none'}.`, '');
    }
    return out.join('\n') + '\n';
}
if (process.argv[1]?.endsWith('report.mjs')) { const dir = process.argv[2] || 'pilot'; console.log(save(dir, 'SUMMARY.md', report(dir))); }
