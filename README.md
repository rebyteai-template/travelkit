# TravelKit / Kitty

Kitty 是一个 Agent 驱动的机票业务工作台。当前界面是“会话侧栏 + 单列聊天流”：搜索表格、验价结果、最终推荐、乘客表单和确认步骤都在聊天流内展示。

航班事实来自独立的 [`simplifly-flyai-skill`](https://github.com/TravelKit-AI/simplifly-flyai-skill)。Skill 在 Rebyte 沙箱中通过 CLI 直连 Simplifly Flight OpenAPI；TravelKit 不直接搜索、组合或推荐航班。

## 本地运行

要求 Node 22 和 pnpm 10。

```bash
pnpm install
pnpm dev        # Vite :4000 + Wrangler :8787
pnpm test
pnpm typecheck
pnpm build
```

本地 Worker 使用 `.dev.vars`，CLI 探针使用 `.env.local`。两者都可能包含凭证，禁止提交、打印或复制到聊天中。

应用采用 iframe handoff 鉴权。宿主通过 URL fragment 传入 `uid`、`org`、TravelKit `token`，配置了 `EMBED_KEY` 时还需传 `k`：

```text
http://127.0.0.1:4000/#uid=<uid>&org=<org>&token=<token>&k=<embed-key>
```

SPA 首次加载后把这些值保存在当前标签页的 `sessionStorage`，随后从地址栏移除 fragment。裸开页面或缺少 `uid`、`org`、`token` 会显示“无法访问 Kitty”。`DEV_EMAIL` 只提供本地 uid fallback 和管理员判断，不能替代 `org` 与 `token`。

## 系统结构

```text
用户请求
  → React 单列聊天 UI
  → Cloudflare Worker / TaskDO
  → Rebyte agent-loop
  → 用户沙箱中的 simplifly-flyai-skill
  → Simplifly Flight OpenAPI
  → versioned tool_result
  → TaskDO 回放子会话结果并写入 D1 frames
  → src/frames.ts 解析契约
  → 聊天流内的领域组件渲染
```

- `worker/index.ts`：Worker 入口，只做两件事——re-export DO 类 + re-export 请求管线。
- `worker/app.ts`：Hono 组合根、iframe handoff 鉴权、D1/DO/relay 依赖注入。（和入口分开是为了能测：入口 import DO 类会拉进 `cloudflare:workers`，node test runner 解析不了。）
- `worker/task-do.ts`：每个任务的流式执行、断线续跑、子会话 `tool_result` 回放。
- `worker/skill-ref.ts`：Skill GitHub 来源。新 Rebyte session 从远端 `main` 安装 Skill。
- `server/routes.ts`：`/api/app/*` 会话、附件、SSE、调试配置接口。
- `server/oauth.ts`：委托凭证授权服务器（`/oauth/token`、`/internal/simplifly-credential`、JWKS）。挂在 Worker 根路径，不走 embed 中间件。
- `server/tenant-credential.ts`：租户当前凭证的入库——**无条件覆盖** + 审计行（为什么不能加「换值规矩」见下）。
- `server/store-d1.ts`：D1 `Store` 实现。迁移目前包含 `tasks`、`prompts`、`frames`、`kv`、`agent_computers`、`attachments`、`prompt_files` 和 `tenant_credentials`。
- `src/frames.ts`：把 versioned CLI JSON 转成只读 UI view model。
- `src/components/ChatPanel.tsx`：在聊天流内渲染文本、搜索表、验价、推荐与写操作流程。

Cloudflare Access JWT 代码仍存在于 `worker/auth.ts`，但不在当前请求链上。当前身份边界以 `worker/app.ts` 的 embed handoff 中间件为准。

## 委托凭证（per-user 授权服务器）

Simplifly token 绑定 `(部门, uid)`：不同员工可见的供应商和运价不同，共享一把 token 给出的是**错误结果**，不只是归因不准。所以 MCP 调用必须用调用者本人那把。TravelKit 是这条链上的授权服务器（`server/oauth.ts`），两跳分开、**不能合并**：

| 跳 | 端点 | 鉴权 | 谁调 | 返回 |
|---|---|---|---|---|
| ① | `POST /oauth/token` | Basic `RELAY_CLIENT_ID:RELAY_CLIENT_SECRET` | rebyte relay | **身份断言** JWT（`aud` = MCP 的 canonical resource URI，含 `org`/`uid`/`exp`） |
| ② | `POST /internal/simplifly-credential` | Bearer `TRIPDESK_SERVICE_TOKEN`（服务凭证，非用户 token） | 我方 MCP | `{ authToken, baseUrl? }` —— 该员工当前的 Simplifly 凭证 |
| — | `GET /.well-known/jwks.json`、`/.well-known/oauth-authorization-server` | 公开 | MCP 验签 / 发现 | 公钥、RFC 8414 元数据 |

relay 只经手 ①，永远看不到 ②：Simplifly 凭证没有 `exp`、撤不掉、全权限，进了 relay 就会落进不可变的 Temporal history。

`actor` 是 relay 眼中的**不透明串**（它从不解析），格式由我方定义为 `<org>:<uid>` —— 和 TravelKit 自己的租户键逐字节相同。`worker/task-do.ts` 在每次 `POST /v1/tasks` 和 follow-up 上带它，relay 原样送回 `/oauth/token`。

`tenant_credentials` 存每个租户**当前**的 token：**每个带 token 的请求覆盖一次，无条件**（PLAN §4.3）。它没有 `exp`，我方**不判有效性**——判不了，也不许猜——永远返回最后收到的那把；员工重登录后宿主用同 `uid`+`org` + 新 token 重渲 iframe（`INTEGRATION.md`），新值自然覆盖进来，**不需要任何主动刷新**。真失效了走上游 `401020` → MCP 提示「请从企业后台重新打开」。

两个时间戳答两个问题：`updated_at` = 上次**换值**（重登录），`last_seen_at` = 上次**出现**（这个租户还活着）。

### 错误分级：`400` 只留给 `invalid_grant`

这是整条链上最容易搞反的一处。`400 invalid_grant` 是唯一**不可重试、要给用户看**的答案（relay 会翻成「请从企业后台重新打开 FlyAI」）。其余一律不许落在 `400`：

| 情况 | 我方返回 | 为什么 |
|---|---|---|
| 该 actor 没有凭证（**且存储是健康的**） | `400 invalid_grant` | 员工重开 iframe 真能解决 |
| 客户端凭证不对 | `401 invalid_client` | 我方运维错，可重试 |
| `resource` / `grant_type` / 缺 `actor` | `500`（错误码照旧） | **都是我方配错**。落 `400` 会让每个员工永久看到「请重开」，而重开永远没用 |
| 凭证库读不了 / 写不进 | `503 server_error` | 「查不到」和「库坏了」不是一回事：后者必须可重试。miss 时会**真写一次探针**来分辨 |
| 连续认证失败超阈值 | `429` | 见下 |

`resource` 只差一个尾斜杠（或 relay 送的是 origin）时不会把所有人卡死：能唯一对上就照签，但 `aud` 一律用**我方 canonical 那一串**（MCP 逐字比 `aud`），同时打一条运维日志——配置该改还是要改。

`/oauth/token` 和 `/internal/simplifly-credential` 的失败尝试都**逐条记日志并有上限**（默认 60 秒 10 次，超了回 `429` + `Retry-After`）。后者返回的是**全权限、无 `exp`、撤不掉**的 Simplifly 凭证，只有一个静态 bearer 挡着，所以静默无限重试不可接受。限流是 **per-isolate** 的（Workers 没有全局内存）——要账号级的硬上限，在 `wrangler.jsonc` 里加 Cloudflare 的 ratelimit binding。桶键**只认 `CF-Connecting-IP`**（边缘写的，客户端改不了），不认 `X-Forwarded-For`：那是请求数据，认它等于让攻击者自己挑桶——换个值就是一份新配额，填成 relay 的地址就能替 relay 把配额花光。没有 `CF-Connecting-IP` 的请求（本地 `wrangler dev`、没走边缘的直连）**共用一个桶**，是往严的方向兜。

签名密钥缺失或不可用时，JWKS 回 **`503`**，不是 `200 {"keys":[]}`：后者会让所有探活变绿，而对面其实一把钥匙都验不了，且和 `/oauth/token` 的 `503` 互相矛盾。

### 配置

```bash
pnpm db:migrate                              # 0007_tenant_credential + 0008_credential_observability

pnpm oauth:key | npx wrangler secret put OAUTH_SIGNING_KEY   # ES256 私钥 JWK
openssl rand -hex 32 | npx wrangler secret put RELAY_CLIENT_SECRET
npx wrangler secret put RELAY_CLIENT_ID      # 例如 rebyte-relay
openssl rand -hex 32 | npx wrangler secret put TRIPDESK_SERVICE_TOKEN
```

用 `-hex` 不用 `-base64`：RFC 6749 §2.3.1 要求客户端在 base64 之前先对两半做 form-urlencode，base64 密钥里的 `+` 会被编成 `%2B`（或解成空格），比对永远不等 → 恒定 `401 invalid_client`，而那是**可重试**的运维错 ⇒ relay 会对一个永远不会匹配的凭证无限重试，运维看到的提示还是「你的 id/secret 不对」——但值是逐字正确的。hex 不受编码影响，所以从根上不会发生；**同时** AS 侧也对两半做 percent-decode（双保险，两种客户端都认）。`RELAY_CLIENT_ID` / `RELAY_CLIENT_SECRET` 人工粘进 rebyte 的注册 dialog（只有一个客户端，所以没有客户端表）；`TRIPDESK_SERVICE_TOKEN` 要和 MCP 侧那个**同值**。`OAUTH_ISSUER` 已经在 `wrangler.jsonc` 的 `vars` 里（`https://tripdesk.impo.ai`，非机密），换域名时要跟着改：它必须和 MCP 的 `OAUTH_ISSUER` **逐字相同**，MCP 的 `OAUTH_JWKS_URL` 指向 `<issuer>/.well-known/jwks.json`。**不设它 `/oauth/token` 直接 `503`**，宁可不签也不猜——以前的兜底是「用本次请求的 origin」，那会让 `*.workers.dev`、预览 URL 和自定义域变成三个不同的 issuer，签出来的 token 全被对面当伪造，两边都只看得到一个无差别 401。resource（`aud`）默认 `https://simplifly-mcp.impo.ai/mcp`，必须同时等于 MCP 的 `MCP_RESOURCE` 和 relay 从注册 URL 自动带上的 `resource`；三者有一处不一致就是 `invalid_target` 或对面 401，用 `OAUTH_RESOURCES`（逗号分隔）覆盖。

**私钥只在 `OAUTH_SIGNING_KEY` 这一处**，JWKS 只发公钥半边。Worker secret 写后读不回，所以把 `pnpm oauth:key` 的输出同时存进密码管理器——否则无法平滑轮换。轮换：把 secret 设成 JSON 数组 `[<新钥>, <旧钥>]`（第一把签发，全部发布，旧 kid 签的 token 继续可验），等过了一个 token 生命周期（1 小时）再设成 `[<新钥>]`。私钥丢了只能硬换，代价是最多 1 小时的 401。

### ⚠️ 信任根：handoff 还没签名（**残余风险，别当它已修**）

`uid`/`org`/`token` 就是三个请求头，谁都能声称自己是谁（`INTEGRATION.md` 安全一节）。所以：**任何能访问到 Worker 的人都能覆盖任意员工的凭证行**，把那个人按在 `401020` 上——只要他一直发。

**真正也是唯一的修法是 HMAC 握手（PLAN §7.1，单独排期）**：宿主用共享密钥对 `{uid, token, exp}` 签名，我方验签后才认 `uid`。在它落地之前这里没有替代品，也**不要再造一个**：

> 曾经在入库处加过一层「换值规矩」（垃圾不许覆盖真凭证 / 别人账号的 token 塞不进来 / 旧 token 回滚不了新的）。**已回退**，因为它比它挡的洞更糟：本仓库只有 `persistTenantCredential` 一个 writer，没有 delete、没有 override、没有 TTL，所以**拒一次就是永久**——`/internal` 继续发我方手上那把死 token → Simplifly `401020` → 提示「重开 FlyAI」→ 而重开送来的正是被拒的那把，永远修不好。上游换个账号、或 Simplifly 改一次 token 格式，就是**全体租户一起卡死**，只能手工改库。**一行陈旧的凭证，永远好过一行卡死的凭证。**

现在还剩下的（都不是安全边界，只是别把明显坏的串放进来 + 事后可查）：

- 控制字符直接 `401`（这串会被写进沙箱的 `.simplifly.env`，换行 = 注入额外 env 行）。它只挡「本来就不可能是凭证」的东西，**不参与判断该存哪一把**。
- 每次 created / rotated 都有日志，带指纹不带明文——覆盖没人拦了，这条日志就是「合法重登录 vs 投毒」事后唯一的分辨依据。

### 自证

```bash
pnpm test              # 173 项。oauth.test.ts 按 mcp/src/mcp/auth.ts 的选项逐项验我们签的 token；
                       # app.test.ts 验组合根（挂载顺序、租户键、每请求覆盖、以及和改动前逐条对齐的鉴权门）；
                       # store-d1.test.ts 拿真 SQLite 跑真迁移，证明写探针能抓到「SELECT 通、写不通」；
                       # tenant-credential/rate-limit 验入库与限流
pnpm db:migrate:local
pnpm smoke:oauth       # 起真 wrangler dev 打通两跳 + 错误分级 + 真 D1 SQL；不碰 relay、沙箱和 Simplifly
```

## 航班推荐的责任边界

`flight-recommendations/v1` 是最终航班推荐的权威结果。`flight.search`、pricing 和 verify 结果只是中间证据。

### FlyAI Skill 负责

- 召回单程、往返、联合/开口程票价；
- 匹配不同舱等乘客组的同一物理航班；
- 组成完整方案并计算票组覆盖关系；
- 选择直飞、中转、时间窗等有意义的候选；
- 验价、失败补位、repricing 和最终排序；
- 生成总价、复制文本、状态、诊断信息与 capability。

推荐结果不好、缺少直飞、排序不合理或方案过于相似，应修 Skill，不应在 TravelKit 增加第二套推荐算法。

### TravelKit 负责

- 按 `schemaVersion` 和 `resultType` 解析结果；
- 校验必备字段、类型、唯一 `planId`、乘客人数、票组行程覆盖、币种、总价和 capability；
- 原样展示 Skill 已选择的方案；
- 使用 Skill 生成的 `copyText`；
- 最终推荐出现后，把 search/verify 结果降为折叠的只读证据；
- 同一用户轮次出现多个不同的 plan-bearing `flight.recommendations` 时拒绝取最后一个结果，按协议错误安全失败；重复回放的同一结果不算冲突；
- 对空结果、加载失败或非法契约进行安全降级。

TravelKit 不得按价格、时间窗、经停次数或本地时钟删除、合并、重排方案，也不得从 `partial`、`budgetStatus` 或诊断字段自行推导“不是最低价”等业务结论。有方案时只展示方案；只有 Skill 明确返回 `message` 或 `reason` 时，UI 才展示对应说明。

## Rebyte 与 Skill 更新

首轮 relay 请求携带 `skills:[SKILL_REF]`，Rebyte skills v3 从私有 GitHub repo 安装 Skill。`TaskDO.replaySubPrompt()` 会把委派子会话中的真实 `tool_result` 回放到父任务 frames，因此结构化搜索和推荐结果可以直接驱动 UI。

修改 FlyAI Skill 后必须提交并推送它自己的远端 `main`；新 session 才会安装新版本。单纯改 Skill 不需要修改或部署 TravelKit。

## 数据与安全边界

- `solutionId`、`orderKey`、PNR、票号等业务标识可以在内部工作台与后续 prompt 中流转，以支持精确验价和售后。
- token、环境变量、鉴权头和凭证文件内容不得进入 UI、日志、提交或聊天。
- 下单、支付、取消、退票和改签必须在执行前获得用户明确确认。
- API 没有返回的行李、退改或中转事实必须显示“未返回”或不展示，不能补写。
- 支付由用户在第三方页面完成；Agent 不替用户付款，也不宣称未确认的支付结果。

## 部署

```bash
set -a
source cloudflare.env
set +a
pnpm run deploy
```

线上地址为 `https://tripdesk.impo.ai`。裸访问 SPA 返回 200，但没有有效 handoff 时只显示门禁页；匿名访问 `/api/app/*` 应返回 401。只有 D1 schema 变化时才运行 `pnpm db:migrate` 或 `pnpm db:migrate:local`。

更多产品和视觉约束见 [PRODUCT.md](./PRODUCT.md) 与 [DESIGN.md](./DESIGN.md)。推荐管线的设计与实施记录见 [docs/2026-07-16-verified-flight-recommendation-pipeline.md](./docs/2026-07-16-verified-flight-recommendation-pipeline.md)，其中历史 commit、旧数量上限和实施状态不作为当前代码事实。
