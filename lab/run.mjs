// One command per run:  node lab/run.mjs selftest | pilot | full   [--only seed,upgrade,bench,maintenance,features]
import { SCALES, environment, save, load, log, volumeExists, removeContainer, DB_NAME } from './util.mjs';
import { seed, pgUpgrade, dumpRestore, benchVariant, maintenance, features, buildControls, VARIANTS, VOL, MIX } from './stages.mjs';
import { selftest } from './selftest.mjs';
import { report } from './report.mjs';

const PRESETS = {
    pilot: { scale: 'pilot', upgradeRepeats: 2, modes: ['copy', 'link', 'swap'], benchRounds: 2, serialN: 200, mixedSeconds: 20, maintRepeats: 1, maintRate: 60, featureN: 1000 },
    full: { scale: 'full', upgradeRepeats: 5, modes: ['copy', 'link', 'swap'], benchRounds: 5, serialN: 300, mixedSeconds: 60, maintRepeats: 3, maintRate: 60, featureN: 5000, controls: true },
    // tiny end-to-end check of every stage, including the full-only ones; results are not meaningful
    smoke: { scale: 'tiny', upgradeRepeats: 1, modes: ['copy'], benchRounds: 1, serialN: 20, mixedSeconds: 3, maintRepeats: 1, maintRate: 40, featureN: 50, controls: true },
};
const mode = process.argv[2], only = (process.argv.find(a => a.startsWith('--only='))?.slice(7) || 'seed,upgrade,controls,bench,maintenance,features').split(',');
if (mode === 'selftest') {
    const r = await selftest(); save('selftest', 'selftest.json', { environment: environment(), ...r });
    log(r.passed ? 'SELF-TEST PASSED' : 'SELF-TEST FAILED'); process.exit(r.passed ? 0 : 1);
}
const preset = PRESETS[mode];
if (!preset) { console.error('usage: node lab/run.mjs selftest|pilot|full [--only=seed,upgrade,controls,bench,maintenance,features]'); process.exit(2); }
const scale = SCALES[preset.scale], dir = mode, started = Date.now();
save(dir, 'meta.json', { environment: environment(), preset, scale, mix: MIX, variants: VARIANTS });

if (only.includes('seed')) {
    log('seed: PostgreSQL 18.7 with synthetic blog data', scale);
    save(dir, 'seed.json', seed(scale));
}
const seeded = load(dir, 'seed.json');
if (!seeded || !volumeExists(VOL.v18)) throw new Error('run the seed stage first');
log(`seeded: table ${(seeded.sizes.totalBytes / 2 ** 20).toFixed(0)} MB, database ${(seeded.sizes.databaseBytes / 2 ** 20).toFixed(0)} MB`);

if (only.includes('upgrade')) {
    const runs = [];
    for (let rep = 0; rep < preset.upgradeRepeats; rep++) {
        for (const m of preset.modes) {
            log(`upgrade: pg_upgrade --${m} #${rep}`);
            let r = await pgUpgrade({ mode: m, scale, expectedFingerprint: seeded.fingerprint, keepAs: m === 'copy' && rep === 0 ? VOL.v19u : null });
            if (r.suspect) { log('  host stalled, repeating'); r = await pgUpgrade({ mode: m, scale, expectedFingerprint: seeded.fingerprint, keepAs: m === 'copy' && rep === 0 ? VOL.v19u : null }); }
            runs.push({ repeat: rep, ...r }); log(`  downtime ${Math.round(r.downtimeMs)} ms, data identical: ${r.fingerprintMatches}`);
        }
        log(`upgrade: dump/restore #${rep}`);
        let r = await dumpRestore({ scale, expectedFingerprint: seeded.fingerprint, keepAs: rep === 0 ? VOL.v19r : null });
        if (r.suspect) { log('  host stalled, repeating'); r = await dumpRestore({ scale, expectedFingerprint: seeded.fingerprint, keepAs: rep === 0 ? VOL.v19r : null }); }
        runs.push({ repeat: rep, ...r }); log(`  downtime ${Math.round(r.downtimeMs)} ms, data identical: ${r.fingerprintMatches}`);
        save(dir, 'upgrade.json', runs);
    }
}
if (only.includes('controls') && preset.controls) {
    log('controls: rewrite large values with pglz and with lz4');
    save(dir, 'controls.json', buildControls(seeded.fingerprint));
}
if (only.includes('bench')) {
    const keys = Object.keys(VARIANTS).filter(k => preset.controls || !VARIANTS[k].control), runs = [], raw = [];
    for (let round = 0; round < preset.benchRounds; round++) {
        for (const key of [...keys.slice(round % keys.length), ...keys.slice(0, round % keys.length)]) { // rotate order each round
            log(`bench: ${key} round ${round}`);
            let res;
            for (let attempt = 0; attempt < 3; attempt++) { // a run during which the host slept is discarded and repeated
                res = await benchVariant(key, { scale, serialN: preset.serialN, mixedSeconds: preset.mixedSeconds, round, withPlans: round === 0 });
                if (!res.stall.suspect) break; log(`  host stalled (${JSON.stringify(res.stall)}), repeating`);
            }
            const { raw: latencies, ...r } = res;
            runs.push(r); raw.push({ variant: key, round, latenciesMs: latencies });
            log(`  mixed ${r.mixed.throughput} ops/s, p95 ${r.mixed.all.p95} ms, errors ${r.mixed.errors}`);
            save(dir, 'bench.json', runs); save(dir, 'bench-raw.json', JSON.stringify(raw) + '\n');
        }
    }
}
if (only.includes('maintenance')) {
    log('maintenance: VACUUM FULL / REPACK / REPACK (CONCURRENTLY) under load');
    const { results, raw } = await maintenance({ scale, rate: preset.maintRate, repeats: preset.maintRepeats, extended: Boolean(preset.controls) });
    save(dir, 'maintenance.json', results); save(dir, 'maintenance-raw.json', JSON.stringify(raw) + '\n');
}
if (only.includes('features')) {
    log('features: ON CONFLICT DO SELECT');
    const { raw, ...f } = await features({ scale, n: preset.featureN });
    save(dir, 'features.json', f); save(dir, 'features-raw.json', JSON.stringify(raw) + '\n');
}
removeContainer(DB_NAME);
save(dir, 'SUMMARY.md', report(dir));
log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min; see results/${dir}/SUMMARY.md`);
