# pg19-upgrade-lab

Measures what changes when a real app moves from PostgreSQL 18 to PostgreSQL 19.

> **Release status on 16 November 2026: PostgreSQL 19 is not generally available.** The latest official
> build is **19 RC 2** (12 November 2026, Docker tag `postgres:19rc2`). Every "19" number in this repo is
> RC 2, compared with **18.7** (`postgres:18.7`). Numbers must be re-run on 19.0 before being quoted as GA results.

The app is the blog next door (`../blog`). Its storage layer is one JSONB document table,
`blog_documents`, behind a Firestore-shaped query builder.

## What is real and what is synthetic

- **Schema**: `lab/sql/schema.sql` is copied from the blog's `db/migrations`.
- **Queries**: `vendor/blog-storage.mjs` is the blog's `src/lib/storage/postgres.ts`, bundled unchanged with
  esbuild. The workload calls it, so PostgreSQL receives the SQL the app really generates, through the same
  `pg` driver version and the same 4-connection pool. `npm run vendor` re-bundles; the self-test fails if the
  copy drifts from the blog source.
- **Data**: synthetic and deterministic (`lab/sql/seed.sql`). No production data is read or copied.
- **Operations** (`lab/workload.mjs`): the read and write paths the blog uses (post by slug, lists by date,
  category and tag, popular posts, counts, admin list, event lookups, subscriber lookup, view increment,
  event insert, subscribe). The mix weights are an assumption, not measured traffic.

## Commands

Needs Docker and Node 22. Nothing else is installed on the host.

```bash
npm install
```

```bash
npm run selftest
```

```bash
npm run pilot
```

On a laptop, keep it awake for the run (`caffeinate -i npm run pilot` on macOS). The harness detects a
sleeping or frozen host and discards those measurements, but a closed lid still wastes the run.

`npm run full` is the long run described in `PLAN.md`. A single stage can be re-run with
`node lab/run.mjs pilot --only=bench` (stages: `seed,upgrade,bench,maintenance,features`).
Results land in `results/<run>/`: `SUMMARY.md` (tables), one JSON file per stage, and `*-raw.json` with
every individual latency sample.

## How it measures

- One server container at a time (`--cpus 2 --memory 2g`), so the two versions never compete.
- Both versions get the same explicit settings (`lab/util.mjs`, `BASE_SETTINGS`). Everything else stays at
  each version's default, because changed defaults are part of what is being measured.
- Latency is wall-clock time around the app-level call, on the client (host Node process, through Docker
  Desktop's port forward).
- Maintenance tests use an open-loop load: requests arrive at a fixed rate and latency counts from the
  scheduled arrival time, so time spent queued behind a lock is included.
- Data is fingerprinted (per-collection md5) before and after every upgrade.

## Self-test

`npm run selftest` injects known effects and checks the harness reports them: a 50 ms server sleep, a 3 s
`ACCESS EXCLUSIVE` lock (and a control with none), a one-row data change, table bloat and its removal,
forced JIT, plus row-level correctness of the app queries, identical data and identical settings on both
versions, and vendored-code freshness.

## Cleaning up

Containers, volumes, the network and the local image all start with `pg19lab-`.
