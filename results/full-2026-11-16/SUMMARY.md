# full results

**PostgreSQL 19 is NOT generally available on 2026-11-16. Latest official pre-release is 19 RC 2 (2026-11-12). All "19" numbers are RC 2.**

- Compared: PostgreSQL 18.7 (`postgres:18.7`) and PostgreSQL 19 RC 2 (pre-release, not GA) (`postgres:19rc2`).
- Host: Darwin 25.6.0 arm64, 10 cores (Apple M5), 24 GB; Docker 29.9.3 linux/arm64 (8 CPUs, 8215052288 bytes). Server container limits: 2 CPUs, 2g RAM.
- Same explicit settings on both: shared_buffers=512MB, effective_cache_size=1GB, work_mem=16MB, maintenance_work_mem=256MB, max_wal_size=4GB, checkpoint_timeout=15min, random_page_cost=1.1, max_connections=60. Everything else is each version's default.
- Scale: 10000 posts, 2000000 events, 100000 subs, 10000 embeddings, 10000 conversations.

- Contention: host 1-minute load average was 2.28–13.49 across measurements (10 cores); other containers running: agentmemlab-letta, agentmemlab-neo4j, agentmemlab-pg, dfl-8ac62f27bf, dfl-6d13bab369, dfl-30c9f893eb, dfl-59983b646e, dfl-e1b21c5dca, dfl-14e704ad2d, dfl-0a5fecef52, dfl-53681b8542, dfl-ba026ba2b0, dfl-bdf0d1d4ca, dfl-ef77b8fba5, loving_brown, dfl-88618eca80, dfl-03554184d2, dfl-2a0e19a281, dfl-8d87e200b8, dfl-8750510245, dfl-9ad665f7da. Other labs shared this laptop, so small differences are noise.

- Host stall check (laptop sleep or a frozen process): no measurement in these results was taken during a stall. Runs recorded before the check existed carry no stall field.

## Dataset

Seeded on 18.7 in 104.57 s. Table `blog_documents` 3089 MB total (heap 1010 MB, TOAST 108 MB, indexes 1971 MB).

## Upgrade 18.7 → 19 RC 2

| Method | Runs | Downtime s (median) | Range s | Main steps (median s) | Data identical | Stats present before ANALYZE | Table MB after | App smoke test |
|---|---|---|---|---|---|---|---|---|
| pg_upgrade --copy | 5/5 ok | 6.04 | 4.66–7.37 | initdb 0.29, check 0.61, upgrade 5.26, carry_pg_hba 0.00, first start 0.18 | yes | yes | 3089 | all ops ok |
| pg_upgrade --link | 5/5 ok | 2.16 | 2.14–2.24 | initdb 0.28, check 0.63, upgrade 1.36, carry_pg_hba 0.00, first start 0.18 | yes | yes | 3089 | all ops ok |
| pg_upgrade --swap | 5/5 ok | 2.15 | 2.12–2.23 | initdb 0.28, check 0.61, upgrade 1.36, carry_pg_hba 0.00, first start 0.18 | yes | yes | 3089 | all ops ok |
| pg_dump -Fd -j 2 (19 client) + pg_restore -j 2 | 5/5 ok | 57.51 | 54.56–59.44 | dump_globals 0.04, dump_db 10.50, restore_globals 0.02, createdb 0.04, restore_db 43.09, analyze 3.12, initdb+start 0.77 | yes | yes | 2631 | all ops ok |

TOAST compression after pg_upgrade: `inline/uncompressed|2100000, pglz|30000`; after dump/restore: `inline/uncompressed|2100000, lz4|30000`.

Warnings and errors seen:

- `NOTE restore_globals: psql:/dump/globals.sql:16: ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
- `FATAL:  the database system is starting up`
- `ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`

## Compression controls

Each control is a copy of a cluster whose large values were rewritten in place with one compression method, then `VACUUM FULL`. Same logical data.

| Control | Compression of stored values | Table MB | TOAST MB | Data identical |
|---|---|---|---|---|
| pg19-rewritten-pglz | inline/uncompressed 2100000, pglz 30000 | 2594 | 114 | yes |
| pg19-rewritten-lz4 | inline/uncompressed 2100000, lz4 30000 | 2630 | 150 | yes |
| pg18-rewritten-lz4 | inline/uncompressed 2100000, lz4 30000 | 2630 | 150 | yes |

## Query latency, one client (p50 ms, median of rounds)

Rounds per variant: 5. Ratio column is 19-upgraded / 18.

| Operation | pg18 | pg18-jit-off | pg19-upgraded | pg19-upgraded-jit-on | pg19-restored | pg19-rewritten-pglz | pg19-rewritten-lz4 | pg18-rewritten-lz4 | 19/18 |
|---|---|---|---|---|---|---|---|---|---|
| postBySlug | 0.44 | 0.42 | 0.40 | 0.42 | 0.40 | 0.41 | 0.44 | 0.36 | 0.92 |
| docGet | 0.35 | 0.32 | 0.35 | 0.32 | 0.30 | 0.33 | 0.31 | 0.29 | 1.01 |
| listRecent | 0.76 | 0.73 | 0.78 | 0.75 | 0.68 | 0.71 | 0.71 | 0.70 | 1.02 |
| listCategory | 46.56 | 46.72 | 45.70 | 45.75 | 30.76 | 46.95 | 31.43 | 31.76 | 0.98 |
| listTag | 23.63 | 23.58 | 23.28 | 23.40 | 16.19 | 24.18 | 17.01 | 17.27 | 0.99 |
| popular | 139.20 | 139.66 | 139.09 | 138.07 | 85.53 | 143.31 | 90.28 | 90.95 | 1.00 |
| search100 | 4.72 | 4.16 | 4.46 | 4.18 | 3.63 | 4.26 | 3.77 | 4.08 | 0.95 |
| adminList | 1.39 | 1.39 | 1.30 | 1.29 | 1.06 | 1.27 | 1.07 | 1.15 | 0.93 |
| countPublished | 0.80 | 0.79 | 0.65 | 0.68 | 0.67 | 1.55 | 1.54 | 1.53 | 0.81 |
| eventsForPosts | 56.21 | 59.46 | 54.00 | 43.27 | 53.87 | 54.21 | 56.99 | 33.48 | 0.96 |
| subscriberLookup | 13.44 | 13.70 | 13.65 | 12.90 | 13.27 | 13.43 | 13.41 | 14.41 | 1.02 |
| viewIncrement | 1.66 | 1.60 | 1.51 | 1.56 | 1.50 | 1.50 | 1.47 | 1.49 | 0.91 |
| trackEvent | 1.30 | 1.27 | 1.29 | 1.28 | 1.32 | 1.26 | 1.25 | 1.29 | 0.99 |
| subscribe | 28.36 | 28.56 | 27.26 | 27.54 | 27.41 | 28.90 | 28.86 | 29.44 | 0.96 |
| *analytical (not an app query)* | 3326.2 | 3195.5 | 3255.1 | 3263.0 | 3429.9 | 3563.7 | 3384.2 | 3346.3 | 0.98 |

## Mixed workload, 8 clients (2 app instances × pool of 4)

| Variant | Throughput ops/s (median) | Per round | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| pg18 | 90 | 90.5, 78.8, 67.8, 90, 94 | 3.326 | 421.315 | 985.724 | 0 |
| pg18-jit-off | 93 | 93.2, 78.8, 71.6, 93, 93.3 | 3.431 | 407.637 | 950.179 | 0 |
| pg19-upgraded | 91.6 | 93.7, 86, 84.2, 91.6, 96 | 3.295 | 425.58 | 915.86 | 0 |
| pg19-upgraded-jit-on | 90.1 | 96.3, 87.3, 90.1, 76.8, 93.4 | 3.148 | 573.064 | 983.991 | 0 |
| pg19-restored | 127.6 | 146.8, 127.6, 106.6, 85.4, 149.9 | 3.138 | 391.935 | 578.781 | 0 |
| pg19-rewritten-pglz | 83.3 | 84.5, 83.3, 81.2, 78.5, 90.1 | 3.577 | 593.487 | 997.476 | 0 |
| pg19-rewritten-lz4 | 133.1 | 144.9, 133.1, 120.3, 129.1, 137.8 | 3.517 | 391.921 | 594.454 | 0 |
| pg18-rewritten-lz4 | 125.3 | 125.3, 122.1, 91.2, 126.1, 136.5 | 3.421 | 409.002 | 601.317 | 0 |

Total errors across all benchmark runs: 0.

## Planner cost and JIT (jit_above_cost = 100000)

| Query | Plan cost on 18 | JIT fired on 18 (default on) | JIT fired on 19 with jit=on | JIT compile ms (18) |
|---|---|---|---|---|
| analytical | 910031 | yes | yes | 221.9 |
| postBySlug | 3 | no | no |  |
| docGet | 3 | no | no |  |
| listRecent | 26 | no | no |  |
| listCategory | 9 | no | no |  |
| listTag | 37 | no | no |  |
| popular | 44 | no | no |  |
| search100 | 26 | no | no |  |
| adminList | 310 | no | no |  |
| countPublished | 24 | no | no |  |
| eventsForPosts | 1140 | no | no |  |
| subscriberLookup | 86 | no | no |  |

## Reclaiming a bloated table while the app is under load

Open-loop load at 60 requests/s (write-heavy cases: double) through one app instance (pool of 4, 30 s statement timeout). Bloat template: 5406 MB on 18.

| Case | Runs | Duration s | Table MB before → after | WAL MB | Baseline p99 ms | During p50 / p99 / max ms | Requests >1 s | Failed requests | Peak extra disk MB | ACCESS EXCLUSIVE held ms | Time with blocked sessions ms | Command error |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pg18 VACUUM FULL | 3 | 17.68 | 5406 → 1468 | 1307 | 188.75 | 9496.16 / 10023.33 / 17717.17 | 1061 | 1473 | 1442 | 17565 | 17665 | none |
| pg18 control | 3 | 5.00 | 5406 → 5406 | 4 | 180.69 | 21.65 / 195.06 / 221.86 | 0 | 0 | 0 | 0 | 0 | none |
| pg19 VACUUM FULL | 3 | 17.64 | 5461 → 1504 | 1337 | 149.01 | 9301.74 / 10023.2 / 17677.61 | 1060 | 1503 | 1484 | 17652 | 17652 | none |
| pg19 REPACK | 3 | 16.73 | 5461 → 1504 | 1337 | 139.29 | 8963.87 / 10023.28 / 16742.99 | 1005 | 1233 | 1491 | 16761 | 16761 | none |
| pg19 REPACK (CONCURRENTLY) | 3 | 30.35 | 5461 → 1503 | 1373 | 143.61 | 51.26 / 568.3 / 950.65 | 0 | 1 | 1501 | 0 | 0 | none |
| pg19 control | 3 | 5.00 | 5461 → 5461 | 5 | 139.13 | 21.67 / 131.63 / 148.21 | 0 | 0 | 0 | 0 | 0 | none |
| pg19 REPACK (CONCURRENTLY), write-heavy | 3 | 18.11 | 5461 → 1509 | 1396 | 16.7 | 13.69 / 64.41 / 121.74 | 0 | 0 | 1506 | 0 | 0 | none |
| pg19 control, write-heavy | 3 | 5.00 | 5461 → 5463 | 21 | 17.28 | 12.62 / 16.41 / 17.7 | 0 | 0 | 1 | 0 | 0 | none |

Request error codes seen: timeout exceeded when trying to connect, 5.

## INSERT … ON CONFLICT DO SELECT (19 RC 2)

- PostgreSQL 18.7: rejected: 42601 syntax error at or near "SELECT"
- 19 RC 2 correctness: existing row returned unchanged = true, new row inserted = true

Get-or-create, 5000 calls, 80% already exist, one client, on 19 RC 2:

| Approach | p50 ms | p95 ms | WAL bytes per call | Row updates caused |
|---|---|---|---|---|
| app today: SERIALIZABLE txn, SELECT then INSERT (5 round trips) | 0.811 | 1.578 | 2026 | 0 |
| classic: SELECT, then INSERT ON CONFLICT DO NOTHING | 0.302 | 0.869 | 2014 | 0 |
| hack: ON CONFLICT DO UPDATE SET data = existing (1 round trip, writes) | 0.556 | 2.428 | 15709 | 4000 |
| 19: ON CONFLICT DO SELECT (1 round trip, no write on hit) | 0.269 | 0.588 | 2030 | 0 |

Advice extensions available in the image: pg_stash_advice 1.0.

