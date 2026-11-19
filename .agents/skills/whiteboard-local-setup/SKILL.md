---
name: whiteboard-local-setup
description: Initialize the Circle Ask Whiteboard service, scan chosen local directories for projects, maintain its private catalog and parent-child project navigation, or initialize a board for a registered project.
---

# 圈问白板本机初始化

在包含 `server.py` 和 `local_projects.py` 的圈问白板仓库根目录运行以下命令。需要 Python 3.10 或更新版本。

```powershell
python -B server.py
```

如果端口 8797 已占用，先访问 `http://127.0.0.1:8797/api/status` 检查是否已有白板服务。项目入口为 `http://127.0.0.1:8797/?board=project-workbench`。浏览、搜索和打开 Windows 文件夹无需 AI 连接。生成工程介绍时，在项目自己的「项目画布」中配置可用的 Codex 或 ZCode，点「初始化工程介绍」。

## 扫描和登记

1. 从用户指定的工程目录开始。使用本技能目录下的 [scan_projects.py](scripts/scan_projects.py) 查找候选，`--depth` 控制相对扫描根目录的最大深度，默认 2。候选来自 Git 标记、README 和常见项目清单。扫描结果是供核对的 JSON，输出到终端。

   ```powershell
   python -B .agents/skills/whiteboard-local-setup/scripts/scan_projects.py --depth 2 "D:\Projects"
   ```

2. 核对候选的 README、构建清单或实际入口文件，提炼中文简介和用户熟悉的别名。没有常见标记的模型、数据准备或笔记项目可在核对用途后手动登记。若一个目录本身也是总项目，给它单独登记一张卡片。白板会把其下项目归入最近的已登记上级目录。
3. 在 `WHITEBOARD_PROJECTS_FILE` 指定的路径维护清单，未设置时使用 `~/.circle-ask-whiteboard/projects.local.json`。保留已有条目和用户编辑的简介，按规范化的绝对目录合并。清单是 UTF-8 JSON 数组，每项含 `name`、`description`、`category`、`path`，可选 `aliases` 字符串数组。单项长度和去重规则见 `local_projects.py`。
4. 在仓库根目录运行以下命令验证当前清单可加载，再刷新本机入口，按名称或用途查找一个项目。确认父项目能进入下一层，子项目的画布显示自己的目录。

   ```powershell
   python -B -c "from local_projects import load_catalog; print(len(load_catalog()))"
   ```

项目编号由规范化的目录路径生成。迁移到新电脑时先逐一适配路径，再生成清单。若同时迁移项目的 AI 动作快照，核对并更新对应的 `projectId` 和快照文件名。

白板内容与目录由本机服务保存，默认数据库为 `~/.circle-ask-whiteboard/boards.sqlite3`；`WHITEBOARD_BOARDS_FILE` 可指定其他 SQLite 文件。内置和外部浏览器打开同一板号时读取同一数据库。首次升级需用原来保存内容的浏览器和原地址打开新版页面一次，迁移旧记录；迁移不会用旧副本覆盖已有服务端内容。初始化或修改完成后等待「已保存到本机服务」，再刷新核对。

项目清单、动作快照、附件、白板数据库、浏览器缓存、恢复备份和凭据留在本机。同步 GitHub 前查看全部待推送提交的文件列表和内容，只提交代码、可移植的技能文件和通用文档。
