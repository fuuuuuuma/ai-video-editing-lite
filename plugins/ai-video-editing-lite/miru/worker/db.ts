// D1 のうち使う所だけ（@cloudflare/workers-types を入れずに型を確かめるため）と、
// 検査で同じ SQL を手元の SQLite（node:sqlite）で動かす入れ物。

export type D1Result<T> = { results?: T[]; meta?: { changes?: number } };
export type D1Stmt = {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<D1Result<unknown>>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
export type D1Database = {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<D1Result<unknown>[]>;
};

export type User = { id: string; email: string; name: string; picture: string };

export async function one<T>(db: D1Database, sql: string, ...v: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...v).first<T>();
}
export async function many<T>(db: D1Database, sql: string, ...v: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...v).all<T>()).results ?? [];
}
export async function exec(db: D1Database, sql: string, ...v: unknown[]): Promise<number> {
  return (await db.prepare(sql).bind(...v).run()).meta?.changes ?? 0;
}

/** 検査用: node:sqlite の DatabaseSync を D1 の形で包む（同じ migrations を当てる） */
export function d1FromSqlite(sqlite: {
  prepare(sql: string): { run(...v: unknown[]): { changes: number | bigint }; get(...v: unknown[]): unknown; all(...v: unknown[]): unknown[] };
}): D1Database {
  // D1 は ?1 ?2 … の番号付き。node:sqlite も ?NNN を受ける
  const conv = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  const stmt = (sql: string, args: unknown[] = []): D1Stmt => ({
    bind: (...v: unknown[]) => stmt(sql, v.map(conv)),
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    async first<T>() { return (sqlite.prepare(sql).get(...args) as T) ?? null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...args) as T[] }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}
