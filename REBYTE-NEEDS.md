# 需要 rebyte 平台支持的能力（开放项）

> 这些是 TripDesk 目前靠「临时旁路」绕过、但本该由 rebyte 沙箱平台**原生支持**的能力。
> 旁路都收敛在我们自己的层（`worker/seed.ts`、UI），未改动 vendored 的 travelkit skill 主体
> （仅在 `SKILL.md` Credentials 段加了一句指引，见下）。
> 另见 `REBYTE-ISSUE.md`（agent-loop 结构化结果无法到达父任务，是独立的另一个问题）。

---

## 1. 沙箱 env 注入：`.claude/settings.json` 的 `env` 不进 agent 的 shell

**现象**：我们把每用户的 Simplifly 凭证写进沙箱 `/code/.claude/settings.json` 的 `env` 块，
期望无头 Claude Code 把 `SIMPLIFLY_BASE_URL` / `SIMPLIFLY_AUTH_TOKEN` 注入到 agent 的 bash 环境。
实跑发现**根本没注入**——子 agent `env | grep SIMPLIFLY` 为空，于是它到处翻 `.env*` / home
目录都找不到、放弃，导致整条机票流程拿不到 token 跑不起来。

**当前旁路（临时）**：`worker/seed.ts` 额外写一个可 `source` 的 `/code/.simplifly.env`，并在
vendored skill 的 `SKILL.md` Credentials 段加一句，指引 agent「调 API 前先
`set -a; source /code/.simplifly.env; set +a`」。`settings.json` 的 `env` 保留作镜像。

**期望 rebyte 支持**：沙箱能把每用户的 env（provision / seed 时传入）真正注入到 agent 运行时
环境变量里——这样凭证就是标准 env var，skill 无需任何特殊指引，也不必落地明文 env 文件。

---

## 2. skill 更新：已 provision 的沙箱里没法干净地替换 skill

**现象**：skill 是搬运进沙箱 `/code/.claude/skills/...` 的。上游 skill 一变，复用的老沙箱拿不到
新版：envd 文件 API **没有 DELETE（返回 405）**，re-seed 只能「覆盖同名文件」，被删掉的旧文件
残留在沙箱里（例如 MCP 时代的一堆 reference 文档），新旧混在一起。

**当前旁路（临时）**：要么 re-seed 时把已知废弃文件覆写成 inert（删不掉只能盖）；要么直接用
debug「新 VM」按钮（顶栏 brand 连点 10 下）换一台干净沙箱、弃用旧的。

**期望 rebyte 支持**：沙箱提供「干净更新 / 替换一个 skill（含删除陈旧文件）」或「版本化 skill
下发」的原生能力，让我们不必靠覆写或换 VM 来逼近「换 skill」。
