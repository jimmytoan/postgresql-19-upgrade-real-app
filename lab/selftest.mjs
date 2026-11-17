// Self-test: proves the harness measures what it claims, using known injected effects.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SERVERS, SCALES, stallWatch, startServer, stopServer, psql, client, stats, serverInfo, explicitSettings, fingerprint, sizes, log } from './util.mjs';
import { seed, underLoad, ensureBloat, VOL } from './stages.mjs';
import { makeOps, openDb, captureSql, rng } from './workload.mjs';
import { serial } from './loadgen.mjs';

export async function selftest() {
    const scale = SCALES.tiny, checks = [], vol = 'pg19lab-selftest';
    const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), detail }); log(`  ${pass ? 'PASS' : 'FAIL'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
    const fingerprints = {}, explicit = {};
    for (const server of ['pg18', 'pg19']) {
        const s = seed(scale, vol, server); fingerprints[server] = s.fingerprint;
        startServer({ server, volume: vol });
        const info = serverInfo(); explicit[server] = explicitSettings().join(' ');
        const want = SERVERS[server].major === 18 ? '18.7' : '19rc2';
        check(`${server}: server version is ${want}`, info.server_version.startsWith(want), info.version);
        check(`${server}: version default for jit`, info.jit === (server === 'pg18' ? 'on' : 'off'), `jit=${info.jit}, JIT provider installed=${info.jit_provider_installed}`);

        // 1. latency: a 50 ms server-side sleep must be reported as ~50 ms
        const db = openDb('blog_seed');
        const sl = await serial(db, { run: d => d.pool.query('select pg_sleep(0.05)') }, 20, 1, 2), p50 = stats(sl.ms).p50;
        check(`${server}: 50 ms injected delay measured as 50-65 ms`, p50 >= 50 && p50 <= 65, `p50 ${p50} ms`);

        // 2. workload fidelity: real app queries return the right rows and use the app's indexes
        const ops = makeOps(scale), c = await client('blog_seed');
        const recent = await ops.listRecent.run(db), count = await ops.countPublished.run(db), bySlug = await db.collection('blog-posts').where('slug', '==', 'post-7').limit(1).get();
        const sub = await db.collection('newsletter-subscribers').whereNormalizedEmail(' USER5@example.TEST').get();
        const dates = recent.docs.map(d => d.data().publishDate.seconds);
        check(`${server}: app queries return correct rows`, recent.size === 10 && dates.every((x, i) => !i || x <= dates[i - 1]) && count.data().count === scale.posts * 0.9 && bySlug.docs[0]?.id === 'p0000007' && sub.size === 1,
            `listRecent ${recent.size} rows sorted desc, countPublished ${count.data().count}, slug post-7 -> ${bySlug.docs[0]?.id}, email lookup ${sub.size}`);
        const cap = (await captureSql(db, ops.listRecent, rng(1)))[0];
        const plan = JSON.stringify((await c.query('EXPLAIN (FORMAT JSON) ' + cap.sql, cap.args)).rows[0]['QUERY PLAN']);
        check(`${server}: listRecent uses the app's publishDate index`, plan.includes('blog_documents_published'), cap.sql.replace(/\s+/g, ' ').slice(0, 160));

        // 3. JIT detection: forced JIT must show up in EXPLAIN where the provider exists, and never when jit=off
        const jit = async on => { await c.query(`set jit = ${on}; set jit_above_cost = 0`); return Boolean((await c.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + cap.sql, cap.args)).rows[0]['QUERY PLAN'][0].JIT); };
        const jitOn = await jit('on'), jitOff = await jit('off');
        check(`${server}: JIT detection matches provider availability`, jitOn === info.jit_provider_installed && !jitOff, `forced on -> ${jitOn}, off -> ${jitOff}, provider installed ${info.jit_provider_installed}`);
        await c.end();

        // 4. fingerprint: a one-row change must change it, and reverting must restore it
        const f0 = fingerprint('blog_seed');
        psql(`update blog_documents set data = jsonb_set(data, '{status}', '"x"') where path = 'newsletter-subscribers/s00000003'`, { db: 'blog_seed' });
        const f1 = fingerprint('blog_seed');
        psql(`update blog_documents set data = jsonb_set(data, '{status}', '"active"') where path = 'newsletter-subscribers/s00000003'`, { db: 'blog_seed' });
        check(`${server}: data fingerprint detects a one-row change`, f0 !== f1 && fingerprint('blog_seed') === f0, 'changed then restored');
        await db.terminate();

        // 5. size: bloat must be visible, VACUUM FULL must return the table to about its clean size
        const b = ensureBloat(); psql('vacuum (full) blog_documents', { db: 'bloat_tpl' }); const packed = sizes('bloat_tpl');
        check(`${server}: bloat and its removal are visible in size`, b.sizes.totalBytes > 1.4 * b.cleanSizes.totalBytes && packed.totalBytes < 1.1 * b.cleanSizes.totalBytes,
            `clean ${b.cleanSizes.totalBytes}, bloated ${b.sizes.totalBytes}, after VACUUM FULL ${packed.totalBytes}`);

        // 6. lock impact: a 3 s ACCESS EXCLUSIVE lock must appear as ~3 s latency, waiters and lock time; a control must show none
        const held = await underLoad({ dbName: 'blog_seed', scale, rate: 40, baselineMs: 3000, afterMs: 3000, command: 'BEGIN; LOCK TABLE blog_documents IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); COMMIT' });
        check(`${server}: injected 3 s exclusive lock is measured`, held.during.all.max > 2500 && held.during.all.max < 4500 && held.locks.maxWaitingSessions > 0 && Math.abs(held.locks.msAccessExclusiveHeld - 3000) < 600 && held.baseline.all.max < 1000,
            `max latency during ${held.during.all.max} ms, waiters ${held.locks.maxWaitingSessions}, AccessExclusive seen for ${held.locks.msAccessExclusiveHeld} ms, baseline max ${held.baseline.all.max} ms`);
        const ctl = await underLoad({ dbName: 'blog_seed', scale, rate: 40, baselineMs: 2000, afterMs: 1000, command: null });
        check(`${server}: control run shows no lock impact`, ctl.during.all.max < 1000 && ctl.locks.msAccessExclusiveHeld === 0 && ctl.during.all.errors === 0, `max latency ${ctl.during.all.max} ms, AccessExclusive ${ctl.locks.msAccessExclusiveHeld} ms`);
        check(`${server}: no host stall during the lock test`, !held.stall.suspect && !ctl.stall.suspect, JSON.stringify(held.stall));
        stopServer();
    }
    // 7. stall detector: a 1.5 s blocked event loop must be flagged, an idle 0.5 s must not
    const quiet = stallWatch(); await new Promise(r => setTimeout(r, 500)); const q = quiet.stop();
    const blocked = stallWatch(); await new Promise(r => setTimeout(r, 150)); const until = Date.now() + 1500; while (Date.now() < until); await new Promise(r => setTimeout(r, 150)); const bl = blocked.stop();
    check('stall detector flags a 1.5 s freeze and not an idle wait', bl.suspect && !q.suspect, `freeze ${JSON.stringify(bl)}, idle ${JSON.stringify(q)}`);
    check('18 and 19 build identical synthetic data', fingerprints.pg18 === fingerprints.pg19, 'per-collection md5 fingerprints equal');
    check('18 and 19 run the same explicit settings', explicit.pg18 === explicit.pg19, explicit.pg18);
    // 7. the vendored storage layer is the blog's current code
    const blog = join(ROOT, '../blog');
    if (existsSync(join(blog, 'node_modules/.bin/esbuild'))) {
        const fresh = execFileSync(join(blog, 'node_modules/.bin/esbuild'), [join(blog, 'src/lib/storage/postgres.ts'), '--bundle', '--platform=node', '--format=esm', '--external:pg'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        check('vendored storage layer equals the blog source', fresh === readFileSync(join(ROOT, 'vendor/blog-storage.mjs'), 'utf8'), 're-bundled blog/src/lib/storage/postgres.ts (read-only)');
    } else check('vendored storage layer equals the blog source', true, 'SKIPPED: blog repo not found next to the lab');
    return { passed: checks.every(c => c.pass), checks };
}
