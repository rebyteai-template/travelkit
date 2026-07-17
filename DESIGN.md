---
name: TripDesk
description: AI 机票预订工作台 — 克制可信的暖纸张工作台，kami house style
colors:
  parchment: "#f5f4ed"
  ivory: "#faf9f5"
  sand: "#e8e6dc"
  ink: "#141413"
  charcoal: "#4d4c48"
  olive: "#5e5d59"
  stone: "#87867f"
  silver: "#b0aea5"
  border: "#e8e5da"
  border-strong: "#e0ddd2"
  brand: "#1b365d"
  brand-deep: "#11233f"
  brand-pale: "#e8eef6"
  brand-border: "#cfdce9"
  success: "#5a7a3a"
  success-pale: "#eaefe2"
  warning: "#7a5a25"
  warning-pale: "#f5ead4"
  error: "#b53333"
  error-pale: "#f5e4e4"
typography:
  display:
    fontFamily: "Newsreader, Georgia, 'Source Han Serif SC', serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
  body:
    fontFamily: "Lato, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Lato, -apple-system, 'PingFang SC', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.35
  mono:
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "18px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.brand-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.olive}"
    rounded: "{rounded.md}"
    padding: "9px 18px"
  card:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "18px"
  input:
    backgroundColor: "{colors.sand}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  chip:
    backgroundColor: "{colors.brand-pale}"
    textColor: "{colors.brand}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
---

# Design System: TripDesk

## 1. Overview

**Creative North Star: "排版讲究的行程单"（The Itinerary, Well-Typeset）**

TripDesk 应当像旅行社 OP 案头那份排版讲究的行程单 / 对账单：暖纸张底色，墨黑文字，信息分层清楚，唯一的靛蓝色只在该强调处出现。它服务一天处理几百单的专业操作员——所以**安静、可信、久看不累**比任何视觉花活都重要。整套系统继承自 kami house style（与姊妹项目 cctools / kami.tw93.fun 同源）：暖灰中性、单一靛蓝强调、细描边、近乎无影。

它**明确拒绝**三种长相：改版前的深色霓虹科技风（深蓝黑 + 电光蓝）；玩具 / 卡通感（大圆角、强阴影、糖果色）；以及携程 / Expedia / 飞猪式的 OTA 花哨拥挤风（红黄促销、弹窗、角标、信息过载）。

**Key Characteristics:**
- 暖纸张画布（parchment `#f5f4ed`），不是纯白，也不是深色
- 单一靛蓝强调色（`#1b365d`），覆盖任意一屏 ≤ 5%
- 暖灰文字阶梯（ink → charcoal → olive → stone → silver），无冷灰
- 细描边 + 近乎无影；层次靠底色分层，不靠投影
- 为"比价"而生的信息密度：表格可密、术语可留
- 字体克制：Lato 扛全部 UI，Newsreader 衬线只在欢迎 / 空态点一下，等宽只给 ID / 票号 / 金额

## 2. Colors

暖纸张中性色打底，单一靛蓝强调，状态色走暖调——像编辑批注，不像仪表盘信号灯。

### Primary
- **靛蓝 Brand Ink-Blue** (`#1b365d`)：主操作、当前选中、链接、焦点环。**唯一**的彩色强调。hover / 按下加深到 **`#11233f`**（brand-deep）。淡底变体 **`#e8eef6`**（brand-pale）用于选中行、标签、金额块等浅蓝底。

### Neutral
- **羊皮纸 Parchment** (`#f5f4ed`)：页面画布。
- **象牙 Ivory** (`#faf9f5`)：卡片、面板、弹层、代码块等抬起表面。
- **沙 Sand** (`#e8e6dc`)：输入框底、表头底、行内代码底等交互基底。
- **墨 Ink** (`#141413`)：主文字、标题。
- **炭 Charcoal** (`#4d4c48`)：次级 / 密集正文。
- **橄榄 Olive** (`#5e5d59`)：说明、弱化文字（`--muted`；选它而非更浅的 stone，是为了正文对比度 ≥ 4.5:1）。
- **石 Stone** (`#87867f`)：元信息、标签。
- **银 Silver** (`#b0aea5`)：最浅一档、禁用。
- **描边 Border** (`#e8e5da`) / **重描边** (`#e0ddd2`)：分隔线、卡片 / 输入边框。

### 状态 Functional
- **成功 Success** (`#5a7a3a` 暖橄榄绿) / 淡底 `#eaefe2`：验价通过、价格、确认按钮。
- **警告 Warning** (`#7a5a25` 暖焦糖) / 淡底 `#f5ead4`：价格过期提醒、确认闸边框。
- **错误 Error** (`#b53333` 暖红) / 淡底 `#f5e4e4`：验价失败、必填标记、报错横幅。

### Named Rules
**The One Accent Rule.** 全站只有一个彩色强调——靛蓝；任意一屏覆盖 ≤ 5%。想加第二个彩色（紫、青、橙）时，停下来重想。状态色是批注，不是第二强调。

## 3. Typography

**Display Font:** Newsreader（衬线，fallback Georgia / Source Han Serif SC）
**Body Font:** Lato（fallback -apple-system / PingFang SC / Microsoft YaHei）
**Label / Mono Font:** SF Mono 系统等宽栈

**Character:** 一把 Lato 扛下全部 UI（标题、按钮、标签、正文、数据），层级靠字重和字号，不靠换字体。Newsreader 衬线只在"欢迎 / 空态"这种编辑性时刻点一下，给冷静的工具加一点人味。等宽只服务 ID、票号、金额、时间这类需要对齐的数据。中文一律走系统中文回退（PingFang SC / Microsoft YaHei / 系统宋体）。

### Hierarchy
- **Display** (Newsreader 500, 22px, 1.2)：聊天欢迎语等空态标题。**仅此一处**用衬线。
- **Title** (Lato 600, 17px)：卡片标题 `.card-head h2`、结果区标题 `.results-head h2`。
- **Body** (Lato 400, 14px / 1.55)：默认正文、聊天气泡、表格单元格。
- **Label** (Lato 600, 11–12px)：字段标签、标签 chip、表头、会话元信息。
- **Mono** (SF Mono, 13px)：可见 ID、票号、金额、时间戳。

### Named Rules
**The One Family Rule.** UI 用一把 Lato。层级 = 字重 + 字号 + 颜色，绝不靠换字体制造层级。衬线是欢迎 / 空态的专属点缀，不进任何按钮、标签、数据。

## 4. Elevation

近乎扁平。深度靠**底色分层**（parchment 画布 → ivory 抬起面 → sand 交互基底）和 1px 暖描边，而**不是投影**。唯一的真实投影留给移动端的侧边抽屉（它确实浮在内容之上）。

### Shadow Vocabulary
- **抽屉投影** (`box-shadow: 2px 0 18px rgba(0,0,0,.45)`)：仅移动端 `.sidebar` 滑出抽屉。
- **遮罩 scrim** (`background: rgba(0,0,0,.5)`)：移动端抽屉背后的半透明遮罩。

### Named Rules
**The Flat-By-Default Rule.** 卡片、按钮、表格在静止时一律无影，靠底色和描边分层。投影只在"真的浮起来"（抽屉、未来的弹层）时出现。装饰性投影、带色发光一律禁止。

## 5. Components

### Buttons
- **Shape:** 10px 圆角（`rounded.md`）；绝不做 999px 胶囊文字按钮。
- **Primary:** 靛蓝底 (`#1b365d`) + 象牙字，padding 10px 18px，字重 600。用于发送、验价、下单、确认等主操作。
- **Hover / Focus:** 系统预留 **brand-deep `#11233f`** 作 hover / 按下加深色（当前主按钮多为扁平态，补交互态时统一用它——见 Do's）；焦点环 2px 靛蓝、offset 2px，无发光。
- **Ghost（次级）:** 透明底 + olive 字 + 1px 描边；hover 文字转墨色。用于取消、关闭等次操作。
- **Confirm（确认闸）:** 成功色 `#5a7a3a` 底 + 象牙字。专用于 ConfirmGate 里"确认下单 / 支付"那一下。

### Chips / Tags
- **Style:** 淡靛蓝底 (`#e8eef6`) + 靛蓝字，999px 圆角，padding 1px 7px。用于运价标签、顶栏 demo 标记。
- **State:** 选中态（会话行、面板切换）用同一淡靛蓝底标识。

### Cards / Containers
- **Corner:** 12px（`rounded.lg`）；领域卡 `.card` max-width 720px。
- **Background:** 象牙 (`#faf9f5`)，区别于 parchment 画布。
- **Shadow:** 无（见 Elevation：扁平 + 描边）。
- **Border:** 1px 暖描边 (`#e8e5da`)。
- **Internal Padding:** 18px（移动端 14px）。

### Inputs / Fields
- **Style:** 沙底 (`#e8e6dc`) + 墨字 + 1px 描边，8px 圆角，`color-scheme: light`。
- **Focus:** 边框转靛蓝（无发光）。
- **Required / Error:** 必填用错误色 `#b53333` 的标记；报错横幅走 error 淡底 + 描边 + 文字三件套。

### Navigation / Lists
- **会话侧栏:** ivory 底；会话行 hover 转 sand，选中转淡靛蓝；标题 13px，元信息 11px stone。
- **移动端:** 侧栏变滑出抽屉（带遮罩），主区按顶栏 toggle 一次显示一栏（聊天 / bench）。

### Signature: 搜索结果表（比价）
OP 的核心比价界面。整行表格 ivory 底 + 1px 描边，表头 sand 底 + stone 标签字；最便宜行用 success 淡底 (`#eaefe2`) 轻染高亮；价格列等宽对齐。**密度优先**：一屏要能比多个方案。

### Signature: 最终推荐对比表
最终 `flight.recommendations` 的所有方案必须进入同一张 Excel-like 表格，不做逐方案纵向卡片。列固定为 `方案 | 航程 | 航班号 | 日期 | 航段 | 时间 | 飞行时长 | 舱位 | 行李 | 价格 | 供应渠道`。一个方案是一个 row group，一个物理 segment 一行；方案单元格跨该方案全部 row，并在其中只显示一次整单总价和 Copy。ticket group 的查询方式作为价格旁的标记，只在其覆盖范围的第一行显示；票组价格按该乘客组人数折算为含税人均价。`fareSource` 必须明确标记为单独查询、往返查询或联合查询；价格只属于 ticket group，禁止把往返或联合票总价重复写进每个 segment。商务 / 经济等 passenger group 共享同一物理航班时，航班只显示一次，分段舱位和行李分别成列并由 Skill 的 `segmentFacts` 精确关联。某个 segment 的舱位、行李或飞行时长缺失时只显示 `未返回`，禁止用 ticket、journey 或请求级字段兜底。

## 6. Do's and Don'ts

### Do:
- **Do** 用暖纸张画布 (`#f5f4ed`) + 象牙抬起面 (`#faf9f5`)；文字走墨 → 炭 → 橄榄 → 石的暖灰阶梯。
- **Do** 把靛蓝当唯一强调，任意一屏 ≤ 5%，只给主操作 / 选中 / 状态；hover 加深到 `#11233f`。
- **Do** 正文对比度 ≥ 4.5:1；弱化文字用 olive，别用更浅的灰"显高级"。
- **Do** 写操作（下单 / 支付 / 退改）前走 ConfirmGate；接口没返回的数据如实标"未返回"。
- **Do** 把 ID / 票号 / 金额 / 时间用等宽字对齐；搜索结果保持可比的高密度。
- **Do** 用底色分层 + 1px 描边表达层次；静止状态一律无影。

### Don't:
- **Don't** 回到**深色霓虹科技风**（深蓝黑底 + 电光蓝 `#4f8cff` / 霓虹绿 `#2ecc71`）——这是改版前的样子，已废弃。
- **Don't** 做**玩具 / 卡通感**：超大圆角、带色发光 / 强投影、糖果色、表情堆砌。
- **Don't** 做 **OTA 花哨拥挤风**（携程 / Expedia / 飞猪）：红黄促销色块、弹窗、满屏角标、信息过载。
- **Don't** 引入第二个彩色强调（紫 / 青 / 橙），也别用冷灰（slate / zinc / neutral）。
- **Don't** 用渐变文字、装饰性玻璃拟态、侧边色条（border-left > 1px 当强调）、每段一个小写 eyebrow 标签、hero 大数字模板。
- **Don't** 把衬线 / 等宽字用进按钮和普通 UI 标签；层级靠字重字号，不靠换字体。
- **Don't** 用胶囊文字按钮（999px），也别用直角（0）。
