# pilot results

**PostgreSQL 19 is NOT generally available on 2026-11-16. Latest official pre-release is 19 RC 2 (2026-11-12). All "19" numbers are RC 2.**

- Compared: PostgreSQL 18.7 (`postgres:18.7`) and PostgreSQL 19 RC 2 (pre-release, not GA) (`postgres:19rc2`).
- Host: Darwin 25.6.0 arm64, 10 cores (Apple M5), 24 GB; Docker 29.9.3 linux/arm64 (8 CPUs, 8215052288 bytes). Server container limits: 2 CPUs, 2g RAM.
- Same explicit settings on both: shared_buffers=512MB, effective_cache_size=1GB, work_mem=16MB, maintenance_work_mem=256MB, max_wal_size=4GB, checkpoint_timeout=15min, random_page_cost=1.1, max_connections=60. Everything else is each version's default.
- Scale: 2000 posts, 200000 events, 20000 subs, 2000 embeddings, 2000 conversations.

- Contention: host 1-minute load average was 2.48–8.46 across measurements (10 cores); other containers running: agentmemlab-letta, agentmemlab-neo4j, agentmemlab-pg. Other labs shared this laptop, so small differences are noise.

- Host stall check (laptop sleep or a frozen process): no measurement in these results was taken during a stall. Runs recorded before the check existed carry no stall field.

## Dataset

Seeded on 18.7 in 13.24 s. Table `blog_documents` 344 MB total (heap 105 MB, TOAST 22 MB, indexes 218 MB).

## Upgrade 18.7 → 19 RC 2

| Method | Runs | Downtime s (median) | Range s | Main steps (median s) | Data identical | Stats present before ANALYZE | Table MB after | App smoke test |
|---|---|---|---|---|---|---|---|---|
| pg_upgrade --copy | 2/2 ok | 2.14 | 2.14–2.26 | initdb 0.24, check 0.56, upgrade 1.46, carry_pg_hba 0.00, first start 0.12 | yes | yes | 344 | all ops ok |
| pg_upgrade --link | 2/2 ok | 2.01 | 2.01–2.04 | initdb 0.23, check 0.55, upgrade 1.32, carry_pg_hba 0.00, first start 0.13 | yes | yes | 344 | all ops ok |
| pg_upgrade --swap | 2/2 ok | 2.00 | 2–2.02 | initdb 0.22, check 0.54, upgrade 1.33, carry_pg_hba 0.00, first start 0.13 | yes | yes | 344 | all ops ok |
| pg_dump -Fd -j 2 (19 client) + pg_restore -j 2 | 2/2 ok | 6.38 | 6.38–6.44 | dump_globals 0.02, dump_db 1.67, restore_globals 0.02, createdb 0.03, restore_db 3.52, analyze 0.44, initdb+start 0.64 | yes | yes | 302 | all ops ok |

TOAST compression after pg_upgrade: `inline/uncompressed|220000, pglz|6000`; after dump/restore: `inline/uncompressed|220000, lz4|6000`.

Warnings and errors seen:

- `NOTE restore_globals: psql:/dump/globals.sql:16: ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`

## Query latency, one client (p50 ms, median of rounds)

Rounds per variant: 2. Ratio column is 19-upgraded / 18.

| Operation | pg18 | pg18-jit-off | pg19-upgraded | pg19-upgraded-jit-on | pg19-restored | 19/18 |
|---|---|---|---|---|---|---|
| postBySlug | 0.36 | 0.35 | 0.36 | 0.35 | 0.34 | 0.99 |
| docGet | 0.33 | 0.28 | 0.29 | 0.31 | 0.28 | 0.91 |
| listRecent | 0.72 | 0.72 | 0.72 | 0.70 | 0.67 | 1.00 |
| listCategory | 9.60 | 9.60 | 9.40 | 9.44 | 6.30 | 0.98 |
| listTag | 4.99 | 5.04 | 4.92 | 4.91 | 3.58 | 0.99 |
| popular | 28.34 | 28.07 | 27.92 | 27.80 | 17.27 | 0.99 |
| search100 | 4.18 | 4.24 | 3.87 | 3.96 | 4.67 | 0.93 |
| adminList | 1.33 | 1.36 | 1.23 | 1.24 | 1.02 | 0.92 |
| countPublished | 0.38 | 0.35 | 0.35 | 0.33 | 0.32 | 0.92 |
| eventsForPosts | 3.36 | 3.29 | 3.44 | 3.31 | 3.39 | 1.02 |
| subscriberLookup | 2.64 | 2.77 | 2.57 | 2.50 | 2.61 | 0.97 |
| viewIncrement | 1.37 | 1.44 | 1.33 | 1.45 | 1.32 | 0.97 |
| trackEvent | 1.07 | 1.06 | 1.07 | 1.04 | 1.06 | 1.00 |
| subscribe | 6.50 | 6.70 | 6.31 | 6.37 | 6.25 | 0.97 |
| *analytical (not an app query)* | 200.7 | 195.6 | 194.1 | 198.4 | 196.5 | 0.97 |

## Mixed workload, 8 clients (2 app instances × pool of 4)

| Variant | Throughput ops/s (median) | Per round | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| pg18 | 465.1 | 500.3, 465.1 | 2.908 | 84.814 | 115.207 | 0 |
| pg18-jit-off | 458.7 | 496, 458.7 | 2.913 | 85.089 | 151.065 | 0 |
| pg19-upgraded | 499.6 | 542.4, 499.6 | 2.835 | 80.651 | 106.516 | 0 |
| pg19-upgraded-jit-on | 494.2 | 525.3, 494.2 | 2.91 | 82.413 | 110.278 | 0 |
| pg19-restored | 722.3 | 771.2, 722.3 | 2.598 | 64.488 | 84.859 | 0 |

Total errors across all benchmark runs: 0.

## Planner cost and JIT (jit_above_cost = 100000)

| Query | Plan cost on 18 | JIT fired on 18 (default on) | JIT fired on 19 with jit=on | JIT compile ms (18) |
|---|---|---|---|---|
| analytical | 87666 | no | no |  |
| postBySlug | 3 | no | no |  |
| docGet | 3 | no | no |  |
| listRecent | 11 | no | no |  |
| listCategory | 4 | no | no |  |
| listTag | 15 | no | no |  |
| popular | 15 | no | no |  |
| search100 | 11 | no | no |  |
| adminList | 309 | no | no |  |
| countPublished | 9 | no | no |  |
| eventsForPosts | 526 | no | no |  |
| subscriberLookup | 72 | no | no |  |

## Reclaiming a bloated table while the app is under load

Open-loop load at 60 requests/s through one app instance (pool of 4, 30 s statement timeout). Bloat template: 594 MB on 18.

| Case | Runs | Duration s | Table MB before → after | WAL MB | Baseline p99 ms | During p50 / p99 / max ms | Requests >1 s | Failed requests | ACCESS EXCLUSIVE held ms | Time with blocked sessions ms | Command error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pg18 VACUUM FULL | 1 | 1.68 | 594 → 180 | 159 | 58.46 | 904.72 / 1682.02 / 1700.11 | 45 | 0 | 1704 | 1704 | none |
| pg18 control | 1 | 5.00 | 594 → 594 | 3 | 58.03 | 21.3 / 58.16 / 62.29 | 0 | 0 | 0 | 0 | none |
| pg19 VACUUM FULL | 1 | 1.73 | 605 → 187 | 165 | 50.77 | 916.77 / 1732.12 / 1749.85 | 47 | 0 | 1808 | 1808 | none |
| pg19 REPACK | 1 | 1.58 | 605 → 187 | 165 | 46.36 | 822.75 / 1582.72 / 1582.72 | 37 | 0 | 1605 | 1605 | none |
| pg19 REPACK (CONCURRENTLY) | 1 | 1.86 | 605 → 187 | 168 | 48.28 | 21.52 / 84.17 / 89.19 | 0 | 0 | 0 | 0 | none |
| pg19 control | 1 | 5.00 | 605 → 605 | 4 | 46.28 | 21.07 / 46.41 / 54.58 | 0 | 0 | 0 | 0 | none |

## INSERT … ON CONFLICT DO SELECT (19 RC 2)

- PostgreSQL 18.7: rejected: 42601 syntax error at or near "SELECT"
- 19 RC 2 correctness: existing row returned unchanged = true, new row inserted = true

Get-or-create, 1000 calls, 80% already exist, one client, on 19 RC 2:

| Approach | p50 ms | p95 ms | WAL bytes per call | Row updates caused |
|---|---|---|---|---|
| app today: SERIALIZABLE txn, SELECT then INSERT (5 round trips) | 0.669 | 1.357 | 421 | 0 |
| classic: SELECT, then INSERT ON CONFLICT DO NOTHING | 0.26 | 0.68 | 409 | 0 |
| hack: ON CONFLICT DO UPDATE SET data = existing (1 round trip, writes) | 0.359 | 0.427 | 1717 | 800 |
| 19: ON CONFLICT DO SELECT (1 round trip, no write on hit) | 0.294 | 0.437 | 429 | 0 |

Advice extensions available in the image: pg_stash_advice 1.0.

