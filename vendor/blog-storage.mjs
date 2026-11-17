// ../blog/src/lib/storage/postgres.ts
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";

// ../blog/src/lib/storage/values.ts
var Timestamp = class _Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    if (!Number.isSafeInteger(seconds) || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= 1e9) throw new Error("Invalid timestamp");
  }
  static now() {
    return _Timestamp.fromMillis(Date.now());
  }
  static fromDate(value) {
    return _Timestamp.fromMillis(value.getTime());
  }
  static fromMillis(value) {
    const seconds = Math.floor(value / 1e3);
    return new _Timestamp(seconds, Math.floor((value - seconds * 1e3) * 1e6));
  }
  toMillis() {
    return this.seconds * 1e3 + this.nanoseconds / 1e6;
  }
  toDate() {
    return new Date(this.toMillis());
  }
  isEqual(other) {
    return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds;
  }
  toJSON() {
    return { _seconds: this.seconds, _nanoseconds: this.nanoseconds };
  }
};
var FieldTransform = class {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }
};
var FieldValue = {
  increment: (value) => new FieldTransform("increment", value),
  delete: () => new FieldTransform("delete"),
  arrayUnion: (...values) => new FieldTransform("arrayUnion", values),
  serverTimestamp: () => new FieldTransform("serverTimestamp")
};
var FieldPath = { documentId: () => "__name__" };
function encode(value) {
  if (value === void 0) throw new Error("Undefined cannot be stored");
  if (value instanceof Date) return encode(Timestamp.fromDate(value));
  if (value instanceof Timestamp) return { __blogTimestamp: true, seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof FieldTransform) throw new Error("Field transform outside a write");
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Unsupported stored object");
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0).map(([key, item]) => [key, encode(item)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite numbers cannot be stored");
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw new Error("Unsupported stored value");
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const item = value;
    if (item.__blogTimestamp === true) return new Timestamp(Number(item.seconds), Number(item.nanoseconds));
    return Object.fromEntries(Object.entries(item).map(([key, field2]) => [key, decode(field2)]));
  }
  return value;
}

// ../blog/src/lib/storage/postgres.ts
function parts(path) {
  const fields = path.split(".");
  if (fields.some((field2) => !field2 || ["__proto__", "constructor", "prototype"].includes(field2))) throw new Error("Invalid field path");
  return fields;
}
function field(data, path) {
  return parts(path).reduce((value, key) => value?.[key], data);
}
function assign(data, path, value) {
  const keys = parts(path), key = keys.pop();
  let parent = data;
  for (const segment of keys) {
    if (!parent[segment] || typeof parent[segment] !== "object" || Array.isArray(parent[segment])) parent[segment] = {};
    parent = parent[segment];
  }
  if (value instanceof FieldTransform && value.kind === "delete") delete parent[key];
  else parent[key] = value;
}
function same(a, b) {
  if (a instanceof Timestamp && b instanceof Timestamp) return a.isEqual(b);
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aa = Object.entries(a), bb = Object.entries(b);
  return aa.length === bb.length && aa.every(([key, value]) => Object.prototype.hasOwnProperty.call(b, key) && same(value, b[key]));
}
function transform(value, old) {
  if (value instanceof FieldTransform) {
    if (value.kind === "increment") return (typeof old === "number" ? old : 0) + Number(value.value);
    if (value.kind === "serverTimestamp") return Timestamp.now();
    if (value.kind === "arrayUnion") {
      const array = Array.isArray(old) ? [...old] : [];
      for (const item of value.value) if (!array.some((existing) => same(existing, item))) array.push(item);
      return array;
    }
    return value;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const [key, item] of Object.entries(value)) assign(result, key, transform(item, old?.[key]));
    return result;
  }
  return value;
}
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length) {
      const prior = target[key];
      const child = prior && Object.getPrototypeOf(prior) === Object.prototype ? prior : {};
      merge(child, value);
      assign(target, key, child);
    } else assign(target, key, transform(value, target[key]));
  }
}
function validatePath(path, document) {
  const segments = path.split("/");
  if (segments.some((s) => !s || s === "." || s === ".." || s.includes("\0")) || segments.length % 2 === 0 !== document) throw new Error("Invalid document/collection path");
  return path;
}
var DocumentSnapshot = class {
  constructor(ref, value) {
    this.ref = ref;
    this.value = value;
    this.id = ref.id;
  }
  get exists() {
    return this.value !== void 0;
  }
  data() {
    return this.value === void 0 ? void 0 : decode(encode(this.value));
  }
  get(path) {
    const value = field(this.value, path);
    return value === void 0 ? void 0 : decode(encode(value));
  }
};
var QueryDocumentSnapshot = class extends DocumentSnapshot {
  data() {
    return super.data();
  }
};
var QuerySnapshot = class {
  constructor(docs) {
    this.docs = docs;
  }
  get size() {
    return this.docs.length;
  }
  get empty() {
    return !this.docs.length;
  }
  forEach(fn) {
    this.docs.forEach(fn);
  }
};
var Query = class _Query {
  constructor(database2, path, filters = [], orders = [], take, cursor, fields, group = false) {
    this.database = database2;
    this.path = path;
    this.filters = filters;
    this.orders = orders;
    this.take = take;
    this.cursor = cursor;
    this.fields = fields;
    this.group = group;
    validatePath(path, false);
  }
  where(field2, op, value) {
    if (!["==", "!=", ">", ">=", "<", "<=", "in", "not-in", "array-contains", "array-contains-any"].includes(op)) throw new Error("Unsupported query operator");
    return new _Query(this.database, this.path, [...this.filters, { field: field2, op, value }], this.orders, this.take, this.cursor, this.fields, this.group);
  }
  /** Match legacy email identities without guessing casing or dropping duplicate records. */
  whereNormalizedEmail(email) {
    if (!email.trim()) throw new Error("Email is required");
    return new _Query(this.database, this.path, [...this.filters, { field: "email", op: "normalized-email", value: email.trim().toLowerCase() }], this.orders, this.take, this.cursor, this.fields, this.group);
  }
  orderBy(field2, direction = "asc") {
    if (!["asc", "desc"].includes(direction)) throw new Error("Invalid ordering");
    return new _Query(this.database, this.path, this.filters, [...this.orders, { field: field2, direction }], this.take, this.cursor, this.fields, this.group);
  }
  limit(take) {
    if (!Number.isSafeInteger(take) || take < 1) throw new Error("Invalid query limit");
    return new _Query(this.database, this.path, this.filters, this.orders, take, this.cursor, this.fields, this.group);
  }
  startAfter(...cursor) {
    return new _Query(this.database, this.path, this.filters, this.orders, this.take, cursor, this.fields, this.group);
  }
  select(...fields) {
    fields.forEach(parts);
    return new _Query(this.database, this.path, this.filters, this.orders, this.take, this.cursor, fields, this.group);
  }
  async get() {
    return this.read(this.database.pool);
  }
  count() {
    return { get: async () => {
      const { sql, args } = this.statement(true);
      const result = await this.database.pool.query(`SELECT count(*) AS n FROM (${sql}) AS records`, args);
      return { data: () => ({ count: Number(result.rows[0].n) }) };
    } };
  }
  stream() {
    return Readable.from(this.iterate());
  }
  async *iterate() {
    let cursor;
    let remaining = this.take ?? Infinity;
    while (remaining > 0) {
      const page = await (cursor ? this.startAfter(cursor) : this).limit(Math.min(200, remaining)).get();
      if (page.empty) return;
      for (const doc of page.docs) yield doc;
      remaining -= page.size;
      cursor = page.docs[page.docs.length - 1];
    }
  }
  statement(count = false) {
    const args = [this.database.namespace, this.path];
    const param = (value) => {
      args.push(value);
      return `$${args.length}`;
    };
    const raw = (name) => {
      const path = parts(name);
      return path.length === 1 ? `(data -> ${param(path[0])}::text)` : `(data #> ${param(path)}::text[])`;
    };
    const expression = (name, sorted = true) => name === "__name__" ? `${this.group ? "path" : "id"} COLLATE "C"` : sorted ? `blog_sort_value(${raw(name)})` : raw(name);
    const operand = (value, name, sorted = true) => {
      if (name === "__name__") {
        if (typeof value !== "string") throw new Error("Document ID must be a string");
        return `${param(value)}::text COLLATE "C"`;
      }
      const json = `${param(JSON.stringify(encode(value)))}::jsonb`;
      return sorted ? `blog_sort_value(${json})` : json;
    };
    const conditions = ["namespace = $1", this.group ? "regexp_replace(collection_path, '^.*/', '') = $2" : "collection_path = $2"];
    for (const filter of this.filters) {
      if (filter.op === "normalized-email") {
        conditions.push(`lower(btrim(data ->> 'email')) = ${param(filter.value)}::text`);
        continue;
      }
      const values = ["in", "not-in"].includes(filter.op) && Array.isArray(filter.value) ? filter.value : [filter.value];
      const sorted = !(["==", "!=", "in", "not-in"].includes(filter.op) && values.every((value) => value === null || ["string", "boolean"].includes(typeof value)));
      const lhs = expression(filter.field, sorted);
      const rhs = (value) => operand(value, filter.field, sorted);
      if (["in", "not-in", "array-contains-any"].includes(filter.op)) {
        if (!Array.isArray(filter.value) || !filter.value.length) throw new Error("Query requires a nonempty array");
        const alternatives = filter.value.map((value) => filter.op === "array-contains-any" ? `${lhs} @> ${rhs([value])}` : `${lhs} = ${rhs(value)}`);
        conditions.push(`${filter.op === "not-in" ? "NOT " : ""}(${alternatives.join(" OR ")})`);
      } else if (filter.op === "array-contains") conditions.push(`${lhs} @> ${rhs([filter.value])}`);
      else conditions.push(`${lhs} ${{ "==": "=", "!=": "<>" }[filter.op] || filter.op} ${rhs(filter.value)}`);
      if (filter.field !== "__name__" && parts(filter.field).length === 1) {
        const indexed = ["state", "status", "dedupeKey", "domain", "websiteId", "campaignId"];
        let candidates = [];
        if (filter.op === "==" && !sorted && !indexed.includes(filter.field)) candidates = [filter.value];
        if (filter.op === "array-contains") candidates = [[filter.value]];
        if (filter.op === "array-contains-any") candidates = filter.value.map((value) => [value]);
        if (candidates.length) conditions.push(`(${candidates.map((value) => `data @> ${param(JSON.stringify({ [filter.field]: encode(value) }))}::jsonb`).join(" OR ")})`);
      }
    }
    const orders = [...this.orders];
    if (!orders.some((order) => order.field === "__name__")) orders.push({ field: "__name__", direction: orders.at(-1)?.direction || "asc" });
    const expressions = orders.map((order) => expression(order.field));
    for (const expr of expressions) conditions.push(`${expr} IS NOT NULL`);
    if (this.cursor) {
      const snapshot = this.cursor[0] instanceof DocumentSnapshot ? this.cursor[0] : null;
      if (snapshot && (!snapshot.exists || !this.group && snapshot.ref.parent.path !== this.path)) throw new Error("Invalid cursor document");
      const values = snapshot ? orders.map((order) => order.field === "__name__" ? this.group ? snapshot.ref.path : snapshot.id : snapshot.get(order.field)) : this.cursor;
      if (!values.length || values.length > orders.length || values.some((value) => value === void 0)) throw new Error("Invalid query cursor");
      const operands = values.map((value, i) => operand(value, orders[i].field));
      if (orders.slice(0, values.length).every((order) => order.direction === orders[0].direction)) {
        conditions.push(`(${expressions.slice(0, values.length).join(", ")}) ${orders[0].direction === "desc" ? "<" : ">"} (${operands.join(", ")})`);
      } else conditions.push(`(${values.map((_, i) => `(${[...expressions.slice(0, i).map((expr, j) => `${expr} = ${operands[j]}`), `${expressions[i]} ${orders[i].direction === "desc" ? "<" : ">"} ${operands[i]}`].join(" AND ")})`).join(" OR ")})`);
    }
    let projection = "data";
    if (!count && this.fields) {
      const fields = this.fields.map((name) => {
        const [root, ...tail] = parts(name);
        return { name, root, tail };
      });
      projection = fields.length ? `COALESCE((SELECT jsonb_object_agg(p.name, e.value #> p.tail)
                FROM jsonb_each(data) e JOIN jsonb_to_recordset(${param(JSON.stringify(fields))}::jsonb) AS p(name text, root text, tail text[]) ON e.key=p.root
                WHERE e.value #> p.tail IS NOT NULL), '{}'::jsonb) AS data` : "'{}'::jsonb AS data";
    }
    return { sql: `SELECT ${count ? "1" : `path, ${projection}`} FROM blog_documents WHERE ${conditions.join(" AND ")}${count ? "" : ` ORDER BY ${expressions.map((expr, i) => `${expr} ${orders[i].direction}`).join(", ")}`}${this.take ? ` LIMIT ${param(this.take)}` : ""}`, args };
  }
  async read(sql) {
    const statement = this.statement();
    const result = await sql.query(statement.sql, statement.args);
    return new QuerySnapshot(result.rows.map((row) => {
      const data = decode(row.data);
      const selected = {};
      if (this.fields) for (const name of this.fields) {
        const value = data[name];
        if (value !== void 0) assign(selected, name, value);
      }
      return new QueryDocumentSnapshot(this.database.doc(row.path), this.fields ? selected : data);
    }));
  }
};
var CollectionReference = class extends Query {
  get parent() {
    const slash = this.path.lastIndexOf("/");
    return slash < 0 ? null : this.database.doc(this.path.slice(0, slash));
  }
  get id() {
    return this.path.split("/").at(-1);
  }
  doc(id = randomBytes(15).toString("base64url")) {
    if (!id || id.includes("/")) throw new Error("Invalid document ID");
    return this.database.doc(`${this.path}/${id}`);
  }
  async add(data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
};
var DocumentReference = class {
  constructor(database2, path) {
    this.database = database2;
    this.path = path;
    validatePath(path, true);
    this.id = path.split("/").at(-1);
  }
  get parent() {
    return this.database.collection(this.path.slice(0, this.path.lastIndexOf("/")));
  }
  collection(name) {
    return this.database.collection(`${this.path}/${name}`);
  }
  async get() {
    return this.read(this.database.pool);
  }
  async read(sql) {
    const result = await sql.query("SELECT data FROM blog_documents WHERE namespace = $1 AND path = $2", [this.database.namespace, this.path]);
    return new DocumentSnapshot(this, result.rows.length ? decode(result.rows[0].data) : void 0);
  }
  set(data, options) {
    return this.database.runTransaction(async (tx) => {
      tx.set(this, data, options);
    });
  }
  update(data) {
    return this.database.runTransaction(async (tx) => {
      tx.update(this, data);
    });
  }
  create(data) {
    return this.database.runTransaction(async (tx) => {
      tx.create(this, data);
    });
  }
  delete() {
    return this.database.runTransaction(async (tx) => {
      tx.delete(this);
    });
  }
};
var Transaction = class {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.writes = [];
  }
  get(ref) {
    if (this.writes.length) throw new Error("Read before writes inside a transaction");
    if (ref.database !== this.db) throw new Error("Cross-database transaction");
    return ref.read(this.sql);
  }
  getAll(...refs) {
    if (this.writes.length) throw new Error("Read before writes inside a transaction");
    return this.db.readAll(this.sql, refs);
  }
  set(ref, data, options) {
    this.writes.push({ ref, kind: "set", data, merge: options?.merge });
    return this;
  }
  create(ref, data) {
    this.writes.push({ ref, kind: "create", data });
    return this;
  }
  update(ref, data) {
    this.writes.push({ ref, kind: "update", data });
    return this;
  }
  delete(ref) {
    this.writes.push({ ref, kind: "delete" });
    return this;
  }
  async flush() {
    for (const write of this.writes) {
      if (write.ref.database !== this.db) throw new Error("Cross-database write");
      const { ref } = write;
      if (write.kind === "delete") {
        await this.sql.query("DELETE FROM blog_documents WHERE namespace = $1 AND path = $2", [this.db.namespace, ref.path]);
        continue;
      }
      const existing = await ref.read(this.sql);
      if (write.kind === "create" && existing.exists) throw Object.assign(new Error("Document already exists"), { code: 6 });
      if (write.kind === "update" && !existing.exists) throw Object.assign(new Error("Document not found"), { code: 5 });
      let next = existing.data() || {};
      if (write.kind === "update") for (const [key, value] of Object.entries(write.data)) assign(next, key, transform(value, field(next, key)));
      else if (write.merge) merge(next, write.data);
      else next = transform(write.data, next);
      await this.sql.query(
        `INSERT INTO blog_documents(namespace,path,collection_path,id,data) VALUES($1,$2,$3,$4,$5::jsonb)
                ON CONFLICT(namespace,path) DO UPDATE SET data=EXCLUDED.data,version=blog_documents.version+1,updated_at=clock_timestamp()`,
        [this.db.namespace, ref.path, ref.parent.path, ref.id, JSON.stringify(encode(next))]
      );
    }
  }
};
var Database = class {
  constructor(url, namespace = process.env.BLOG_DATABASE_NAMESPACE || "blog") {
    this.url = url;
    this.namespace = namespace;
  }
  get pool() {
    if (!this.connection) {
      const connectionString = this.url || process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL is required; Firestore fallback is disabled");
      this.connection = new Pool({
        connectionString,
        max: 4,
        idleTimeoutMillis: 1e4,
        connectionTimeoutMillis: 1e4,
        statement_timeout: 3e4,
        idle_in_transaction_session_timeout: 3e4,
        allowExitOnIdle: true
      });
      this.connection.on("error", () => {
        console.error("PostgreSQL idle connection failed");
      });
    }
    return this.connection;
  }
  doc(path) {
    return new DocumentReference(this, path);
  }
  collection(path) {
    return new CollectionReference(this, path);
  }
  collectionGroup(id) {
    if (id.includes("/")) throw new Error("Invalid collection group");
    return new Query(this, id, [], [], void 0, void 0, void 0, true);
  }
  getAll(...refs) {
    return refs.length ? this.readAll(this.pool, refs) : Promise.resolve([]);
  }
  async readAll(sql, refs) {
    if (refs.some((ref) => ref.database !== this)) throw new Error("Cross-database read");
    if (!refs.length) return [];
    const result = await sql.query(`SELECT requested.ordinal, d.data
            FROM unnest($2::text[]) WITH ORDINALITY AS requested(path, ordinal)
            LEFT JOIN blog_documents d ON d.namespace=$1 AND d.path=requested.path
            ORDER BY requested.ordinal`, [this.namespace, refs.map((ref) => ref.path)]);
    return result.rows.map((row, index) => new DocumentSnapshot(refs[index], row.data === null ? void 0 : decode(row.data)));
  }
  async runTransaction(fn) {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const tx = new Transaction(this, client);
        const result = await fn(tx);
        await tx.flush();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => void 0);
        if (attempt >= 9 || !["40001", "40P01"].includes(String(error.code))) throw error;
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, 5 * 2 ** attempt) + Math.random() * 20));
    }
  }
  batch() {
    const operations = [];
    const batch = {
      set: (ref, data, options) => {
        operations.push((tx) => tx.set(ref, data, options));
        return batch;
      },
      create: (ref, data) => {
        operations.push((tx) => tx.create(ref, data));
        return batch;
      },
      update: (ref, data) => {
        operations.push((tx) => tx.update(ref, data));
        return batch;
      },
      delete: (ref) => {
        operations.push((tx) => tx.delete(ref));
        return batch;
      },
      commit: () => this.runTransaction(async (tx) => {
        operations.forEach((operation) => operation(tx));
      })
    };
    return batch;
  }
  async recursiveDelete(ref) {
    if (ref.database !== this) throw new Error("Cross-database delete");
    await this.pool.query("DELETE FROM blog_documents WHERE namespace=$1 AND (path=$2 OR starts_with(path,$2 || '/'))", [this.namespace, ref.path]);
  }
  async terminate() {
    await this.connection?.end();
    this.connection = void 0;
  }
};
var database = new Database();
var getFirestore = () => database;
export {
  CollectionReference,
  Database,
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  FieldValue,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Timestamp,
  Transaction,
  database,
  getFirestore
};
