-- 032: 清理 upload_session_parts 的遗留与孤儿行
--
-- 031 上线以来 parts 行从未随会话清理：
-- 1) 会话行被定期清理（终态满 24h）后，其 parts 行成为永久孤儿；
-- 2) 会话进入终态（completed/aborted/failed/expired）后 parts 行已无任何
--    读取方（续传只面向活跃会话），却要等到会话行被清理才可能被连带处理，
--    而清理路径此前也并未删除它们。
-- 每个会话最多可有 ~800 个分片行，长期运行会让该表无限膨胀。
--
-- SQLite 不支持为既有表追加 REFERENCES ... ON DELETE CASCADE（需要高风险的
-- 表重建），因此后续清理由应用层负责：会话进入终态 / 会话行被清理时同步
-- 删除 parts（见 upload_session.rs）。本迁移只做一次性存量清理。

DELETE FROM upload_session_parts
 WHERE session_id NOT IN (SELECT id FROM upload_sessions);

DELETE FROM upload_session_parts
 WHERE session_id IN (
     SELECT id FROM upload_sessions
      WHERE status IN ('completed', 'aborted', 'expired', 'failed')
 );
