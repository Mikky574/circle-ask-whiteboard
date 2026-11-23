# 圈问白板：当前架构与下一步契约

下一阶段的目标已调整为 [面向功能验收的多代理工作台](agent-orchestration-design.md)。该设计及其 [验收清单](orchestration-acceptance.json) 尚未实现：当前进程内并行请求、整板 CAS 与外部技能写入仍是下文所述机制，不能视为持久任务调度、并发项目改码或 TDD 集成闭环。

本页对应「代码仓库详解手册」中的当前架构章节。已实现部分依据共享存储与版本提交 `aae7027`，外部会话写入由本轮 `whiteboard-service` 技能补充。标为待实现的能力是需求与验收约定。

同期提交 `8bb6458` 增加导图阅读：用同一批卡号和关系显示标题树，正文在侧栏读取，不产生另一份白板结构。卡片内容与关系继续由服务共享；`mindmap.js` 的呈现偏好和阅读坐标当前保存在浏览器本地，不能把它描述为所有视图排布都已后台同步。本章对此作源码核对。

## 使用主线

打开项目或既有白板 → 确定当前板号和项目目录 → 读总览并展开模块 → 圈选提问或直接编辑 → 校验候选结构和运行身份 → 保存到本机服务 → 对照版本继续修改。

白板内调用模型时，`app.js` 通过 `/api/codex` 发送选区、项目约束、相关讨论和附件。`server.py`、`backends.py` 等执行后端负责请求及候选结果。收到文字还不代表已提交，浏览器必须检查终态和当前状态，再更新卡片。

外部 Codex/ZCode 已经完成调研时，可以直接用服务技能读取、定位、局部提案和提交；这条路线使用 `/api/board-store`，不需要为了写入成稿再次调用白板中的模型。

## 文档与事实源

| 对象 | 职责 | 实现 |
| --- | --- | --- |
| 项目清单 | 项目名称、目录和既有服务入口 | `local_projects.py` |
| 浏览器缓存 | 即时交互、未同步改动和恢复副本 | `memory.js`、`organization.js`、`board_sync.js` |
| 共享白板文档 | 卡片、讨论、父子关系、位置、折叠、规则和替换备份 | `board_store.py`、SQLite |
| 模型执行 | 上下文、权限、工具草稿与候选结果 | `server.py`、`backends.py`、`board_tools.py` |
| 外部会话写入 | 读当前结构、限定根卡更新、批量追加多层、CAS 提交与读回 | `whiteboard-service` 技能 |

服务一次保存四份文档：`memory`、`organization`、`templateBackup`、`guideBackup`。外部写入必须以原始完整文档为底稿，只改变授权范围内的字段。不能把精简的导出投影直接覆盖现有文档，否则会丢失撤销或备份状态。

## 外部 AI 的最小工作流程

推荐文件入口：`checkout --board ID --node E27 --out board-work` 一次导出完整分支、祖先路径、项目规则和读取版本，模型只写 `proposal.json`。`submit --workspace board-work` 预览，追加 `--commit` 后提交并生成回执。服务仍是事实源；本地上下文文件只是阅读投影，不能整体覆盖现有文档。该入口复用以下范围、版本和读回约束，不要求模型手抄修订号。

1. 用 `list` 核对板号、标题和项目目录。
2. 用 `find`、`read --node` 核对目标父卡、祖先路径、直属下级和版本号。
3. 写有 `rootId` 的 JSON 提案：同一对象更新原卡，新细节通过 `children` 挂到明确父卡。嵌套 children 可一次建立多层。
4. 默认 dry-run，核对范围与正式编号分配；用户已经要求更新时，加 `--commit` 提交，不再索要例行批准。
5. 带 `expected-revision` 保存，409 时停止、重读、重新合并；不能换成最新版本号盲目重试。
6. 读取服务端回执和保存后的文档，再用独立浏览器打开同一板号。

```text
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 list
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 read --board BOARD_ID --node E27
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 apply --board BOARD_ID --expected-revision N --file proposal.json
python scripts/whiteboard_service.py --url http://127.0.0.1:8797 apply --board BOARD_ID --expected-revision N --file proposal.json --commit --receipt receipt.json
```

这版技能处理已整理的 `organization.current.items`，不初始化空板、不删除、不重挂接现有节点、不修改项目绑定或凭据。CLI 回执记录本次根卡、修改卡号、创建卡号和前后版本；真正持久化的依据是服务端版本快照，当前没有独立的模块操作审计表。

## 三种“版本”要分清

| 名称 | 含义 | 当前状态 |
| --- | --- | --- |
| 白板修订 vN | 同一板号每次成功保存的快照 | 已实现 |
| Fork 来源版本 | 新板来自哪个板号的哪一版；新板从自己的 v1 开始 | 已实现 |
| 便携文件格式版本 1 | JSON 文件的结构协议，不能当作白板修订号 | 已实现 |

历史面板已支持文字预览、从某版 Fork、整板恢复。恢复是把旧快照写成新修订，中间历史保留。管理菜单的复制采用便携副本路径，版本面板的 Fork 则由后端保留 `forkedFrom`，两者来源信息不同。

普通便携导出使用 `circle-ask-whiteboard` 格式；故障恢复导出使用 `circle-ask-whiteboard-recovery-v1`，含浏览器副本。这两种格式不能互相假定可直接导入。附件保存引用，文件二进制和项目源码不会随普通 JSON 自动打包。

## 待实现：历史画布只读切换

用户选版本后应直接浏览该版的整张画布，清楚显示板号、修订和只读状态。浏览历史期间应禁用会写当前板的拖动、删除、整理和模型落板；可返回最新版，或从所看版本 Fork。现有历史 `load` 可复用，画布切换和只读保护尚未实现。

验收：只读浏览历史后，当前板修订、内容和位置均不改变；从历史 Fork 后获得独立板号及准确来源版本；回到最新版恢复正常编辑。

## 待实现：单个历史版本删除

当前 `delete` 作用于整张白板，保留历史和删除标记。它不是删除某一版。单版删除需要先定义逻辑删除与回收规则：当前版不能直接移除；被 Fork 来源或操作回执引用的版本应受保护；删除行为不能破坏其他版本和子分支的追溯。

验收：删除非当前、无受保护引用的候选版本后，其他历史和当前板保持不变；非法删除给出具体原因；逻辑删除可从回收入口还原。此为拟议契约，当前没有对应接口。

## 待实现：只撤销本次模块操作

现有整理、快排、连线和删除各有自己的上一步撤销；服务恢复作用于整张白板。要只撤销某一次模块修改，应保存操作编号、根卡与卡号范围、修改前后版本，以及字段差异。

撤销采用“操作前、操作后、当前”的三方比较：仅回退当前仍等于本次结果的字段。若本次新增卡已经被继续编辑、增加后代或被范围外节点引用，先显示冲突。无冲突时以 CAS 写成新版本，保留其他分支的新工作。

验收：先改 A，再独立改 B，只撤销 A，B 的文字、位置和关系保持；A 的父子树、讨论锚点和折叠仍有效；刷新、冲突、后续编辑与再次还原均可核对。通用模块级持久化操作记录及其 UI 尚未实现。

## 修改与验证入口

同步看 `board_sync.js`；事务、历史与 Fork 看 `board_store.py`；版本面板看 `board_versions.js`；结构与布局看 `organization.js`；交互与候选应用看 `app.js`；文件交换看 `board_transfer.js`；外部接入看服务技能。

共享保存与历史：`test_board_store.py`、`test_shared_boards_browser.mjs`。外部写入范围与回执：`test_whiteboard_service.py`。导入导出：`test_board_transfer.js`、`test_board_transfer_memory.js`、`test_board_transfer_browser.mjs`。模拟模型或隔离服务通过不等于真实供应商调用通过。
