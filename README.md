# 圈问白板

一个从功能视角组织本机项目资料的 AI 工作台。当前重点是读懂代码仓的用途、提炼可观察的功能，再按使用场景逐层查看实现与证据。总览与功能卡独立说明使用者、输入、结果、边界和核对方式，文件依据放在详情。[功能提炼与阅读层级](docs/functional-reading.md) 说明解析规则与当前限制，[项目定位](docs/product-direction.md) 区分已有能力和后续目标。

当前提供项目结构图、实验与源码证据阅读、沿卡片问答和局部修改。下一阶段的任务调度与验收见 [功能验收与多代理调度设计](docs/agent-orchestration-design.md) 和 [验收清单](docs/orchestration-acceptance.json)。

**从首页开始。** 打开或添加本机项目，进入资料阅读。空白板可以先写一张主干卡，也可以从源码生成工程介绍。项目资料菜单可查看子项目、目录和 AI 动作。

白板副本与文件交换见 [导入、导出与副本](docs/whiteboard-portability.md)。

## 启动

需要 Python 3.10 或更新版本。在仓库根目录运行。

```powershell
python -B server.py
```

默认只启动 8797 一个本机端口。打开 [本地首页](http://127.0.0.1:8797/)，顶部 **使用指南** 可以查看四个技能、原文与文件工作流。[直接打开指南](http://127.0.0.1:8797/guide)

打开白板后，在 **连接设置** 里选择 Codex、ZCode 或 API 直连。CLI 模式需要终端能找到并运行已登录的对应 CLI。模型留空时使用该 CLI 的默认模型。Codex 可填写模型 ID，ZCode 可填写其配置中的 `供应商ID/模型ID`。

Codex 沿用本机 `codex login`。ZCode 沿用本机 CLI 配置和登录，可以按账号地区运行 `zcode login bigmodel` 或 `zcode login zai`。可用模型取决于对应账号和供应商配置。ZCode 不在 `PATH` 时，可以在启动前把环境变量 `WHITEBOARD_ZCODE_EXECUTABLE` 设为 CLI 路径。[ZCode CLI 文档](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli)

## 操作

- 打开项目后默认进入知识图谱。点节点在图下阅读卡片与直接关系，用「1 跳」「2 跳」「3 跳」探索附近资料，或切到项目全图。侧栏可搜卡号、标题、正文、下级资料、对比指标和附件名，点结果把对应节点移到中心。
- 在节点详情点「AI 沿图补资料」。模型读取当前卡、已有分支和关系，推荐补卡或关联已有卡。候选连线用虚线预览，勾选后保存到同一白板。
- 「模块关系图」保留项目原有的模块阅读、实验对比与子模块白板。
- 拖动结构图空白处平移。用图上的加减按钮或按住 Ctrl / ⌘ 滚动缩放。点「适应」显示整张图。
- 在「搜卡」中按编号、标题或文字查找，也可用「按问题定位」匹配相关内容。匹配项在资料阅读区打开。
- 卡片详情里的「问这张卡」会携带卡片内容和相关附件。可拖入文件、按 Ctrl+V 粘贴截图或点「添加附件」。发送后可在任务区查看状态和停止请求。回答保存后点「查看回答」。
- 用「编辑原卡」修改卡片。右键卡片可手动新建子卡，或点「AI 向下延伸」生成可勾选的候选。用「提意见让 AI 改」预览对当前卡或下级的修改，再选要应用的内容。
- 在空白板点「写第一张卡片」，也可用 Codex 或 ZCode 点「初始化工程介绍」。生成的卡片和模块图随白板保存。点「撤销整理」可返回上一版。
- 白板由本机服务统一保存。等到页面显示「已保存到本机服务」再分享白板链接。可以在版本面板预览、恢复或创建白板分支。

## 本机项目入口

初始化、查找本机工程和维护项目清单可使用 [whiteboard-local-setup 技能](.agents/skills/whiteboard-local-setup/SKILL.md)。

从外部 Codex 或 ZCode 会话把做完的工作更新到白板，可使用 [whiteboard-content-handoff 技能](.agents/skills/whiteboard-content-handoff/SKILL.md)。它会核对目标白板、父卡和证据，再选择初始化空白板、编辑已有卡片或追加下级，并刷新验证结果。在外部会话可以给出任务「用 whiteboard-content-handoff，把当前验收结论更新到这张白板的对应分支」，附可编辑白板链接。

外部会话直接交付已完成的内容时，优先用 [whiteboard-service 技能](.agents/skills/whiteboard-service/SKILL.md)，无需代理浏览器，也无需再次调用模型。先运行 `python scripts/whiteboard_service.py --url http://127.0.0.1:8797 probe` 检查用户实际打开的端口，再读取板号、根卡、版本并提交局部提案。目标板不存在就停止核对，不能另建同名板代替。第一版不初始化空板、不删除或重挂已有节点。白板内的 Codex／ZCode 请求则是另一条路径：后端返回候选，前端校验后保存；模型完成回答不等于内容已保存。使用主线、现有能力和版本/模块恢复的待补契约见 [当前架构说明](docs/current-architecture.md)。

外部 AI 也可以直接使用文件工作目录：`checkout --board ID --node E27 --out board-work` 导出目标分支的完整上下文及提交信息，编辑 `board-work/proposal.json` 后，运行 `submit --workspace board-work` 预览，再加 `--commit` 保存并读回。命令均从 `python scripts/whiteboard_service.py` 进入。脚本固定读取时的服务、板号、父卡和版本，版本过期就停止，工作文件不会自动上传或替代服务数据库。提案格式见 [局部提案参考](.agents/skills/whiteboard-service/references/proposals.md)。

[首页](http://127.0.0.1:8797/) 展示本机的顶层项目。点「添加项目」填写名称和本机已有目录，保存后打开项目白板。同一目录再次添加时打开原项目。父项目内的「子项目」显示下一层卡片，页面顶部的路径导航可返回上一级。搜索也可以匹配子项目。

每张项目卡片显示简介和目录。「打开项目」进入项目知识图谱。「项目资料」可查看子项目、AI 动作或目录。首次进入空白板，可点「写第一张卡片」或使用 Codex/ZCode 初始化工程介绍。点「关闭项目」回到首页。已保存的卡片和目录在重新打开时恢复，未发送或未保存的草稿会在离开前提示。Windows 上可点「打开文件夹」在资源管理器查看目录。

项目的本机动作快照放在清单旁的 `workbench-activity/<项目编号>.json`，文件内的 `projectId` 须与项目链接中的 `project` 一致。也可继续使用带同一字段的 `workbench-activity.local.json`。快照可提供项目状态、项目卡片、关联动作、来源和指导选项。没有快照的项目仍可打开项目白板，AI 动作页显示空状态。

已有项目介绍时，可以在快照中用 `initialBoard` 提供 `title`、`summary`、`items` 和 `collapsedBranches`。介绍应用于空白板，包括曾经打开并保存过的空板。用卡片的 `parentId` 表示层级，`sources` 填相对于绑定目录的源码路径。白板加载并保存介绍后，可继续编辑和展开，已有卡片与讨论保留。

本机项目快照的 `cardRequirements` 可为已有卡片关联需求。每项用 `cardId` 关联画布卡片，提供 `requirementId`、`title`、`need`、`method`、`validation`（每项为 `id`、`title`、`condition`）及已上传的 `attachment` 引用。白板上查看需求、实现和验收要点，详细说明可从附件打开。选中该卡继续提问时会携带关联说明和附件。

方法较长时，可选填 `methodDetails`，每段填写 `title` 和 `description`。卡片正文中的「实现细节」可展开查看这些段落。对照图或实验记录可用 `evidenceAttachments` 挂在同一需求下，最多四项。

项目资料保存在当前用户主目录下的 `.circle-ask-whiteboard/projects.local.json`，也可用环境变量 `WHITEBOARD_PROJECTS_FILE` 指定清单。清单使用 UTF-8 JSON 数组。每个项目包含 `name`（名称）、`description`（简介）、`category`（类别）和 `path`（本机绝对目录路径）。可用 `aliases` 补充常用叫法、缩写或用途短语。每个项目归入最近的已登记上级目录，编辑清单后刷新总览即可更新。

项目已有独立的本机白板服务时，可在本机清单为该项目设置 `boardUrl`，填写包含本机地址、端口和 `?board=…` 的原白板链接。「打开项目」会访问该服务的白板。使用新版存储的服务默认共用本机白板数据库，同一板号不会因切换浏览器或本机端口而分成两份；旧服务需升级并重新启动。

```json
[
  {
    "name": "示例项目",
    "description": "包含训练脚本和评估报告。",
    "category": "模型实验",
    "path": "D:\\项目\\示例项目",
    "aliases": ["训练评估", "核对模型指标"]
  }
]
```

## 手册的仓库源码索引

资料阅读区的「实现依据」会显示卡片引用的相对文件路径和已有源码片段。仓库源码索引仍可用于开发维护，调用方式和范围见下方说明。

这个功能使用单独安装的 GitNexus 1.6.12，要求 Node.js 22.18+ 或 24.11+。Windows 启动服务前可运行以下命令，服务会自动识别此目录。其他安装位置可以在启动前将 `WHITEBOARD_GITNEXUS_CLI` 指向 GitNexus CLI 入口的绝对路径。

```powershell
$repoIndexHome = Join-Path $env:LOCALAPPDATA 'CircleAskWhiteboard\tools\gitnexus\1.6.12'
npm install --prefix $repoIndexHome gitnexus@1.6.12 --no-audit --no-fund
```

服务在临时副本上以 `--index-only` 建立静态索引，覆盖本项目允许读取的实现文件。本机首轮扫描约 74 秒，服务运行期间会复用相同源码快照的结果。快照变化后需重新扫描。查询只展示能从源码静态解析的直接调用，浏览器与 Python 之间的 HTTP 跳转需要结合手册和源码。索引与查找在本机完成，独立于白板内容和模型连接。GitNexus 采用 PolyForm Noncommercial 1.0.0 许可证，单独安装使用。[GitNexus CLI 文档](https://github.com/abhigyanpatwari/GitNexus/blob/main/docs/cli-reference.md) · [许可证](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)

## 本地数据与执行范围

白板目录、项目目录绑定、卡片与批注、父子关系、折叠与布局、项目规则及替换备份保存在本机服务的 `.circle-ask-whiteboard/boards.sqlite3`。浏览器中的副本用于缓存和保留未同步改动。服务选择仍是当前浏览器的设置。附件文件保存在用户主目录的 `.circle-ask-whiteboard/attachments`，可用环境变量 `WHITEBOARD_ATTACHMENTS_DIR` 指定其他本机目录。Python 服务只监听本机地址。智能体读取白板传入的选区、附件及相关上下文，整理结果由本地服务校验后再交给页面应用。

### 跨浏览器保存与旧白板迁移

默认情况下，同一系统用户启动的新版服务共用 `~/.circle-ask-whiteboard/boards.sqlite3`。可在启动前用 `WHITEBOARD_BOARDS_FILE` 指定另一份 SQLite 文件；使用不同文件的服务相互独立。数据库和附件留在本机，不提交 GitHub，也不会上传给模型。

共享身份是 **同一份服务数据库 + 同一板号**。绑定的项目路径用于分析源码，不会把白板写进该仓库，也不代表两张同名白板自动合并。本机 HTTP 服务不是公网云同步。不同浏览器不需要互相复制缓存；旧服务若没有 `/api/board-store`，必须升级并重启后才具备这种共享能力，刷新旧页面本身不能升级仍在运行的服务。

打开旧白板时，页面会把当前浏览器已有的白板迁入服务端。已有服务端版本时以服务端为准，并保留不同的浏览器副本供恢复，不用旧缓存覆盖最新内容。服务无法读取其他浏览器私有的数据：升级后需用**原来保存过内容的浏览器和原地址**打开一次，才可迁移其中的旧记录。

页面会区分正在保存、已保存、保存失败和版本冲突。服务不可用时，尚未同步的改动留在浏览器，不能把本地缓存当作交付成功。多个浏览器同时编辑时，服务校验版本号并拒绝旧版本覆盖；先保留当前草稿，刷新后对照合并。白板删除也保留版本标记，旧浏览器不会重新上传并复活已删白板。

白板约每 5 秒检查外部更新，页面恢复前台时也会检查。空闲且无草稿时自动重新载入整份服务文档，不直接替换运行中的内存对象；有草稿或模型任务时提示「服务端已有新版本」并暂停旧版写入，避免覆盖。API Key 不会为了自动刷新而被暗中保存。浏览器仍单独保存 AI 指导草稿和未发送附件；卡片正文、批注、父子关系、折叠、卡片视图布局和项目规则才是当前服务端共享范围。

### 白板版本与 Fork 分支

点保存状态旁的 **版本 vN · 分支**，可查看已保存的版本、预览旧正文、从当前或历史版本建立分支。每次保存都在服务端留下不可变的快照。**恢复** 会把旧内容写成一个新版本，当前与中间版本仍在历史中。

白板分支是一张有独立编号和版本历史的白板，保存来源板号、版本与名称，继承绑定的项目目录。改动分支不会改变原板。在分支的版本面板可 **打开原白板**，也可继续 Fork。它与卡片之间的父子分支不同：卡片分支组织内容，Fork 用于并行尝试不同方案。删除白板后保留历史与删除标记，旧页面不能无意复活它。

服务接口为 `POST /api/board-store`，支持 `list`、`load`、`save`、`delete`、`history`、`fork` 和 `restore`。`save` 一次提交元数据及 memory、organization、templateBackup、guideBackup 四份状态，使用 `expectedRevision` 校验版本；`load` 可指定 `revision`，`history` 按版本倒序分页。`fork` 从指定版本建立新板，由服务生成编号与来源关系；`restore` 同样校验当前版本号。API Key 和模型连接凭据不属于这些状态，沿用原来的不落盘规则。

可运行 `python -B -m unittest test_board_store -v` 检查持久化、版本、并发与故障恢复，运行 `node test_shared_boards_browser.mjs` 用临时真实服务和两个独立浏览器检查共享、迁移、Fork 与恢复。测试使用独立数据库，不写入用户白板。

ZCode 请求、带附件的 Codex 请求和所有 Codex 改码请求在临时目录内处理原型源码和附件。源码编辑成功后，服务检查提交状态，只将允许编辑的前端文件改动应用回项目。停止成功会保留已保存的回答和白板状态。

Codex 或 ZCode 运行时，右侧 **执行过程** 会实时显示工具步骤、文件路径和结果。展开步骤可查看服务提供的短源码片段或已应用的改动片段。本轮记录保留在当前页面。

操作判断、解释分支、任务拆分、整理或重写分支、整板整理、初始化和孤立卡归位都使用结构校验。白板能识别说明文字中唯一完整的 JSON。若 ZCode 的结果仍未通过校验，会在同一会话内尝试修正一次。失败时可在批注或 **执行过程** 查看具体原因和一段脱敏返回片段。

## API 直连

在连接设置选择 API 直连，填写模型 ID、兼容 OpenAI Chat Completions 的基础地址（例如 https://api.openai.com/v1）和 Key。Key 仅在当前页面内存中使用，不写入浏览器存储或服务器文件，刷新即清除。接口地址也不持久化。发送后所选上下文和附件将交给指定接口。

支持问答、白板整理、PNG/JPEG/WebP/GIF 图片和 UTF-8 文本；模型须支持对应输入。图片和文本合计上限 20 MiB，每个文本附件 120 KB。结构化整理仍由本机校验后应用。该路线不执行任意命令、不读取项目文件、不修改代码；此类任务继续选择 Codex/ZCode。只允许 HTTPS 接口或本机 HTTP 服务，禁止自动跳转以避免 Key 泄漏。不需要安装额外技能或沙箱。

从卡片发起的提问会提交该卡、相关分支和项目规则。整理时，API 可以调用白板工具更新候选草稿。模型结果经校验后保存。

## 离线卡片定位

点 **按问题定位** 会在本机对照问题、标题、摘要和祖先标题，折叠下级也参与匹配。普通关键词定位可直接使用。启用语义匹配时，在运行白板的 Python 环境安装 `numpy onnxruntime tokenizers`，将 [BGE-small-zh-v1.5 ONNX](https://huggingface.co/Xenova/bge-small-zh-v1.5/tree/main/onnx) 的 `model_int8.onnx` 保存为 `model.onnx`，并把同一版本的 [tokenizer.json](https://huggingface.co/Xenova/bge-small-zh-v1.5/blob/main/tokenizer.json) 放在同一目录。默认目录为用户目录下的 `.circle-ask-whiteboard/models/bge-small-zh-v1.5`，也可用 `WHITEBOARD_SEARCH_MODEL_DIR` 指定。运行时只读本地文件，缺少权重或依赖时使用本机词项匹配。

按问题定位最多索引当前白板的 4096 张有效卡片，显示最多 12 条匹配。长白板打开搜卡时会在后台建立索引。向量缓存保存在用户目录下的 `.circle-ask-whiteboard/search-vectors.sqlite3`，刷新和重启可复用。卡片内容或模型变更后会更新对应索引。定位和浏览结果仅使用本机 CPU。

可在搜卡里选择 **OpenJev 本地重排**。先由现有索引召回候选，再把问题与最多 8 张候选卡的简短内容发给本机 `127.0.0.1:8793/v1/systemone`。运行 [OpenJev](https://github.com/razorback16/openjev) 的 Laya 后端时，可用 `OPENJEV_LAYA_MODEL` 指定 [Laya Multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) 的本地权重目录，调用模型名为 `laya-1.0`。输入卡片编号会直接定位。若本地决策服务不可用，界面显示原有匹配结果并提示。
