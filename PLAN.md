# PLAN: PostgreSQL 18 → 19 upgrade lab

Status on 16 November 2026: pilot done; full run approved and completed, see `RESULTS.md` (it corrects two pilot conclusions). Nothing is committed.

## 1. What was verified against official sources

| Claim from the brief | Verdict | Evidence |
|---|---|---|
| 19 is GA / GA on 19 November | **Not GA today. No GA date found on postgresql.org.** | Homepage and news archive: latest is **19 RC 2, 12 Nov 2026** (RC 1 was 15 Oct). Release notes still say "Release date: 2026-??-??". The 19 November date comes from secondary sources only. |
| Docker image | `postgres:19rc2` (no `19` or `19.0` tag yet); `postgres:18.7` is `latest` | docker-library manifest; both pulled, arm64 |
| JIT off by default | **True** | Release notes; measured `jit=off` on 19rc2, `jit=on` on 18.7 |
| `REPACK`, `REPACK (CONCURRENTLY)` | **True.** Syntax is `REPACK (CONCURRENTLY) table`. `VACUUM FULL` and `CLUSTER` are kept, not removed | Release notes, `sql-repack` page; ran both |
| Parallel autovacuum | **True**, off by default (`autovacuum_max_parallel_workers=0`) | Release notes; setting read from 19rc2. Not measured |
| `ON CONFLICT DO SELECT` | **True** | Release notes; ran it; 18.7 rejects it with a syntax error |
| `pg_plan_advice` | **True**, as a loadable module (`LOAD 'pg_plan_advice'`, `EXPLAIN (PLAN_ADVICE)`); only `pg_stash_advice` is a `CREATE EXTENSION` | Release notes; ran it on 19rc2. Not measured |
| `GROUP BY ALL` | **Not in 19 RC 2** | Absent from release notes; `GROUP BY ALL` is a syntax error on 19rc2 |
| SQL/PGQ | **Not in 19 RC 2** | Absent from release notes; `CREATE PROPERTY GRAPH` is a syntax error on 19rc2 |

Other release-note items that matter for this app: default TOAST compression changes from `pglz` to `lz4`;
`log_lock_waits` is on by default; `max_locks_per_transaction` 64 → 128; MD5 password logins now warn;
`standard_conforming_strings` can no longer be turned off. Full list from the release notes is in the
shared notes hand-over.

Versions used: PostgreSQL 18.7 (Debian 18.7-1.pgdg13+2) and PostgreSQL 19rc2 (Debian 19~rc2-1.pgdg13+1),
aarch64, image IDs in `results/pilot/meta.json`. **Every "19" number below is RC 2, not GA.**

## 2. Pilot

One command, about 9 minutes: `npm run pilot`. Tables: `results/pilot/SUMMARY.md`. Raw samples: `results/pilot/*-raw.json`.

Setup: the blog's real schema and its real storage layer (bundled unchanged), synthetic data
(2,000 posts, 200,000 analytics events, 20,000 subscribers, 2,000 embeddings, 2,000 conversations;
344 MB table), server container limited to 2 CPUs and 2 GB, same explicit settings on both versions.
The pilot ran twice from scratch and the two runs agree closely; numbers below are from the second run.

Pilot repeats are small (2 per upgrade method and benchmark variant, 1 per maintenance case). Treat
differences under about 10% as noise: three containers from another lab were running and host load
average ranged from 2.5 to 8.5.

### Findings

1. **The upgrade itself was uneventful.** Data was byte-identical (per-collection md5) after every method, and
   all 14 app operations ran on 19 RC 2 without errors.

   | Method | Downtime, median of 2 | Notes |
   |---|---|---|
   | `pg_upgrade --copy` | 2.1 s | planner statistics carried over, no `ANALYZE` needed |
   | `pg_upgrade --link` | 2.0 s | |
   | `pg_upgrade --swap` | 2.0 s | |
   | `pg_dump -Fd -j 2` + `pg_restore -j 2` | 6.4 s | restoring globals prints `role "postgres" already exists` (harmless) |

   At 344 MB the methods barely differ; the fixed cost (checks, catalog dump) dominates. The only manual
   step that would have broken the app: `pg_upgrade` creates the new cluster with a fresh `pg_hba.conf`, so
   the old one must be copied over or remote logins fail.

2. **The biggest performance change is not a 19 feature, it is how you upgrade.** After `pg_upgrade` the
   large documents stay `pglz`-compressed; after dump/restore they are rewritten with 19's new default, `lz4`.

   | Variant | Mixed workload, 8 clients | `popular` p50 | `listCategory` p50 | Table size |
   |---|---|---|---|---|
   | 18.7 | 465 ops/s (500, 465) | 28.3 ms | 9.6 ms | 344 MB |
   | 19 RC 2 after `pg_upgrade` | 500 ops/s (542, 500) | 27.9 ms | 9.4 ms | 344 MB |
   | 19 RC 2 after dump/restore | 722 ops/s (771, 722) | 17.3 ms | 6.3 ms | 302 MB |

   The cause is **not yet proven**: dump/restore also rebuilds the table and indexes. The full run adds
   controls to separate compression from the rebuild (section 3).

3. **18.7 to 19 RC 2 on the same data: single-query latency is within noise** (ratios 0.91–1.02 across 14
   operations). Mixed throughput was about 7% higher on 19 in both pilot runs, which is too small to claim
   with 2 rounds.

4. **JIT default: no effect on this app at this scale.** No app query has a plan cost near
   `jit_above_cost` (the highest is 526 against a threshold of 100,000), so JIT never fired on 18 either.
   Turning it off on 18 or on on 19 changed nothing measurable. Even the reporting-style query I added
   (not an app query) costs 87,666 and stays under the threshold at pilot scale.

5. **`REPACK (CONCURRENTLY)` did what it claims.** Bloated table 594–605 MB, app load at 60 requests/s.

   | Command | Duration | Size after | Slowest request during | Requests over 1 s | `ACCESS EXCLUSIVE` seen |
   |---|---|---|---|---|---|
   | 18.7 `VACUUM FULL` | 1.7 s | 180 MB | 1,700 ms | 45 | 1.7 s |
   | 19 `VACUUM FULL` | 1.7 s | 187 MB | 1,750 ms | 47 | 1.8 s |
   | 19 `REPACK` | 1.6 s | 187 MB | 1,583 ms | 37 | 1.6 s |
   | 19 `REPACK (CONCURRENTLY)` | 1.9 s | 187 MB | 89 ms | 0 | not observed (100 ms sampler) |
   | no maintenance (control) | | | 54–62 ms | 0 | none |

   Plain `REPACK` behaves like `VACUUM FULL`: the whole app stalls for the duration. The concurrent form
   needed no configuration (`wal_level=replica` was enough) and wrote about the same WAL (168 MB against 165 MB).
   One run each, and the table is too small: a 1.7 s stall never reaches the app's 30 s statement timeout.

6. **`ON CONFLICT DO SELECT` works and removes a write.** Get-or-create, 80% of keys already present, 1,000 calls:
   one round trip at 0.29 ms p50 with no row update, against 0.36 ms and 800 needless row updates (4× the WAL)
   for the `DO UPDATE SET x = x` trick, and 0.67 ms for the app's current 5-round-trip serializable transaction.

### What the self-test caught

`npm run selftest` (26 checks, all pass) found two real harness bugs before the pilot:
- requests were assigned to the wrong time window, so a lock's delay leaked into the "baseline";
- my JIT probe was wrong: `pg_jit_available()` returns false whenever `jit=off`, which made the stock 19rc2
  image look as if it shipped without JIT. It does ship with it.

### What failed or is unverified

- **A laptop sleep invalidated one rerun.** The machine went to sleep after the first pilot; a partial rerun
  during sleep recorded 120-second "latencies". Those results were discarded. The harness now detects a
  stalled host, discards and repeats affected measurements, and `npm run pilot` output states whether any
  measurement was taken during a stall (none were). `pg_upgrade` runs are flagged but not auto-repeated.
- The lz4 explanation in finding 2 is a hypothesis until the controls run.
- Parallel autovacuum and `pg_plan_advice` were confirmed to exist but not measured.
- The workload mix weights are my assumption, not the blog's real traffic. Production holds 37 documents;
  the lab data is thousands of times larger by design.
- Client latency includes Docker Desktop's port forward on macOS, equally for both versions.
- The app's write paths use SERIALIZABLE transactions; `REPACK (CONCURRENTLY)` is documented as not MVCC-safe.
  The pilot saw zero failed requests, but it did not check for wrong results under that caveat.
- Release-note facts were read by a fetch sub-agent from postgresql.org; I re-checked the ones I could by
  running them on 19rc2 (table in section 1). The GA date was not confirmed anywhere official.

## 3. Proposed full run

Command: `npm run full`. Cost: **$0** (no paid APIs). Laptop time: **about 4–5 hours**, sequential, with the
lid open and on power (`caffeinate` wraps the run). Disk: about 40 GB of Docker volumes, removed afterwards.

| Stage | Change from pilot | Estimated time |
|---|---|---|
| Data | 10× scale: 10,000 posts, 2,000,000 events, 100,000 subscribers, 10,000 embeddings and conversations (about 3.5 GB table, larger than the 2 GB memory limit) | 5 min |
| Upgrade | 5 repeats of copy, link, swap and dump/restore, so the methods can actually separate | 50 min |
| Benchmark | 5 rounds, 600 samples per operation, 90 s mixed runs, order rotated each round | 2.5 h |
| Benchmark controls (new) | 18.7 seeded with `lz4`; 19 after `pg_upgrade` with documents rewritten to `lz4`; 19 after dump/restore forced back to `pglz`. Answers: is the gain compression, and can you get it without a dump/restore? | included |
| JIT (new) | at this scale the reporting query crosses `jit_above_cost`, so the default flip becomes measurable; add a short `jit_above_cost` sweep | 10 min |
| Maintenance | 5 repeats per case on a multi-GB bloated table, so the exclusive lock lasts long enough to hit the 30 s timeout; add a higher write rate and peak disk use for `REPACK (CONCURRENTLY)` | 50 min |
| Features | `ON CONFLICT DO SELECT` with 5,000 calls and 8 concurrent clients | 5 min |

Before publishing: rerun on `postgres:19.0` when it exists (one line in `lab/util.mjs`). If the post goes
out before GA, every chart and table must say "19 RC 2".

## 4. Post angle

Working title: **"I upgraded a real app to PostgreSQL 19. The headline features mattered less than how I upgraded."**

- Lead with the surprise: same app, same data, same server; the dump/restore copy served about 50% more
  requests than the `pg_upgrade` copy, because of a changed default nobody put in the headline (if the
  full-run controls confirm it).
- JIT off by default: a non-event for a small web app, with the plan-cost table showing why, and the one
  kind of query where it would matter.
- `REPACK (CONCURRENTLY)`: the feature that changes operations. Show the stall chart: `VACUUM FULL` freezes
  the app, the concurrent form does not. State the caveats (not MVCC-safe, needs a primary key, extra WAL).
- `ON CONFLICT DO SELECT`: a small code simplification with a measured write saving.
- Corrections to what is circulating: `GROUP BY ALL` and SQL/PGQ are not in 19 RC 2.
- A practical checklist: `pg_upgrade --check`, carry over `pg_hba.conf`, decide on re-compression, when to
  re-enable JIT.

## 5. Decisions needed

1. Approve the full run as proposed (about 4–5 hours of laptop time, $0), or shrink it.
2. Publish on RC 2 numbers clearly labelled, or wait for 19.0 and rerun.
3. Keep the lab workload mix as is, or supply rough real traffic proportions.
