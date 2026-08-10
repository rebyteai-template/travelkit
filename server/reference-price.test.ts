/**
 * The Ctrip comparison figure: the real SQL against a real SQLite, and the real route handlers.
 *
 * Both halves matter for the same reason. This number is one an operator quotes against, so the
 * failure that has to be impossible is a WRONG value landing in the table — a scrape that read
 * garbage, a stale figure that outlived the look that produced it, or one tenant's comparison
 * showing up under another's task. Everything below is aimed at those three.
 *
 * Run: node --import tsx --test server/reference-price.test.ts   (needs node >= 22.18 for node:sqlite)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'

import { createD1Store } from './store-d1.ts'
import { app } from './routes.ts'
import { formatActor } from './oauth.ts'
import type { Store, Task } from './store.ts'

const migration = (file: string): string => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')

const TENANT = formatActor('ORG42', 'EMP10086')
const OTHER_TENANT = formatActor('ORG42', 'EMP99999')
const TASK = 'task-1'
const PLAN = 'plan-1'

/** The slice of D1Database store-d1.ts uses, over node:sqlite — same shim as store-d1.test.ts.
 *  The point is that the SQL STRINGS are the production ones and SQLite is the real thing. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      const bound: unknown[] = []
      const self = {
        bind(...args: unknown[]) {
          bound.push(...args)
          return self
        },
        async run() {
          const { changes } = statement.run(...(bound as never[]))
          return { meta: { changes: Number(changes) } }
        },
        async first<T>() {
          return (statement.get(...(bound as never[])) as T | undefined) ?? null
        },
        async all<T>() {
          return { results: statement.all(...(bound as never[])) as T[] }
        },
      }
      return self
    },
  } as unknown as D1Database
}

function realStore(): Store {
  const db = new DatabaseSync(':memory:')
  db.exec(migration('0014_reference_price.sql'))
  return createD1Store(d1(db))
}

const price = (over: Partial<Parameters<Store['saveReferencePrice']>[3]> = {}) => ({
  amount: 397,
  currency: 'CNY',
  source: 'manual' as const,
  sourceUrl: null,
  capturedAt: '2026-08-09T03:30:00.000Z',
  ...over,
})

// ── storage ───────────────────────────────────────────────────────────────────

test('a saved comparison round-trips', async () => {
  const store = realStore()
  await store.saveReferencePrice(TENANT, TASK, PLAN, price(), null)

  const rows = await store.listReferencePrices(TENANT, TASK)
  assert.equal(rows.length, 1)
  assert.partialDeepStrictEqual(rows[0], {
    planId: PLAN,
    amount: 397,
    currency: 'CNY',
    source: 'manual',
    capturedAt: '2026-08-09T03:30:00.000Z',
  })
})

test('THE LAST LOOK WINS: re-comparing overwrites rather than accumulating', async () => {
  // OTA fares move. Keeping the history would leave older rows sitting next to the current one
  // with nothing marking which is live — and an operator may only act on the latest look.
  const store = realStore()
  await store.saveReferencePrice(TENANT, TASK, PLAN, price({ amount: 397 }), null)
  await store.saveReferencePrice(TENANT, TASK, PLAN, price({ amount: 452, source: 'ctrip-extension' }), '{"a":1}')

  const rows = await store.listReferencePrices(TENANT, TASK)
  assert.equal(rows.length, 1, 'one row per (tenant, task, plan)')
  assert.equal(rows[0]?.amount, 452)
  assert.equal(rows[0]?.source, 'ctrip-extension')
})

test('comparisons are scoped to their tenant and their task', async () => {
  const store = realStore()
  await store.saveReferencePrice(TENANT, TASK, PLAN, price({ amount: 397 }), null)
  await store.saveReferencePrice(OTHER_TENANT, TASK, PLAN, price({ amount: 999 }), null)
  await store.saveReferencePrice(TENANT, 'task-2', PLAN, price({ amount: 555 }), null)

  const mine = await store.listReferencePrices(TENANT, TASK)
  assert.deepEqual(mine.map((row) => row.amount), [397], 'neither the other tenant nor the other task leaks in')
})

// ── routes ────────────────────────────────────────────────────────────────────

/** Mounts the REAL route table with the two context vars the embed middleware would have set.
 *  `userEmail` is the tenant key `<org>:<uid>` (worker/app.ts), not an email. */
function harness(store: Store, tenant = TENANT) {
  const outer = new Hono()
  outer.use('*', async (c, next) => {
    c.set('userEmail' as never, tenant as never)
    c.set('store' as never, store as never)
    await next()
  })
  outer.route('/', app)
  return outer
}

/** A store whose only task belongs to TENANT, so ownership can actually be violated. */
function ownedStore(): { store: Store; saved: unknown[] } {
  const saved: unknown[] = []
  const real = realStore()
  const store = {
    async getTask(id: string): Promise<Task | undefined> {
      return id === TASK
        ? ({ id: TASK, project_id: 'default', status: 'idle', relay_task_id: null, user_email: TENANT, created_at: '', route_mode: '' } as Task)
        : undefined
    },
    async saveReferencePrice(...args: Parameters<Store['saveReferencePrice']>) {
      saved.push(args)
      return real.saveReferencePrice(...args)
    },
    listReferencePrices: real.listReferencePrices,
  } as unknown as Store
  return { store, saved }
}

const post = (harnessApp: Hono, body: unknown, task = TASK, plan = PLAN) =>
  harnessApp.request(`/tasks/${task}/plans/${plan}/reference-price`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const GOOD = { amount: 397, currency: 'CNY', source: 'manual' }

test('a well-formed comparison is accepted', async () => {
  const { store, saved } = ownedStore()
  const res = await post(harness(store), GOOD)
  assert.equal(res.status, 200)
  assert.equal(saved.length, 1)
})

test('a task the caller does not own is a 404, and writes nothing', async () => {
  const { store, saved } = ownedStore()
  // Same task id, different tenant — the tenant comes from the session, never the payload.
  const res = await post(harness(store, OTHER_TENANT), GOOD)
  assert.equal(res.status, 404)
  assert.equal(saved.length, 0)
})

test('an unknown task is a 404', async () => {
  const { store } = ownedStore()
  assert.equal((await post(harness(store), GOOD, 'task-nope')).status, 404)
})

test('UNUSABLE AMOUNTS ARE REFUSED: a bad scrape must not become a quotable price', async () => {
  const { store, saved } = ownedStore()
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001, '397', null]) {
    const res = await post(harness(store), { ...GOOD, amount })
    assert.equal(res.status, 400, `amount ${String(amount)} must be refused`)
  }
  assert.equal(saved.length, 0, 'nothing reached the store')
})

test('currency and source are closed sets', async () => {
  const { store } = ownedStore()
  for (const currency of ['cny', 'CNYY', '', 'C N', 42]) {
    assert.equal((await post(harness(store), { ...GOOD, currency })).status, 400, `currency ${String(currency)}`)
  }
  for (const source of ['scraped', '', 'MANUAL', null]) {
    assert.equal((await post(harness(store), { ...GOOD, source })).status, 400, `source ${String(source)}`)
  }
})

test('a sourceUrl that is not a Ctrip page is dropped, not stored', async () => {
  // The value is echoed back into the UI. Absent is fine; a link to somewhere else is not.
  const { store } = ownedStore()
  await post(harness(store), { ...GOOD, sourceUrl: 'https://evil.example/steal' })
  const [row] = await store.listReferencePrices(TENANT, TASK)
  assert.equal(row?.sourceUrl, null)

  await post(harness(store), { ...GOOD, sourceUrl: 'https://flights.ctrip.com/online/list/oneway-sha-bjs?depdate=2026-08-16' })
  const [updated] = await store.listReferencePrices(TENANT, TASK)
  assert.equal(updated?.sourceUrl, 'https://flights.ctrip.com/online/list/oneway-sha-bjs?depdate=2026-08-16')
})

test('an unparseable capturedAt falls back to now instead of rejecting a good price', async () => {
  const { store } = ownedStore()
  const res = await post(harness(store), { ...GOOD, capturedAt: 'sometime last tuesday' })
  assert.equal(res.status, 200)
  const [row] = await store.listReferencePrices(TENANT, TASK)
  assert.ok(row && !Number.isNaN(Date.parse(row.capturedAt)))
})

// ── the fail-closed gate between a scrape and a stored price ──────────────────

test('A DEGRADED CAPTURE YIELDS NO PRICE: the extension must never invent one', async () => {
  // The DOM parser itself is exercised against live Ctrip pages (four routes, see
  // ctrip-price-probe). What is checked here is the decision that follows it: anything short of
  // a clean read has to produce null, so the UI asks the operator to type the figure instead of
  // writing a number nobody verified.
  const { captureToPrice } = await import('../src/hooks/useCtripBridge.ts')
  const base = {
    url: 'https://flights.ctrip.com/online/list/oneway-sha-bjs?depdate=2026-08-16',
    capturedAt: '2026-08-09T03:30:00.000Z',
    strategy: 'flight-item' as const,
    blocked: false,
    count: 3,
    lowest: 397,
    calendar: [],
    flights: [],
  }

  assert.deepEqual(captureToPrice(base), { amount: 397, currency: 'CNY' }, 'a clean read yields the fare')
  assert.equal(captureToPrice({ ...base, blocked: true }), null, 'a challenge page yields nothing')
  assert.equal(captureToPrice({ ...base, lowest: null }), null, 'nothing parsed yields nothing')
  assert.equal(captureToPrice({ ...base, lowest: 0 }), null, 'a zero fare is a parse failure, not a bargain')
  assert.equal(captureToPrice({ ...base, lowest: -5 }), null, 'a negative fare is a parse failure')
})

test('the list endpoint is tenant-gated too', async () => {
  const { store } = ownedStore()
  await post(harness(store), GOOD)
  const mine = await harness(store).request(`/tasks/${TASK}/reference-prices`)
  assert.equal(mine.status, 200)
  assert.equal((await mine.json<{ referencePrices: unknown[] }>()).referencePrices.length, 1)

  assert.equal((await harness(store, OTHER_TENANT).request(`/tasks/${TASK}/reference-prices`)).status, 404)
})
