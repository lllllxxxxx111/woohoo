# 工程安排（2026-09 起）

> 本文档是跨主题的执行安排，整合「缓存命中率」主题收尾、封闭 Beta 稳定化 v1.2 收尾
> 与后续迭代的推进顺序。各主题的技术细节以各自版本化 PRD 为准；
> 稳定化基线见 [closed-beta-stabilization-prd.md](closed-beta-stabilization-prd.md)。

## 0. 状态快照（2026-09-05）

| 项 | 状态 |
|----|------|
| 分支 `codex/content-version-history` | 已推送远端；v0.2–v0.5 四个提交（`2835aef` → `95bdafb` → `7ec08be` → `2b145e5`） |
| 历史重写 | 推送前已用 filter-branch 移除历史中 385MB 的 `eval-results/downloads/JVZUMA_tempest_quick.zip`（HEAD 树验证不变）。**旧哈希 8f49a93/5acdf0f/c460658/2bf4dbc 全部失效** |
| 本地门禁 | Rust 298 tests / fmt / clippy 127 存量零新增；前端 286 tests / lint 8 存量 / build；三套 compose config |
| CI | `ci.yml`：前端 lint/typecheck/test/build + 服务端 fmt/clippy --all-targets/test + 三套 compose，全部与本地门禁一致，PR 触发 |
| 待办阻塞 | staging 环境（工作流 B、C 的前置条件） |

## 1. 工作流 A：合入主线（无需环境，立即可做）

1. 发 PR：`codex/content-version-history` → `main`（入口：<https://github.com/lllllxxxxx111/woohoo/pull/new/codex/content-version-history>，本机无 gh CLI）。建议 PR 描述直接引用主题索引 `docs/conversation-cache-hit-rate-prd.md` 与本文件第 0 节。
2. 等 CI 绿（本地已预验证同组门禁；clippy / lint 以报告形式运行，存量 warning 不会阻塞）。
3. Review 合并。合并后 `main` 包含：缓存命中率 v0.2–v0.5 全链路 + 本文件。

## 2. 工作流 B：staging 真实演练（v1.2 唯一待办）

**前置条件**（缺一即推迟，均需人工提供）：真实 staging 环境、冻结写入窗口、发布负责人签字确认。

**演练步骤**（记录模板：`docs/prd/closed-beta-stabilization/v1.2/evidence/`）：

1. 快照：备份 staging 库与数据目录。
2. 候选部署：部署 `main` 合并后的构建。
3. 冒烟：核心流程（登录、会话聊天含流式、任务、图片生成、计费扣减、用量面板）。
4. 专项：截断开关演练——设 `AI_CHAT_HISTORY_TRUNCATION_ENABLED=false` 重启，确认长会话请求恢复全量历史；再切回 `true`。
5. 恢复：从快照恢复，回切旧版本，确认可用。
6. 签字归档，v1.2 收口。

## 3. 工作流 C：缓存命中率效果采集（部署后观察 1–2 周）

依赖工作流 A（合并部署）。直接查 `ai_usage_events` 或读 v0.4 面板。目标口径见 v0.3 PRD 第 4.2 节——**本阶段建立基线，不设硬指标**。

```sql
-- 1) 整体供应商命中率（分母=全部 prompt tokens，保守口径）
SELECT COUNT(*) AS requests,
       COUNT(cached_prompt_tokens) AS reported,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(cached_prompt_tokens), 0) AS cached_tokens,
       ROUND(100.0 * COALESCE(SUM(cached_prompt_tokens), 0) / SUM(prompt_tokens), 1) AS hit_ratio_pct
FROM ai_usage_events
WHERE created_at >= :since;

-- 2) 服务端探针分布（按通道；task/chat 非流式 + stream）
SELECT operation,
       COUNT(prompt_prefix_hit_ratio) AS measured,
       ROUND(AVG(prompt_prefix_hit_ratio) * 100, 1) AS avg_pct,
       ROUND(MIN(prompt_prefix_hit_ratio) * 100, 1) AS min_pct
FROM ai_usage_events
WHERE created_at >= :since
GROUP BY operation;

-- 3) v0.5 流式透传效果：流式记录 actual 占比应显著上升
SELECT operation, token_source, COUNT(*) AS n
FROM ai_usage_events
WHERE created_at >= :since
GROUP BY operation, token_source;

-- 4) 会话维度 top10（与面板 by_conversation 对照）
--    直接读 v0.4 面板「会话缓存命中率」即可
```

关注点：

- 探针均值显著高于供应商命中值 → 该供应商缓存粒度/计费未对齐前缀（记录到 PRD 效果表）。
- `stream_options.include_usage 请求被拒绝` warn 日志 → 降级路径工作正常的证据（也应只在不兼容网关出现）。
- 与工作流 B 的开关演练对照：关闭截断前后探针占比差异。

## 4. 工作流 D：v0.6 候选（代码层，按收益排序）

| 优先级 | 方向 | 理由与粗估 |
|--------|------|-----------|
| ~~1~~ ✅ | ~~命中率趋势图~~ | **已完成（v0.6，2026-09-05）**：series 补 prompt_tokens 分母 + Dashboard 纯 CSS 柱状趋势，PRD 见 v0.6。 |
| 2 | 中间历史摘要压缩 | 被裁剪中间段用低成本模型出摘要，插入前缀之后——对长会话质量收益最大，但需要评估脚本验证质量，工作量最大。 |
| 3 | 显式 `cache_control` | 依赖具体网关能力（Anthropic ephemeral / 网关自定义头），需要按端点能力位实现，建议等效果采集确认供应商缓存行为后再投入。 |

启动条件：工作流 A 合并后可开工 1；2、3 建议等 C 的基线数据支撑取舍。

## 5. 技术债看板（非阻塞，随手清）

| 项 | 现状 | 说明 |
|----|------|------|
| clippy 存量 | 127 warnings（useless conversion 27、too-many-arguments ~35 等） | CI 报告形式；`build_usage_record`/`build_direct_usage_record` 参数继续膨胀，v0.6 动到 usage 链路时值得引入参数结构体 |
| 前端 lint 存量 | 8 warnings（0 error） | 同上 |
| usage summary SQL 无测试 | `fetch_totals` / `fetch_breakdown` 聚合口径无 DB 级单测 | v0.3 补列时已回归验证；后续改聚合时建议补 |
| 流式降级重试无自动化测试 | 400/422 降级路径（client.rs） | 需要 HTTP mock；已有人工日志口径 |
| 网络 | git 全局代理 = `127.0.0.1:12000`（用户指定；该端口进程未常驻）；7890 的 Clash 对 GitHub CONNECT 中断；直连间歇可用 | 推送可用 `git -c http.proxy= -c https.proxy= push` 临时绕过 |

## 6. 推荐执行顺序

```
A 合入主线（现在） ──► B staging 演练 ──► v1.2 收口
        │                    │
        └──► C 效果采集 ◄────┘（开关演练对照）
                 │
                 └──► D1 趋势图（随时） / D2 摘要压缩、D3 cache_control（看数据决策）
```

关键路径上唯一的人工依赖是 **staging 环境到位**；其余全部可以并行或按上表顺序自驱推进。
