# full results

**PostgreSQL 19 is NOT generally available (checked 2026-11-17: no postgres:19 or 19.0 image exists). Latest official pre-release is 19 RC 2 (2026-11-12). All "19" numbers are RC 2.**

- Compared: PostgreSQL 18.7 (`postgres:18.7`) and PostgreSQL 19 RC 2 (pre-release, not GA) (`postgres:19rc2`).
- Host: Darwin 25.6.0 arm64, 10 cores (Apple M5), 24 GB; Docker 29.9.3 linux/arm64 (8 CPUs, 8215052288 bytes). Server container limits: 2 CPUs, 2g RAM.
- Same explicit settings on both: shared_buffers=512MB, effective_cache_size=1GB, work_mem=16MB, maintenance_work_mem=256MB, max_wal_size=4GB, checkpoint_timeout=15min, random_page_cost=1.1, max_connections=60. Everything else is each version's default.
- Scale: 10000 posts, 2000000 events, 100000 subs, 10000 embeddings, 10000 conversations.

- Contention: host 1-minute load average was 2.46–23.16 across measurements (10 cores); other containers running: none. Other labs shared this laptop, so small differences are noise.

- Host stall check (laptop sleep or a frozen process): no measurement in these results was taken during a stall. Runs recorded before the check existed carry no stall field.

## Dataset

Seeded on 18.7 in 119.79 s. Table `blog_documents` 3092 MB total (heap 1010 MB, TOAST 108 MB, indexes 1974 MB).

## Upgrade 18.7 → 19 RC 2

| Method | Runs | Downtime s (median) | Range s | Main steps (median s) | Data identical | Stats present before ANALYZE | Table MB after | App smoke test |
|---|---|---|---|---|---|---|---|---|
| pg_upgrade --copy | 5/5 ok | 5.09 | 4.31–7.53 | initdb 0.28, check 0.63, upgrade 4.22, carry_pg_hba 0.00, first start 0.20 | yes | yes | 3092 | all ops ok |
| pg_upgrade --link | 5/5 ok | 2.19 | 2.14–2.61 | initdb 0.26, check 0.62, upgrade 1.38, carry_pg_hba 0.00, first start 0.19 | yes | yes | 3092 | all ops ok |
| pg_upgrade --swap | 5/5 ok | 2.17 | 2.14–2.34 | initdb 0.26, check 0.62, upgrade 1.37, carry_pg_hba 0.00, first start 0.16 | yes | yes | 3092 | all ops ok |
| pg_dump -Fd -j 2 (19 client) + pg_restore -j 2 | 5/5 ok | 58.24 | 54.83–61.08 | dump_globals 0.03, dump_db 10.94, restore_globals 0.02, createdb 0.04, restore_db 41.41, analyze 4.59, initdb+start 0.99 | yes | yes | 2631 | all ops ok |

TOAST compression after pg_upgrade: `inline/uncompressed|2100000, pglz|30000`; after dump/restore: `inline/uncompressed|2100000, lz4|30000`.

Warnings and errors seen:

- `NOTE restore_globals: psql:/dump/globals.sql:16: ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
- `ERROR:  role "postgres" already exists`
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
| postBySlug | 0.40 | 0.40 | 0.41 | 0.42 | 0.38 | 0.42 | 0.39 | 0.37 | 1.04 |
| docGet | 0.32 | 0.33 | 0.34 | 0.33 | 0.31 | 0.31 | 0.32 | 0.30 | 1.05 |
| listRecent | 0.74 | 0.73 | 0.74 | 0.81 | 0.70 | 0.72 | 0.70 | 0.71 | 1.00 |
| listCategory | 46.90 | 46.41 | 45.75 | 46.01 | 30.36 | 45.55 | 30.41 | 31.31 | 0.98 |
| listTag | 23.86 | 23.70 | 23.14 | 23.37 | 16.10 | 23.77 | 16.85 | 17.50 | 0.97 |
| popular | 140.28 | 139.31 | 137.66 | 137.93 | 85.46 | 140.60 | 89.50 | 89.52 | 0.98 |
| search100 | 4.26 | 4.47 | 4.28 | 4.26 | 3.67 | 4.28 | 3.68 | 3.98 | 1.00 |
| adminList | 1.42 | 1.47 | 1.31 | 1.29 | 1.07 | 1.29 | 1.06 | 1.13 | 0.92 |
| countPublished | 0.76 | 0.78 | 0.69 | 0.66 | 0.65 | 1.49 | 1.58 | 1.50 | 0.90 |
| eventsForPosts | 66.92 | 60.92 | 58.89 | 57.17 | 52.24 | 45.20 | 52.09 | 53.50 | 0.88 |
| subscriberLookup | 13.38 | 14.26 | 13.59 | 13.35 | 12.82 | 12.76 | 12.97 | 13.73 | 1.02 |
| viewIncrement | 1.56 | 1.59 | 1.55 | 1.52 | 1.44 | 1.45 | 1.45 | 1.55 | 0.99 |
| trackEvent | 1.26 | 1.35 | 1.23 | 1.27 | 1.27 | 1.27 | 1.31 | 1.33 | 0.98 |
| subscribe | 28.82 | 29.96 | 28.24 | 27.15 | 26.82 | 27.47 | 27.77 | 29.50 | 0.98 |
| *analytical (not an app query)* | 3261.5 | 3327.8 | 3293.1 | 3209.5 | 3162.0 | 3083.8 | 3436.3 | 3478.4 | 1.01 |

## Mixed workload, 8 clients (2 app instances × pool of 4)

| Variant | Throughput ops/s (median) | Per round | p50 ms | p95 ms | p99 ms | Errors |
|---|---|---|---|---|---|---|
| pg18 | 82 | 79.9, 72.9, 84, 87, 82 | 3.585 | 535.8 | 1010.551 | 0 |
| pg18-jit-off | 80.5 | 80.5, 68.4, 80, 85.4, 85.1 | 3.616 | 478.537 | 1009.206 | 0 |
| pg19-upgraded | 83.8 | 89.8, 71.2, 80.1, 85.5, 83.8 | 3.475 | 513.431 | 1005.024 | 0 |
| pg19-upgraded-jit-on | 82.6 | 82.6, 75.8, 82.2, 85.8, 88.3 | 3.462 | 516.499 | 1001.004 | 0 |
| pg19-restored | 138.3 | 138.3, 112.1, 140.3, 122.5, 140.6 | 3.138 | 373.987 | 583.786 | 0 |
| pg19-rewritten-pglz | 84.1 | 84.1, 73.8, 83.6, 88.2, 85 | 3.572 | 415.616 | 1009.042 | 0 |
| pg19-rewritten-lz4 | 129.9 | 138.2, 104, 129.9, 110.8, 138.2 | 3.387 | 391.95 | 602.271 | 0 |
| pg18-rewritten-lz4 | 105.1 | 99.8, 105.1, 120.2, 104.8, 125 | 4.16 | 495.813 | 696.711 | 0 |

Total errors across all benchmark runs: 0.

## Planner cost and JIT (jit_above_cost = 100000)

| Query | Plan cost on 18 | JIT fired on 18 (default on) | JIT fired on 19 with jit=on | JIT compile ms (18) |
|---|---|---|---|---|
| analytical | 914186 | yes | yes | 165.4 |
| postBySlug | 3 | no | no |  |
| docGet | 3 | no | no |  |
| listRecent | 29 | no | no |  |
| listCategory | 8 | no | no |  |
| listTag | 41 | no | no |  |
| popular | 48 | no | no |  |
| search100 | 29 | no | no |  |
| adminList | 310 | no | no |  |
| countPublished | 25 | no | no |  |
| eventsForPosts | 1150 | no | no |  |
| subscriberLookup | 88 | no | no |  |

## Reclaiming a bloated table while the app is under load

Open-loop load at 60 requests/s (write-heavy cases: double) through one app instance (pool of 4, 30 s statement timeout). Bloat template: 5407 MB on 18.

| Case | Runs | Duration s | Table MB before → after | WAL MB | Baseline p99 ms | During p50 / p99 / max ms | Requests >1 s | Failed requests | Peak extra disk MB | ACCESS EXCLUSIVE held ms | Time with blocked sessions ms | Command error |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pg18 VACUUM FULL | 3 | 19.94 | 5407 → 1468 | 1307 | 196.5 | 10016.83 / 10027.18 / 19988.46 | 1198 | 1715 | 1460 | 19904 | 19904 | none |
| pg18 control | 3 | 5.00 | 5407 → 5407 | 5 | 285.36 | 22.28 / 198.51 / 262.43 | 0 | 0 | 0 | 0 | 0 | none |
| pg19 VACUUM FULL | 3 | 16.73 | 5462 → 1504 | 1338 | 142.9 | 8823.28 / 10024.24 / 16769.91 | 1005 | 1207 | 1484 | 16708 | 16708 | none |
| pg19 REPACK | 3 | 16.08 | 5462 → 1504 | 1338 | 138.34 | 8578.13 / 10024.52 / 16097.62 | 966 | 1103 | 1503 | 16095 | 16095 | none |
| pg19 REPACK (CONCURRENTLY) | 3 | 34.62 | 5462 → 1503 | 1373 | 142.54 | 82.39 / 761.88 / 1024.4 | 2 | 0 | 1502 | 0 | 0 | none |
| pg19 control | 3 | 5.00 | 5462 → 5463 | 5 | 138.56 | 21.95 / 129.44 / 144.45 | 0 | 0 | 0 | 0 | 0 | none |
| pg19 REPACK (CONCURRENTLY), write-heavy | 3 | 17.84 | 5462 → 1508 | 1396 | 17.58 | 13.89 / 77.06 / 169.39 | 0 | 0 | 1508 | 0 | 0 | none |
| pg19 control, write-heavy | 3 | 5.00 | 5462 → 5464 | 21 | 17.16 | 13.05 / 17.02 / 18.29 | 0 | 0 | 2 | 0 | 0 | none |

Request error codes seen: timeout exceeded when trying to connect.

## INSERT … ON CONFLICT DO SELECT (19 RC 2)

- PostgreSQL 18.7: rejected: 42601 syntax error at or near "SELECT"
- 19 RC 2 correctness: existing row returned unchanged = true, new row inserted = true

Get-or-create, 5000 calls, 80% already exist, one client, on 19 RC 2:

| Approach | p50 ms | p95 ms | WAL bytes per call | Row updates caused |
|---|---|---|---|---|
| app today: SERIALIZABLE txn, SELECT then INSERT (5 round trips) | 0.774 | 1.596 | 2034 | 0 |
| classic: SELECT, then INSERT ON CONFLICT DO NOTHING | 0.309 | 0.873 | 2014 | 0 |
| hack: ON CONFLICT DO UPDATE SET data = existing (1 round trip, writes) | 0.453 | 1.275 | 15841 | 4000 |
| 19: ON CONFLICT DO SELECT (1 round trip, no write on hit) | 0.288 | 0.57 | 2031 | 0 |

Advice extensions available in the image: pg_stash_advice 1.0.

