# 需要 rebyte 平台支持的能力（开放项）

> 这些是 TripDesk 目前靠「临时旁路」绕过、但本该由 rebyte 沙箱平台**原生支持**的能力。
> 旁路都收敛在我们自己的层（`worker/seed.ts`、UI），未改动 vendored 的 travelkit skill 主体
> （仅在 `SKILL.md` Credentials 段加了一句指引，见下）。
> 另见 `REBYTE-ISSUE.md`（agent-loop 结构化结果无法到达父任务，是独立的另一个问题）。

---

## 1. 沙箱 env 注入：`.claude/settings.json` 的 `env` 不进 agent 的 shell — 已用文件契约绕开 ✅

**现象**：早期我们把每用户的 Simplifly 凭证写进沙箱 `/code/.claude/settings.json` 的 `env` 块，
期望无头 Claude Code 把 `SIMPLIFLY_BASE_URL` / `SIMPLIFLY_AUTH_TOKEN` 注入到 agent 的 bash 环境。
实跑发现**根本没注入**——子 agent `env | grep SIMPLIFLY` 为空，于是它到处翻 `.env*` / home
目录都找不到、放弃，导致整条机票流程拿不到 token 跑不起来。

**解决（2026-06-08，已落实）**：换用 `travelkit-pro` skill，它**不再依赖 shell env var**，而是自己
从 CWD 向上找最近的 `.simplifly.env` **dotenv 文件并直接解析**。于是 rebyte 那个 env 注入 gap 变得
无关紧要。代码侧已对齐：`worker/seed.ts` `credentialsEnv()` 写**纯 `KEY=value`** 的 `/code/.simplifly.env`
（去掉了 `export` 前缀和 `source` 兜底注释），**删掉**了 `.claude/settings.json` 的 `env` 镜像写入
（`settingsJson()` 已移除），CLI 探针 `server/rebyte/seed.ts` 同步改写。`STALE_FILES` 增加
`.claude/settings.json` + 旧 `.claude/skills/travelkit/**`，re-seed 时真删。`CREDENTIAL_SCHEMA` bump 到
`v2` 触发存量沙箱 re-seed。**vendored skill 不再需要任何 Credentials 旁路指引**（旧的那句 `source` 已无）。

**`.simplifly.env` 契约**（`travelkit-pro` repo `rebyteai-template/skills-travelkit-wfl` 的
`SKILL.md` Core Boundaries + `references/api-map.md`，我们 seed 侧据此写文件）：

- 从 CWD **向上逐层找最近的 `.simplifly.env`**，按标准 dotenv 解析；不许 hardcode 绝对路径。
- 若最近的 `.simplifly.env` 落在 `skills/` 目录内 → 视为非法位置拒用（必须放在 skill 包外）。
  我们写 `/code/.simplifly.env`（在 `/code` 根、CWD 向上可达、在 `.claude/skills/` 外）即满足。
- skill 绝不创建/改/输出该文件（=我们 seed 写的外部私有配置）；缺了就停并让用户提供。
- 字段：`SIMPLIFLY_BASE_URL`、`SIMPLIFLY_AUTH_TOKEN`（必需）；`SIMPLIFLY_ACCEPT_LANGUAGE`
  （默认 `zh-Hans`）、`SIMPLIFLY_SF_MODE`（默认 `buyer`，可 `buyer|seller`）可选 → seed 不写，用默认。
- skill 鉴权 `Authorization: Bearer ${SIMPLIFLY_AUTH_TOKEN}`（skill 内部，不影响 seed）。

**仍是 nice-to-have（非阻塞）**：rebyte 若能把每用户 env 真正注入 agent 运行时，可省掉落地明文
`.simplifly.env` 文件。但当前文件契约已让整条流程不再受阻，**不再 block**。

---

## 2. skill 更新：已 provision 的沙箱里干净替换 skill — 已解决 ✅

**原以为的现象**：skill 搬运进沙箱 `/code/.claude/skills/...`，上游一变老沙箱拿不到新版，
因为 envd 的 **REST 文件 API `/files` 没有 DELETE（405，`allow: GET,HEAD,POST`）**，re-seed
只能「覆盖同名文件」，废弃的旧文件（如 MCP 时代的 reference 文档）残留。

**真相**：REST `/files` 确实没 DELETE，但 envd 另外暴露了 **gRPC-Web Filesystem 服务**
`filesystem.Filesystem/Remove`，它**能真删**，且接受和写入相同的鉴权（`X-API-KEY` +
`Authorization: Basic base64("user:")`，无需 JWT/team_id）。对一台 live 沙箱实测：写→200、
`Remove`→`grpc-status:0`、再 GET→404；删不存在的文件→`grpc-status:5`（当幂等成功）。

**现在的做法**：`worker/seed.ts` 的 `removeFile()` 手搓一个 gRPC-Web 一元调用（纯 fetch、零依赖、
Workers 原生，和 `writeFile` 同构）。`removeStaleArtifacts()` 改成对 `STALE_FILES` 真删，re-seed
（`seed_version` bump）时自动清理废弃文件。**不再需要**覆写 inert，也不必靠「新 VM」按钮换沙箱。
探针：`server/rebyte/removeprobe.ts`。

**为什么不用 SDK 的 `files.remove`**：rebyte-sandbox SDK 跑不进 Worker（Template 模块静态
`import fs/tar`），即便拆出 fs-free 子入口，其 gRPC ransport 还会附带 `Rebyte-Sandbox-Id` /
mint 出来的 `X-Access-Token` 等网关头，在 rebyte envd 上**反而 401**（实测）；其 REST `write`
也因响应体结构不符报错。结论：rebyte envd 网关只认我们这套 raw 鉴权，手搓比 SDK 更可靠。

**残留的小建议（非阻塞）**：若 rebyte 想让 SDK 可用，可① 给 envd 网关的 gRPC 路同样接受
`X-API-KEY`（或修正 `X-Access-Token` minting 不需 team_id）；② SDK 拆一个不含 Template 的
fs-free 入口。但 TripDesk 侧已无需求。
