# Staging DB Rollback Drill

## 目标

这份演练用于验证当前数据库迁移链路满足两件事：

1. 新版本启动后可以自动完成 schema/backfill 升级。
2. 发现 P0/P1 问题时，可以通过恢复迁移前 SQLite 快照，安全回切到上一版本。

当前演练覆盖的迁移重点：

- `008_ai_tasks_persistence`
- `009_ops_schema_conflict_backfills`
- `010_agent_scope_backfills`

## 适用范围

- 默认 SQLite 路径：`sqlite://data/woohoo.db?mode=rwc`
- 自定义路径：通过 `DATABASE_URL` 指定
- 快照脚本：`node scripts/staging-db-rollback-drill.mjs`

## 前置条件

1. staging 环境当前没有正在写入数据库的旧 server 进程。
2. 已准备好“候选版本”和“上一稳定版本”的可启动代码或二进制。
3. 可访问当前 server 的 `/health`。
4. 若端口可能漂移，允许读取 `data/runtime/server-info.json` 获取实际 `health_url`。

## 演练步骤

### 0. 一键本地演练

如果只是验证本地回滚链路，可以直接执行：

```powershell
npm run drill:rollback:local
```

它会自动完成：

1. 停掉当前本地后端
2. 生成数据库快照
3. 启动候选后端并检查 `/health`
4. 恢复快照
5. 再次启动后端并检查 `/health`
6. 在快照目录写出 `run-report.json`

这条命令用于本地 drill，不替代真实 staging 的跨版本回滚验证。

### 0.1 一键本地跨版本演练

如果要在本机上模拟“上一稳定版本 -> 候选版本 -> 恢复到上一稳定版本”的完整链路，可以执行：

```powershell
npm run drill:rollback:cross-version -- --stable-binary <old-server-binary>
```

脚本会：

1. 用旧版 binary 在独立 drill 数据库上启动服务
2. 通过 HTTP 注册用户并创建项目
3. 对该数据库做快照
4. 切到候选 binary 启动并校验旧数据可读
5. 恢复快照
6. 再次用旧版 binary 启动并校验项目仍可读

这条命令适合本地跨版本模拟，不替代真实 staging 的部署制品验证。

### 1. 记录当前数据库位置

```powershell
node scripts/staging-db-rollback-drill.mjs status
```

确认输出中的：

- `databaseUrl`
- `dbPath`
- `existingFiles`

如果 `existingFiles` 为空，先停止这里的演练，确认 staging 是否使用了别的 `DATABASE_URL`。

### 2. 生成迁移前快照

```powershell
node scripts/staging-db-rollback-drill.mjs snapshot pre-release
```

记录输出里的 `snapshotDir`。  
这个目录会同时保存：

- 主数据库文件
- `-wal`
- `-shm`
- `metadata.json`

### 3. 启动候选版本

示例：

```powershell
cargo run --manifest-path server/Cargo.toml
```

如果 staging 用的是部署制品，就按实际部署方式启动候选版本。

### 4. 验证迁移和服务健康

优先检查 server 日志，确认出现：

- `数据库迁移与补数报告`
- 没有 `数据库迁移后仍存在兼容问题`

然后做健康检查：

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" -UseBasicParsing).Content
```

如果端口不是 `8080`，读取 `data/runtime/server-info.json` 里的 `health_url` 再访问。

建议最少再补两条业务冒烟：

1. 访问 `/api/workspace/bootstrap`
2. 打开一个已有项目，确认消息、agent 绑定、任务恢复没有立即报错

### 5. 触发回滚

满足任一条件即进入回滚：

- 候选版本出现 P0/P1 缺陷
- migration/backfill 后日志出现新兼容问题
- 冒烟链路失败，且无法在灰度窗口内修复

### 6. 恢复迁移前数据库

先停止候选版本，再执行：

```powershell
node scripts/staging-db-rollback-drill.mjs restore <snapshotDir>
```

恢复脚本会：

1. 先把当前数据库文件另存为 `_pre_restore_<timestamp>`
2. 删除当前主库和 `-wal/-shm`
3. 用快照内容恢复数据库

### 7. 启动上一稳定版本

按上一版本的实际启动方式重启 server，然后再次验证：

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" -UseBasicParsing).Content
```

再补两条回滚后冒烟：

1. `/api/workspace/bootstrap` 返回 200
2. 选一个已有项目，确认能读取对话、资产和 agent 配置

## 演练通过标准

以下条件同时满足，才算 staging 回滚演练通过：

1. 候选版本能在快照后的数据库上成功启动并通过 `/health`
2. 启动日志输出 schema/backfill 报告，且没有残留兼容问题
3. 执行 restore 后，上一稳定版本能重新启动并通过 `/health`
4. 回滚后已有项目数据可读，没有出现缺表、缺列、外键指向错误

## 当前仍保留的 runtime backfill 钩子

启动报告里现在会显式列出以下兼容钩子：

- `ensure_pipeline_runs_schema`
- `ensure_pipeline_orchestrator_schema`
- `ensure_ai_usage_schema`
- `ensure_message_updated_at_schema`
- `ensure_agents_schema`
- `ensure_project_agent_assignments_schema`

这些钩子仍然存在，说明 migration 主导化还没有彻底收口。  
后续下线顺序建议：

1. `pipeline` 两项
2. `ai_usage / messages`
3. `agents / project_agent_assignments`

## 产出物

每次演练至少保留以下记录：

1. 候选版本 commit / tag
2. 上一稳定版本 commit / tag
3. `snapshotDir`
4. 候选版本启动日志片段
5. 回滚后健康检查结果
6. 是否通过，以及失败原因
