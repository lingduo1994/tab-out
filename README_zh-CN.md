<div align="center">

# Tab Out

**让你的标签页井井有条。**

一个纯 Chrome（Manifest V3）扩展，把新标签页替换成一个整洁的仪表盘：按域名分组、聚焦显示当前所有打开的标签，一键即可清理。

[English](./README.md) · [简体中文](./README_zh-CN.md)

![Tab Out 截图](./docs/screenshot.png)

</div>

---

## 亮点

- **固定网站（Pinned）** — 在页面顶部放最多 10 个常用站点，一键直达，通过侧边抽屉管理。
- **快速跳转（Quick Jump）** — 把常用查询写成 URL 模板（如 `https://cloud.example.com/rds/{}/detail`），化作一个个 chip。选 chip、输入参数、回车跳转。每个 chip 自动记忆最近 3 次输入，在输入框下拉显示。
- **稍后查看（Saved for later）** — 把暂时不读但又怕忘的标签收进右侧清单；处理完打勾归档（archive）；可以折叠展开归档区，也可以一键清空整个归档。
- **按域名聚合的卡片** — 每个打开的标签出现在它所属域名的卡片下，支持一键跳转、关闭单个、关闭整组、重复标签检测。
- **完全本地** — 所有状态存在 `chrome.storage.local`。无服务端、无埋点、无账号。

---

## 安装

不需要构建。直接把 `extension/` 文件夹加载进 Chrome 即可。

```bash
git clone https://github.com/lingduo1994/tab-out.git
```

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式（Developer mode）**
3. 点 **加载已解压的扩展（Load unpacked）**，选中刚 clone 下来的仓库里的 `extension/` 文件夹
4. 新开一个标签页就能看到 Tab Out

> 任何时候修改了 `extension/` 下的文件，回到 `chrome://extensions` 点 Tab Out 卡片上的刷新图标，再重新打开新标签页即可。

---

## 功能详解

### 仪表盘布局

新标签页就是仪表盘本身。当前打开的标签按下面的优先级分到不同卡片里：

1. **Homepages 卡片** — 高频网站的"主页"（Gmail 收件箱、X 首页、GitHub 主页、LinkedIn 主页、YouTube 首页，加上你在 `LOCAL_LANDING_PAGE_PATTERNS` 里自定义的规则）会被收拢到一个 "Homepages" 卡片，置顶展示。
2. **自定义分组** — 你在 `LOCAL_CUSTOM_GROUPS` 里写的规则（例如把所有 `*.bytedance.net` 的子域名合并到一个卡片）紧随其后生效。
3. **按域名默认分组** — 其它标签按 hostname 分组，按 tab 数量倒序排列。`file://` 协议的本地文件统一收到一个 `local-files` 卡片下。

每个卡片显示带 favicon 的标签 chip，超出会出现 `+N more` 折叠展开按钮，每个 chip 自带"保存到稍后查看"和"关闭单个标签"的操作。卡片底部有"关闭整组"和"关闭 N 个重复标签"按钮。

### 固定网站

页面顶部一排"固定网站"图块（最多 10 个）。每个图块显示 favicon，点击在新标签中打开。可拖动重新排序；点旁边的齿轮按钮进入管理抽屉，增删改。

### 快速跳转 + 参数记忆

页面顶栏下方是一排 chip 选择器——你保存的搜索模板。每个模板是一个包含一个或多个 `{}` 占位符的 URL。点 chip、输入参数、回车（或点 **Go**）就跳过去。每个模板会记忆你最近用过的参数（最多 3 个，按 MRU），在输入框聚焦时以下拉形式显示。

快捷键：

| 快捷键 | 行为 |
|---|---|
| `Cmd/Ctrl + K` | 聚焦快速跳转输入框 |
| `Cmd/Ctrl + 1` … `Cmd/Ctrl + 5` | 选中第 1-5 个 chip |
| `Enter`（在输入框内） | 触发跳转 |
| `Esc` | 关闭任何已打开的抽屉 |

### 稍后查看

把鼠标放到任一标签 chip 上，点收藏按钮，这个标签就被存进右侧"Saved for later"清单。点前面的勾选框表示已处理，它会自动归入归档区。点 `Archive (N)` 切换按钮展开归档；归档区内有搜索框做过滤；点 **Clear archive** 一键清空整个归档（带二次确认）。

### 重复标签检测

如果多个标签 URL 完全一致，对应的 chip 上会出现一个琥珀色 `(Nx)` 徽标显示重复数量，所在卡片会出现 "Close N duplicates" 按钮。点 chip 上的 × 一次关一份，徽标计数会原地递减，直到只剩一份。开了多个 Tab Out 新标签页本身？顶部 banner 会提示并提供 "Close extras" 一键关掉。

### 卡片内操作

- **关闭一个标签** — chip 上的 `×`
- **保存一个标签到稍后查看** — chip 上的书签图标
- **关闭整张卡片所有标签** — 卡片底部按钮（按 hostname 匹配；Homepages 和自定义分组卡片改用精确 URL 匹配，避免误关同 hostname 下的其它标签）
- **去重** — "Close N duplicates" 保留最近用过的那个副本

---

## 配置（可选）

在 `extension/config.local.js`（gitignored，不会上传）里预置固定网站、搜索模板、分组规则。

```js
const LOCAL_LANDING_PAGE_PATTERNS = [
  { hostname: 'mail.example.com', pathExact: ['/'] },
  { hostnameEndsWith: '.notion.so', pathPrefix: '/' },
];

const LOCAL_CUSTOM_GROUPS = [
  { hostnameEndsWith: '.example.net', groupKey: 'work', groupLabel: 'Work' },
];

const LOCAL_PINNED_SITES = [
  { title: 'GitHub', url: 'https://github.com' },
];

const LOCAL_SEARCH_TEMPLATES = [
  { label: 'RDS', urlTemplate: 'https://cloud.example.com/rds/{}/detail' },
];
```

`LOCAL_LANDING_PAGE_PATTERNS` 和 `LOCAL_CUSTOM_GROUPS` 每次渲染都会读取生效。`LOCAL_PINNED_SITES` 和 `LOCAL_SEARCH_TEMPLATES` 是 **seed-only**——只在首次运行、storage 对应 key 为空时被复制进 storage。之后通过 UI 修改。

仓库里有一个起步模板：[`extension/config.local.example.js`](./extension/config.local.example.js)。

### UI 内的 导出 / 加载

在"固定网站"和"快速跳转"两个管理抽屉的底部，都有一块 **Config file** 区域：

- **Export to `config.local.js`** — 下载一份与当前 storage 一致的 `config.local.js`。把它放回 `extension/config.local.js`，就把当前配置固化到了源码里。
- **Load from `config.local.js`** — 读当前已加载的 `config.local.js`（扩展加载时已读入内存）并 **覆盖** storage 里的 pinned + templates。模板参数历史会被清空，因为模板 ID 被重新生成。

适合在一次集中配置后做备份、把同一套配置带到另一台机器、或者在 `chrome.storage.local` 丢失后快速重建。

---

## 工作原理

| 层 | 实现 |
|---|---|
| 扩展 | Chrome Manifest V3，仅需三个权限：`tabs`、`activeTab`、`storage` |
| 存储 | `chrome.storage.local`（不同步、不联网、无埋点） |
| 布局 | 仪表盘用 CSS `columns` 实现 masonry 瀑布流；头部和抽屉用 flex / grid |
| 音效 | Web Audio API——关闭标签的 swoosh 音效是运行时合成出来的，没有音频文件 |
| 动画 | 纯 CSS transition + 一套手写的小型 confetti 粒子系统 |

整个应用是一份 `extension/app.js` 加 `index.html` / `style.css`，没有打包器、没有转译器、没有构建。修改任意文件 → reload 扩展 → 立即生效。

---

## 致谢

最初由 [**Zara Zhang**](https://github.com/zarazhangrui) 创建，上游仓库：[zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out)。

本 fork 由 [**Zackie**](https://github.com/lingduo1994) 维护，地址：[lingduo1994/tab-out](https://github.com/lingduo1994/tab-out)。

---

## 许可

MIT
