# Results: PostgreSQL 18.7 → 19 RC 2 on the blog's workload

> **PostgreSQL 19 was not generally available when this ran (16 November 2026).** Every "19" number is
> **19 RC 2** (`postgres:19rc2`), compared with **18.7** (`postgres:18.7`). Rerun on 19.0 before quoting as GA.

Full tables: `results/full-2026-11-16/SUMMARY.md` (run 1) and `results/full/SUMMARY.md` (run 2). Raw samples: `*-raw.json` beside each. Reproduce: `npm run full`.

## Replication (17 November 2026)

The whole full run was repeated from scratch the next day with the same images (still RC 2; no
`postgres:19` or `19.0` image existed), in 2 h 35 min. Results: `results/full/`. No other containers were
running this time, though host load still peaked at 23 from other processes. The conclusions held.

| Measure | Run 1 (16 Nov) | Run 2 (17 Nov) |
|---|---|---|
| `pg_upgrade --link` / `--swap` downtime | 2.2 s / 2.2 s | 2.2 s / 2.2 s |
| `pg_upgrade --copy` downtime | 6.0 s | 5.1 s |
| Dump/restore downtime | 57.5 s | 58.2 s |
| Mixed throughput, 18.7 | 90 req/s | 82 req/s |
| Mixed throughput, 19 RC 2 after `pg_upgrade` | 92 req/s | 84 req/s |
| Mixed throughput, 19 RC 2 rewritten with pglz | 83 req/s | 84 req/s |
| Mixed throughput, 19 RC 2 rewritten with lz4 | 133 req/s | 130 req/s |
| Mixed throughput, 19 RC 2 after dump/restore | 128 req/s | 138 req/s |
| Mixed throughput, 18.7 rewritten with lz4 | 125 req/s | 105 req/s |
| Reporting query: 18 JIT on / 18 off / 19 off / 19 on | 3.33 / 3.20 / 3.26 / 3.26 s | 3.26 / 3.33 / 3.29 / 3.21 s |
| `VACUUM FULL` on 18.7: lock time, failed requests per run | 17.7 s, 456–561 | 19.9 s, 489–632 |
| `REPACK` on 19: lock time, failed requests per run | 16.7 s, 388–445 | 16.1 s, 360–382 |
| `REPACK (CONCURRENTLY)`: duration, p99, failed requests | 30.4 s, 0.57 s, 1 of 5,726 | 34.6 s, 0.76 s, 0 of 6,083 |
| `ON CONFLICT DO SELECT` p50 | 0.27 ms | 0.29 ms |

What changed between runs:
- The "document not found" error during `REPACK (CONCURRENTLY)` did not recur. Across both runs it is
  1 failed request in 11,809, so it is rare and still unexplained.
- 18.7 with lz4 was lower in run 2 (105 against 125 req/s) and its rounds varied widely (100–125). It is
  still clearly above pglz (80–84); whether it fully matches 19 with lz4 is less certain than run 1 suggested.
- The JIT ordering flipped between runs, which confirms those gaps are noise.

The sections below report run 1 (`results/full-2026-11-16/`).

Setup: the blog's real schema and storage layer, synthetic data (10,000 posts, 2,000,000 analytics events,
100,000 subscribers, 10,000 embeddings, 10,000 conversations; 3.1 GB table), server limited to 2 CPUs and
2 GB, same explicit settings on both versions, one server running at a time. The run took 2 h 40 min.
No measurement was taken while the host was stalled or asleep.

## 1. The upgrade

20 upgrades, all with byte-identical data afterwards and all 14 app operations working on 19 RC 2.

| Method | Downtime, median of 5 | Range |
|---|---|---|
| `pg_upgrade --link` | 2.2 s | 2.1–2.2 s |
| `pg_upgrade --swap` | 2.2 s | 2.1–2.2 s |
| `pg_upgrade --copy` | 6.0 s | 4.7–7.4 s |
| `pg_dump -Fd -j 2` + `pg_restore -j 2` | 57.5 s | 54.6–59.4 s |

- Planner statistics came across with `pg_upgrade`; no `ANALYZE` was needed before serving.
- The one step that would break the app: the new cluster gets a fresh `pg_hba.conf`. Copy the old one.
- Dump/restore prints `role "postgres" already exists` when restoring globals. Harmless.
- `pg_upgrade --check` passed on every run. Nothing in this schema hit the 19 incompatibility list.

## 2. Same data, 18.7 against 19 RC 2: no difference

Mixed workload, 8 clients, median of 5 rounds: **90 requests/s on 18.7, 92 on 19 RC 2**. Single-query p50
ratios (19/18) ran from 0.81 to 1.02, most within 5%. The 7% gain the pilot hinted at did not hold.

## 3. JIT off by default: no effect, even where JIT fires

- No app query comes near `jit_above_cost` (highest plan cost 1,140 against a threshold of 100,000). JIT
  never compiled anything for the app on 18, so turning it off changes nothing.
- The reporting-style aggregate I added (not an app query; plan cost 910,031) did trigger JIT on 18 and
  on 19 with `jit=on`. Median time: 3.33 s (18, JIT on), 3.20 s (18, JIT off), 3.26 s (19, off),
  3.26 s (19, on). Round-to-round spread was larger than any of those gaps. Compilation cost 170–220 ms.

## 4. The change that mattered: lz4 for large values (and you can have it on 18)

19 changes `default_toast_compression` from `pglz` to `lz4`. `pg_upgrade` keeps existing values as they
are, so an upgraded cluster gets none of it. The controls rewrote the large values in place with each
method and rebuilt the table, so the only difference between them is compression.

| Variant | Compression | Mixed workload, median (5 rounds) | `popular` p50 | `listCategory` p50 |
|---|---|---|---|---|
| 18.7 | pglz | 90 req/s | 139 ms | 47 ms |
| 19 RC 2 after `pg_upgrade` | pglz | 92 req/s | 139 ms | 46 ms |
| 19 RC 2, rewritten, table rebuilt | pglz | 83 req/s | 143 ms | 47 ms |
| 19 RC 2, rewritten, table rebuilt | lz4 | 133 req/s | 90 ms | 31 ms |
| 19 RC 2 after dump/restore | lz4 | 128 req/s | 86 ms | 31 ms |
| 18.7, rewritten, table rebuilt | lz4 | 125 req/s | 91 ms | 32 ms |

- lz4 gave about 40–60% more throughput on this workload, because the heavy list queries decompress many
  large documents. Rebuilding the table without changing compression gave nothing.
- It is not a 19 feature. 18.7 with lz4 performs the same. 19 only changes the default for new data.
- lz4 uses more disk for those values: TOAST 150 MB against 114 MB with pglz. The smaller table after
  dump/restore (2.6 GB against 3.1 GB) comes from rebuilt indexes, not from compression. (The pilot write-up
  got this wrong.)
- These documents are repetitive synthetic text. Real content will compress differently; the direction
  should hold, the size of the gain may not.

## 5. `REPACK (CONCURRENTLY)`

Bloated table of 5.4 GB, app requests arriving at 60/s through the app's 4-connection pool. 3 runs per case.

| Command | Duration | Size after | Requests that failed | p99 during | `ACCESS EXCLUSIVE` held |
|---|---|---|---|---|---|
| 18.7 `VACUUM FULL` | 17.7 s | 1.47 GB | 456–561 per run (about 45%) | 10.0 s | 17.6 s |
| 19 `VACUUM FULL` | 17.6 s | 1.50 GB | 390–657 per run | 10.0 s | 17.7 s |
| 19 `REPACK` | 16.7 s | 1.50 GB | 388–445 per run | 10.0 s | 16.8 s |
| 19 `REPACK (CONCURRENTLY)` | 30.4 s | 1.50 GB | 0, 0, 1 | 0.57 s | never seen (100 ms sampler) |
| no maintenance | | | 0 | 0.13–0.20 s | none |

- Plain `REPACK` is `VACUUM FULL` under a new name: the app is locked out for the whole run. Requests fail
  because the app's pool gives up waiting for a connection after 10 s.
- The concurrent form took 1.7× longer and slowed the app (p99 four times the idle value), but nothing
  stalled. With double the request rate and half of them writes, it still finished in 18 s with p99 64 ms.
- It needed no setup: default `wal_level=replica` worked. WAL written (1.37 GB) and peak extra disk
  (1.5 GB) were about the same as `VACUUM FULL`.
- **One request failed in a way that matters.** In one of three runs, a view-count update on an existing
  post returned "document not found", within about 100 ms of the end of the repack. That is 1 request in
  5,726. The docs say `REPACK (CONCURRENTLY)` is not MVCC-safe, and the app does its writes in SERIALIZABLE
  transactions, so a transaction that started before the final swap and read after it is the likely
  cause. I saw it once and did not prove the mechanism.

## 6. `INSERT … ON CONFLICT DO SELECT`

18.7 rejects the syntax. On 19 RC 2, get-or-create with 80% of keys already present (5,000 calls, one client):

| Approach | p50 | Row updates | WAL per call |
|---|---|---|---|
| App today: SERIALIZABLE transaction, read then insert | 0.81 ms | 0 | 2.0 kB |
| `SELECT`, then `INSERT … DO NOTHING` | 0.30 ms | 0 | 2.0 kB |
| `DO UPDATE SET data = existing` trick | 0.56 ms | 4,000 | 15.7 kB |
| 19: `DO SELECT` | 0.27 ms | 0 | 2.0 kB |

One statement, no needless row versions. Against the two-statement classic it is about the same speed; the
real gain is against the `DO UPDATE` trick.

## 7. Circulating claims that are wrong for 19 RC 2

- `GROUP BY ALL`: not present (syntax error).
- SQL/PGQ property graphs: not present (syntax error).
- "JIT removed": no. The library still ships in the image; only the default changed.
- `VACUUM FULL` and `CLUSTER` are kept, not removed.

## Limits

- RC 2, not GA. One laptop (Apple M5), Docker Desktop, 2-CPU container. Client latency includes Docker's port forward.
- Another lab started about 20 containers during the run; host load average ranged from 2.3 to 13.5. Medians
  absorb most of it, but individual rounds were visibly disturbed (see the per-round column in `SUMMARY.md`).
- Reduced from the plan to fit the time budget: 300 samples per operation instead of 600, 60 s mixed runs
  instead of 90 s, 3 maintenance repeats instead of 5.
- Not done: the `jit_above_cost` sweep, the 8-client `ON CONFLICT DO SELECT` test, any measurement of
  parallel autovacuum or `pg_plan_advice`.
- A few single-query numbers moved between variants with no explanation I can support (`eventsForPosts`
  43 ms and 33 ms on two variants against about 55 ms elsewhere; `countPublished` 1.5 ms on the rewritten
  clusters against 0.7 ms). The table is larger than memory, so cache state is the likely cause.
- Workload mix weights are an assumption. Production holds 37 documents; this data is far larger by design.
