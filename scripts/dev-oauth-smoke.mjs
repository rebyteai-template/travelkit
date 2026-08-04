// End-to-end check of the delegated-credential Authorization Server against a REAL `wrangler dev`.
// server/oauth.test.ts covers the contract and worker/app.test.ts the composition root; what only
// THIS can cover is the actual D1 driver — the SQL in store-d1.ts, and the migrations behind it.
//
//   pnpm db:migrate:local   # once, for migrations/0007 + 0008
//   pnpm smoke:oauth        # starts its own wrangler dev; nothing else needs to be running
//
// It never touches the relay, a sandbox or Simplifly: the credential is persisted by a mutating
// request that does no VM work (POST /api/app/debug/config with an empty patch). Keys and client
// credentials are generated per run and passed as `--var`, so no secret is read, written or
// printed. It leaves one tenant_credentials row for the SMOKE tenant in the local D1.
import { spawn } from 'node:child_process'
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose'

const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`
const RESOURCE = 'https://simplifly-mcp.impo.ai/mcp'
const CLIENT_ID = 'smoke-relay'
const CLIENT_SECRET = 'a'.repeat(64)
const SERVICE_TOKEN = 'b'.repeat(64)
// A tenant that cannot collide with a real dev mapping.
const ORG = 'SMOKE-ORG'
const UID = 'smoke-uid'
const ACTOR = `${ORG}:${UID}`
const HANDOFF_TOKEN = `TK_smoke_${Date.now()}`

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `\n         期望 ${expected}，实际 ${actual}`}`)
}

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
const kid = await calculateJwkThumbprint(await exportJWK(publicKey))
const signingKey = JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid })

const worker = spawn('npx', [
  'wrangler', 'dev', '--port', String(PORT),
  '--var', `OAUTH_SIGNING_KEY:${signingKey}`,
  '--var', `OAUTH_ISSUER:${BASE}`,
  '--var', `RELAY_CLIENT_ID:${CLIENT_ID}`,
  '--var', `RELAY_CLIENT_SECRET:${CLIENT_SECRET}`,
  '--var', `TRIPDESK_SERVICE_TOKEN:${SERVICE_TOKEN}`,
], { stdio: ['ignore', 'pipe', 'pipe'] })

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('wrangler dev 启动超时')), 90_000)
  const watch = (chunk) => {
    if (chunk.toString().includes('Ready on')) { clearTimeout(timer); resolve() }
  }
  worker.stdout.on('data', watch)
  worker.stderr.on('data', watch)
})

const basic = (secret) => `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString('base64')}`
const postToken = (actor, secret = CLIENT_SECRET, resource = RESOURCE) =>
  fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basic(secret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', actor, resource }).toString(),
  })
const postCredential = (tenant, token = SERVICE_TOKEN) =>
  fetch(`${BASE}/internal/simplifly-credential`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(tenant),
  })
const embed = (token) => ({ 'X-Tenant-Uid': UID, 'X-Tenant-Org': ORG, 'X-Travelkit-Token': token })
// A request that DOES something (empty config patch → no rows written, no VM, no relay call).
// Only a mutating request refreshes the stored credential — a read must not be able to.
const handoff = (token) =>
  fetch(`${BASE}/api/app/debug/config`, {
    method: 'POST',
    headers: { ...embed(token), 'Content-Type': 'application/json' },
    body: '{}',
  })
const read = (token) => fetch(`${BASE}/api/app/me`, { headers: embed(token) })

try {
  await ready
  console.log(`Worker 已起：${BASE}\n`)

  console.log('iframe handoff 落库（PLAN §4.3：每个请求覆盖一次，不判有效性）')
  const me = await handoff(HANDOFF_TOKEN)
  check('POST /api/app/debug/config → 200', me.status, 200)
  check('租户键 = <org>:<uid>', (await read(HANDOFF_TOKEN)).status, 200)

  console.log('\n发现端点没有被 SPA catch-all 吃掉')
  const meta = await fetch(`${BASE}/.well-known/oauth-authorization-server`)
  check('metadata → 200', meta.status, 200)
  const metaBody = await meta.json()
  check('token_endpoint', metaBody.token_endpoint, `${BASE}/oauth/token`)
  check('故意不公布 refresh_token', JSON.stringify(metaBody).includes('refresh_token'), false)
  const jwks = await (await fetch(`${BASE}/.well-known/jwks.json`)).json()
  check('JWKS 一把钥匙', jwks.keys.length, 1)
  check('kid 对得上', jwks.keys[0].kid, kid)
  check('JWKS 不含私钥分量', JSON.stringify(jwks).includes('"d"'), false)
  // 反向：挂 AS 不能把 SPA 兜底吃掉。
  const spa = await fetch(`${BASE}/`)
  check('/ 仍然是 SPA', (await spa.text()).includes('<!doctype html'), true)
  // 反向的反向：AS 自己的路径上，非法方法要 405，不能掉进 SPA 兜底回一个「健康」的 200 HTML。
  check('GET /oauth/token → 405', (await fetch(`${BASE}/oauth/token`)).status, 405)

  console.log('\n① 身份断言（消费方是 mcp/src/mcp/auth.ts，逐项照它验）')
  const granted = await postToken(ACTOR)
  check('POST /oauth/token → 200', granted.status, 200)
  const grant = await granted.json()
  check('token_type', grant.token_type, 'Bearer')
  const { payload, protectedHeader } = await jwtVerify(grant.access_token, await createLocalJWKSet(jwks), {
    issuer: BASE, audience: RESOURCE, algorithms: ['ES256', 'ES384', 'RS256', 'RS384', 'PS256'],
    clockTolerance: 30, requiredClaims: ['exp'],
  })
  check('alg 非对称', protectedHeader.alg, 'ES256')
  check('aud 逐字等于 canonical resource', payload.aud, RESOURCE)
  check('org claim', payload.org, ORG)
  check('uid claim', payload.uid, UID)
  check('sub 原样带回 actor', payload.sub, ACTOR)
  check('带 exp', typeof payload.exp, 'number')

  console.log('\n错误码（选错会把「该重开 iframe」变成「无限重试」，或者反过来）')
  // 400 只留给 invalid_grant：它是唯一「员工自己能解决」且不可重试的答案。
  // 这一条同时是**真 D1 上写探针**的证据：miss 路径会先真写一次 tenant_credentials
  // （store-d1.ts::probeCredentialStore），写不进就该是 503。所以这里拿到 400 才算探针本身是通的。
  // 反方向（迁移只上了一半 → SELECT 通、写不通 → 必须 503）在 server/store-d1.test.ts 里对真 SQLite 跑。
  const unknownActor = await postToken(`${ORG}:nobody`)
  check('actor 无凭证 → 400（顺带证明写探针在真 D1 上是通的）', unknownActor.status, 400)
  check('… invalid_grant（不可重试）', (await unknownActor.json()).error, 'invalid_grant')
  const badClient = await postToken(ACTOR, 'wrong-secret')
  check('客户端凭证不对 → 401', badClient.status, 401)
  check('… invalid_client（运维错，可重试）', (await badClient.json()).error, 'invalid_client')
  const foreign = await postToken(ACTOR, CLIENT_SECRET, 'https://someone-else.example.com/mcp')
  check('给别家 MCP 要 token → 500（运维带，不是用户带）', foreign.status, 500)
  check('… invalid_target', (await foreign.json()).error, 'invalid_target')
  // 注册 URL 多一个尾斜杠是最容易踩的一脚：以前它让每个员工永久看到「请重开 FlyAI」。
  const slashed = await postToken(ACTOR, CLIENT_SECRET, `${RESOURCE}/`)
  check('resource 多一个尾斜杠仍然签得出来 → 200', slashed.status, 200)
  const slashedClaims = await jwtVerify((await slashed.json()).access_token, await createLocalJWKSet(jwks), {
    issuer: BASE, audience: RESOURCE, algorithms: ['ES256'], clockTolerance: 30, requiredClaims: ['exp'],
  })
  check('… 而且 aud 是 canonical 的那个（对面逐字比）', slashedClaims.payload.aud, RESOURCE)

  console.log('\n② 真正的凭证（relay 永远看不到这一跳）')
  const cred = await postCredential({ org: payload.org, uid: payload.uid })
  check('服务凭证 → 200', cred.status, 200)
  check('拿到的就是 handoff 那把', (await cred.json()).authToken, HANDOFF_TOKEN)
  check('用户 token 不是服务凭证 → 401', (await postCredential({ org: ORG, uid: UID }, HANDOFF_TOKEN)).status, 401)
  check('该租户没有凭证 → 404', (await postCredential({ org: ORG, uid: 'nobody' })).status, 404)

  console.log('\n员工重登录 = 宿主用同 uid+org + 新 token 重渲 iframe，我们不做任何主动刷新')
  const rotated = `${HANDOFF_TOKEN}_v2`
  await handoff(rotated)
  check('凭证自动跟到新 token', (await (await postCredential({ org: ORG, uid: UID })).json()).authToken, rotated)
  // 每个请求都覆盖，读也一样（PLAN §4.3）。**不能**在这里加规则去挑哪把 token 该赢：本仓库只有这一个
  // writer，没有 delete / override / TTL，拒一次就是永久卡死——员工被告知「重开 FlyAI」，而重开送来的
  // 正是被拒的那把。残余风险（谁都能改别人的凭证）由 HMAC 握手（PLAN §7.1）关闭，不由这里关闭。
  const readToken = `${rotated}_via_read`
  await read(readToken)
  check('读请求同样覆盖：永远是最后收到的那把', (await (await postCredential({ org: ORG, uid: UID })).json()).authToken, readToken)

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 条失败 ❌`)
} finally {
  worker.kill('SIGTERM')
}
process.exit(failures === 0 ? 0 : 1)
