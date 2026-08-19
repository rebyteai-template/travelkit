# TravelKit 携程比价 extension

OP 在推荐表里选定方案后，原本要跳到携程人肉比价再切回来。这个扩展在 **OP 自己的浏览器**里
把携程价读出来，直接回填到对应 plan 那一行。

**它靠自愿安装，但比价只有这一条路。** OP 是客户员工、用客户的电脑，我们装不了任何东西，
只能引导：没装扩展时，推荐表的「携程价」格会显示商店安装链接（Unlisted，凭链接安装，
商店内搜索不到）：

<https://chromewebstore.google.com/detail/dgggiiccaeaihlkpdabinmiighgdgkhc>

装好后刷新页面即出现「自动读取」。没有手填入口——手填的数字与读取的长得一样，却没有任何
证据（匹配到哪班、多少班里挑的、何时读的），所以不入库（capture-only，主仓 PR #13）。

## 为什么必须跑在浏览器里

服务端抓不到。同一个请求从 Cloudflare 数据中心 IP 发出去，携程直接回
`HTTP 432 whaleguard block`；从住宅 IP 的真实浏览器打开则完全正常。而 Cloudflare Browser Run
既不支持 IP 轮换，也在 CDP 层禁掉了 `proxyServer`（`-32602 … not allowed`），所以没有服务端
的解法。取证与复现见 `../../ctrip-price-probe/`。

## 开发

```bash
pnpm --filter extension build     # 或 pnpm ext:build（仓库根）
```

产物在 `extension/dist/`。Chrome → `chrome://extensions` → 打开开发者模式 →
「加载已解压的扩展程序」→ 选 `extension/dist`。

## 发布（Chrome Web Store）

商店版 = **不带** `NODE_ENV=development` 的构建：manifest 只认 `tripdesk.impo.ai` 与
`flights.ctrip.com`（manifest.config.ts 里有断言，配宽了直接构建失败）。发新版：

1. bump `extension/package.json` 的 `version`（商店要求严格递增）
2. `pnpm ext:build`，然后把 `extension/dist/` 打成 zip
3. Developer Dashboard（publisher 是 wfllike@gmail.com）→ 该 item → Package → 上传新 zip
   → Submit for review
4. 过审后商店自动推送给已装用户；Unlisted 安装链接不变

开发机继续用 `NODE_ENV=development pnpm ext:build` 的解压版（多出 localhost 匹配），
与商店版互不影响。

`pnpm build` / `pnpm deploy`（仓库根）**不会**构建或上传它：SPA 产物在 `../build`，
wrangler 只上传那个目录，两条构建链互不相交。

## 设计约束

**不持有任何凭证。** 扩展抓到的是携程的公开价格，经页面桥交给 SPA，由 SPA 用它**本来就有**的
embed 身份写回我们的 API。桥上没有 token —— 因此同一台机器上别的扩展即使监听同一个 window，
也没有可偷的东西。这也是为什么不需要签发什么 capture token。

**桥用 content script，不用 `externally_connectable`。** TravelKit 以 iframe 形式嵌在客户后台
里，而 Chrome 要求 `externally_connectable.matches` 同时包含 iframe 源**和顶层父页源**；顶层
是客户任意域名，填不了。content script 按每个 frame 自身 URL 匹配，所以 `all_frames` 能稳定注入。

**`src/tripdesk-content.ts` 必须保持极薄。** 它跑在 TravelKit 源上，那里的 `sessionStorage.td_tk`
存着真实 travelkit 凭证，content script 读得到。这个文件只中继两种消息、绝不碰 sessionStorage，
不要往里加功能。

**权限清单不许放宽**：`permissions` 只有 `storage`；`host_permissions` 只有携程和 tripdesk 两条；
**没有 `tabs`**（`chrome.tabs.create` 本来就不需要），**没有 `<all_urls>`**。

**只在 OP 点击时抓一次**：不后台轮询、不批量遍历携程。抓取发生在前台可见标签页——后台标签
会被 Chrome 渲染节流，携程的懒加载列表可能永远不出现。

**读不到就说读不到。** 提取器主锚点是携程自己的 `.flight-item`，丢了就降级为按航班号扫描并在
`strategy` 里如实上报；两者都失败时返回空，SPA 提示「请手填」。绝不猜一个数——OP 拿这个价去
报价，错的数比没有数危险。列表是懒渲染的，实测 6 秒不够、12 秒稳，所以等待轮询到列表条数
稳定为止（上限 20 秒）。

## 分发（尚未进行）

OP 的电脑由客户管理，只有客户 IT 能装：Chrome 企业策略 `ExtensionInstallForcelist`
（或 `ExtensionSettings` 的 `installation_mode: force_installed`）。首选 Chrome Web Store
非公开(unlisted) 发布后按 ID 强装；自托管 CRX 需要在 manifest 里 pin `key` 固定 extension id。
开发期用「加载已解压」即可。

## 已知缺口

- 口径未对齐：携程列表页是**不含税票面价**，TravelKit 的方案总价**含税**（国内线差约
  ¥160 = 机建 50 + 燃油）。UI 里差额标了「税费口径未对齐」，尚未自动换算——这是有意为之，
  等口径方案定了再做，先不引入一个看起来精确的错数。
