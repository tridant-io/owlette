/**
 * A small in-memory Firestore for code whose correctness lives in its reads and
 * writes (the alert digest job): documents, subcollections, `==`/`<=` filters,
 * one orderBy, limit, batches with `create`, transactions, getAll and
 * recursiveDelete. Sentinels are the real `FieldValue`s and timestamps the real
 * `Timestamp`, so code under test runs unmodified.
 *
 * Transactions run one at a time, which is the isolation Firestore gives two
 * contending transactions: one commits, the other retries and sees its write.
 * `serverTimestamp()` resolves to `now()` plus one millisecond per write, so
 * later commits always carry later timestamps, as real commit times do.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

type Data = Record<string, unknown>;
type Op = '==' | '<=';

const isMap = (v: unknown): v is Data =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof FieldValue);

function compare(a: unknown, b: unknown): number {
  const n = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : (v as number));
  return n(a) - n(b);
}

/** a deep copy that keeps Timestamps (structuredClone would strip their class) */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function getPath(data: Data | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (isMap(v) ? v[k] : undefined), data);
}

export class MemoryFirestore {
  docs = new Map<string, Data>();
  now = () => Date.now();
  private tick = 0;
  private txQueue: Promise<unknown> = Promise.resolve();

  collection(path: string) {
    return new ColRef(this, path);
  }

  doc(path: string) {
    return new DocRef(this, path);
  }

  batch() {
    return new Batch(this);
  }

  async getAll(...refs: DocRef[]) {
    return refs.map((r) => this.snapshot(r.path));
  }

  async recursiveDelete(ref: DocRef) {
    for (const path of [...this.docs.keys()]) {
      if (path === ref.path || path.startsWith(`${ref.path}/`)) this.docs.delete(path);
    }
  }

  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.txQueue.then(async () => {
      const tx = new Transaction(this);
      const result = await fn(tx);
      tx.commit();
      return result;
    });
    this.txQueue = run.catch(() => undefined);
    return run;
  }

  /** a stored doc's data, or undefined */
  read(path: string): Data | undefined {
    return this.docs.get(path);
  }

  snapshot(path: string) {
    const data = this.docs.get(path);
    const ref = new DocRef(this, path);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      data: () => (data ? clone(data) : undefined),
      get: (field: string) => getPath(data, field),
    };
  }

  /** resolve sentinels; `merge` keeps the maps already stored */
  private resolve(value: unknown, base: unknown, merge: boolean): unknown {
    if (value instanceof FieldValue) {
      if (value.isEqual(FieldValue.serverTimestamp())) return Timestamp.fromMillis(this.now() + this.tick++);
      throw new Error('unsupported FieldValue');
    }
    if (!isMap(value)) return value;
    const out: Data = merge && isMap(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof FieldValue && v.isEqual(FieldValue.delete())) delete out[k];
      else out[k] = this.resolve(v, out[k], merge);
    }
    return out;
  }

  write(path: string, kind: 'set' | 'merge' | 'update' | 'create' | 'delete', data?: Data) {
    const existing = this.docs.get(path);
    if (kind === 'delete') {
      this.docs.delete(path);
      return;
    }
    if (kind === 'create' && existing) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    if (kind === 'update') {
      if (!existing) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      const next = clone(existing);
      for (const [field, v] of Object.entries(data ?? {})) {
        const keys = field.split('.');
        let target: Data = next;
        for (const k of keys.slice(0, -1)) {
          if (!isMap(target[k])) target[k] = {};
          target = target[k] as Data;
        }
        const last = keys[keys.length - 1];
        if (v instanceof FieldValue && v.isEqual(FieldValue.delete())) delete target[last];
        else target[last] = this.resolve(v, undefined, false);
      }
      this.docs.set(path, next);
      return;
    }
    this.docs.set(path, this.resolve(data, existing, kind === 'merge') as Data);
  }
}

class DocRef {
  constructor(private db: MemoryFirestore, readonly path: string) {}
  get id() {
    return this.path.split('/').pop()!;
  }
  get parent() {
    return new ColRef(this.db, this.path.split('/').slice(0, -1).join('/'));
  }
  collection(sub: string) {
    return new ColRef(this.db, `${this.path}/${sub}`);
  }
  async get() {
    return this.db.snapshot(this.path);
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    this.db.write(this.path, opts?.merge ? 'merge' : 'set', data);
  }
  async update(data: Data) {
    this.db.write(this.path, 'update', data);
  }
  async delete() {
    this.db.write(this.path, 'delete');
  }
}

class Query {
  constructor(
    protected db: MemoryFirestore,
    readonly path: string,
    private filters: [string, Op, unknown][] = [],
    private order: string | null = null,
    private max: number | null = null,
  ) {}
  where(field: string, op: Op, value: unknown) {
    return new Query(this.db, this.path, [...this.filters, [field, op, value]], this.order, this.max);
  }
  orderBy(field: string) {
    return new Query(this.db, this.path, this.filters, field, this.max);
  }
  limit(n: number) {
    return new Query(this.db, this.path, this.filters, this.order, n);
  }
  async get() {
    return this.run();
  }
  run() {
    const depth = this.path.split('/').length + 1;
    let paths = [...this.db.docs.keys()].filter((p) => p.startsWith(`${this.path}/`) && p.split('/').length === depth);
    paths = paths.filter((p) =>
      this.filters.every(([field, op, value]) => {
        const v = getPath(this.db.read(p), field);
        return op === '==' ? v === value : v !== undefined && compare(v, value) <= 0;
      }),
    );
    if (this.order) {
      const field = this.order;
      paths = paths.filter((p) => getPath(this.db.read(p), field) !== undefined);
      paths.sort((a, b) => compare(getPath(this.db.read(a), field), getPath(this.db.read(b), field)));
    }
    if (this.max !== null) paths = paths.slice(0, this.max);
    const docs = paths.map((p) => this.db.snapshot(p));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class ColRef extends Query {
  constructor(db: MemoryFirestore, path: string) {
    super(db, path);
  }
  get id() {
    return this.path.split('/').pop()!;
  }
  get parent() {
    const segments = this.path.split('/');
    return segments.length > 1 ? new DocRef(this.db, segments.slice(0, -1).join('/')) : null;
  }
  doc(id?: string) {
    return new DocRef(this.db, `${this.path}/${id ?? Math.random().toString(36).slice(2, 12)}`);
  }
  async add(data: Data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class Batch {
  private ops: [DocRef, 'set' | 'merge' | 'update' | 'create' | 'delete', Data | undefined][] = [];
  constructor(private db: MemoryFirestore) {}
  create(ref: DocRef, data: Data) {
    this.ops.push([ref, 'create', data]);
  }
  set(ref: DocRef, data: Data, opts?: { merge?: boolean }) {
    this.ops.push([ref, opts?.merge ? 'merge' : 'set', data]);
  }
  delete(ref: DocRef) {
    this.ops.push([ref, 'delete', undefined]);
  }
  async commit() {
    // all or nothing, like the real batch
    for (const [ref, kind] of this.ops) {
      if (kind === 'create' && this.db.read(ref.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    }
    for (const [ref, kind, data] of this.ops) this.db.write(ref.path, kind, data);
  }
}

class Transaction {
  private writes: [DocRef, 'set' | 'merge' | 'update', Data][] = [];
  constructor(private db: MemoryFirestore) {}
  async get(target: DocRef | Query) {
    return target instanceof DocRef ? this.db.snapshot(target.path) : target.run();
  }
  set(ref: DocRef, data: Data, opts?: { merge?: boolean }) {
    this.writes.push([ref, opts?.merge ? 'merge' : 'set', data]);
  }
  update(ref: DocRef, data: Data) {
    this.writes.push([ref, 'update', data]);
  }
  commit() {
    for (const [ref, kind, data] of this.writes) this.db.write(ref.path, kind, data);
  }
}
