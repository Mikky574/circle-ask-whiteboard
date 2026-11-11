# 隔离浏览器验收设计

状态：设计已落盘；仅允许 `acceptance/run_browser_acceptance.mjs` 启动的临时
`127.0.0.1` 随机端口服务。该服务只提供父目录静态文件和内嵌假适配器，绝不
导入或启动产品 `server.py`，不使用 8791，不访问网络，不运行 Codex/ZCode/API。

## 隔离与清理

- Playwright 使用已安装的 `msedge` executable path，临时 `mkdtemp` user-data-dir
  和全新 browser context；`serviceWorkers: 'block'`。
- 每例开始清空该 context 的 storage，且仅在当前临时 origin 写入合成 fixture。
  不读、不写默认浏览器 profile、任何产品用户 storage 或白板文件。
- 服务只监听 `127.0.0.1:0`；每一轮记录实际端口。所有 API 路由由脚本的假适配器
  处理，并将收到的 backend/requestId 记录为测试遥测；未实现的路由返回 404。
- `finally` 中关闭 page/context/browser/server 并删除临时 profile。若清理失败，报告
  必须明确列出残留路径/句柄；禁止按名称或端口扫描、终止用户进程。

## 场景与断言

| ID | 浏览器操作 | 假适配器流 | 关键断言 |
| --- | --- | --- | --- |
| U01 | 展开连接设置，逐一选择 Codex、ZCode、API 并填各自模型 | `/api/status` 返回三项能力及不同模型 | 三后端均可选；模型 datalist/占位按服务切换；API 字段仅 API 显示；状态仅是假能力，非真实可用性 |
| U02 | API 下输入 `TEST-ONLY-NOT-A-REAL-KEY`，发起整理并刷新 | 接收 API 请求，返回合法 map/done | key 仅在实时请求 DOM 中；不在 localStorage 或后续 DOM 文本；刷新后输入为空；报告/控制台无合成 key |
| U05-A | 整理后点停止，服务在取消响应后继续尝试 map/done | 延迟 NDJSON：status，等待 cancel，再写 map/done | 停止后 UI 不应用迟到候选，停止按钮回收，无未处理页面错误；记录 client cancel 命中 |
| U04-A | 整理开始后同页调用本地 localStorage 变化并触发 storage 语义 | 延迟 map/done | 已变更状态被保留，显示“结果未应用”类冲突提示，旧 map 不提交 |
| U04-B | page A 整理开始，page B（同一临时 context）修改同 origin storage | 延迟 map/done | page A 拒绝旧结果；证明 cross-page storage 分支而非仅纯函数 |
| U03 | 正常 API 整理成功后点“撤销整理” | 合法 map/done | 可见整理成功、撤销按钮出现，点击后恢复整理前状态 |

每次场景挂接 `pageerror`、console error、request failed 收集器；任何 JavaScript
错误均使该例 FAIL。所有流均由 page UI 操作发起；仅为制造竞争条件，测试在页面
上下文修改自己的临时 localStorage。

## 结果分类

- PASS：上述动作与断言均完成，且无 JS 错误。
- FAIL：产品行为与断言不一致；保留截图、相应假适配器遥测和安全去敏后的错误。
- BLOCKED：Edge/Playwright 或 UI 前置条件不可用；不能把静态/单元结果写成浏览器通过。
- `api`/`codex`/`zcode` 仅代表假服务分支，真实三后端一律 `NOT_RUN`。

输出：`browser-report.json`（机器可读）和 `browser-report.md`（摘要），失败或关键
成功状态可生成 `screenshots/*.png`。报告记录命令、随机端口、Edge 版本、各例结果、
模拟声明及清理状态；绝不记录合成 key 原文。
