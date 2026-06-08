# TripDesk iframe 接入

线上：`https://tripdesk.impo.ai`
把 TripDesk（AI 机票工作台）当 iframe 嵌进你方后台，用你方员工身份直接用，无需二次登录。

## 契约

宿主在 iframe URL 的 **片段（`#`，不是 `?`）** 里传当前登录员工身份：

```
https://tripdesk.impo.ai/#uid=<员工稳定ID>&org=<组织ID>&token=<该员工 travelkit token>&k=<embed key>
```

| 参数 | 含义 | 稳定性 | 来源 |
|------|------|--------|------|
| `uid` | 员工唯一稳定标识（工号/user id） | 不变 | 你方 |
| `org` | 该员工当前所属组织ID | 不变（同组织内） | 你方 |
| `token` | 该员工在该 org 下的 travelkit token | 重登录即变 | 你方 |
| `k` | embed 门禁 key | 固定 | 我方带外提供 |

**租户 = `(org, uid)`**：一个员工可隶属多个 org，每个 `(org, uid)` 是独立租户（各自沙箱+历史+token）。同一 uid 切到另一个 org = 另一个工作台。`uid`、`org` **均必填**，缺任一 → `401`（无 org 不工作）。

## 接入

```html
<iframe src="https://tripdesk.impo.ai/#uid=EMP10086&org=ORG42&token=TK_xxx&k=THE_KEY"
        style="width:100%;height:100%;border:0" allow="clipboard-write"></iframe>
```

## 规则（必须遵守）

- 用 `#` 片段，**禁止**用 `?` query —— `token`/`k` 会泄漏进服务端日志和 Referer。
- token 变了（员工重登录）→ 用 **同 `uid`+`org` + 新 `token`** 重新渲染 iframe。**别换 `uid`/`org`**（换了该租户丢历史）。我方自动把新 token 刷进其沙箱，你方无需其他动作。

## 行为

- 首次发消息为该 `uid` 开沙箱（~1 分钟），之后复用。
- 身份只存浏览器 sessionStorage：刷新保持；关标签即清，靠你方下次渲染 iframe 重新带上恢复。**无服务端会话**，每个请求凭 URL 身份现认。
- **四个参数 `uid`/`org`/`token`/`k` 缺一不可**，缺任一或 `k` 错 → 接口返回 `401`，前端展示「请从企业后台打开」页，不暴露任何功能。
- 支付=沙箱/演示：返回第三方支付链接给用户自行完成，不替付、不谎称已付。下单/支付/退改每步需用户确认。默认简体中文。

## 安全（现状 → 后续）

- `k` 挡「只知道域名的陌生人」。但 `uid` 当前 **裸传未签名**：拿到完整链接者可改 `uid` 越权 → 把链接当敏感凭证，仅在你方后台服务端渲染、勿外泄。
- 正式上线前建议升级签名握手：你方用双方共享密钥对 `{uid, token, exp}` 做 HMAC 签名，我方验签后才认 `uid` → 不可伪造、短时过期。协议对接时定（约 30 行）。

## 需你方提供

1. 承载 iframe 的页面 **域名**（我方据此锁 `frame-ancestors`）。
2. `uid` 取值口径（确认稳定唯一）。
3. 是否走签名握手（建议正式上线启用）。
