-- 修复 billing 消费记录与生成任务之间的并发竞态：
-- 强制 (ref_type, ref_id) 在 spent 与 refund 流水中唯一，
-- 从数据库层面杜绝两个并发请求绑定同一笔消费记录或重复退款。
--
-- 设计要点：
--   1. 只对 kind='spent' 且 ref_id IS NOT NULL 的行建立唯一约束，
--      不影响历史明文记账（ref_id=NULL 的行不受约束）。
--   2. refund 流水同样加唯一约束，确保同一 ref_id 最多退一次款。
--   3. 使用 partial unique index（WHERE 子句），SQLite 3.8.0+ 支持。
--   4. 如果历史数据中已存在重复 (ref_type, ref_id) 的 spent/refund 记录，
--      CREATE UNIQUE INDEX 会失败；这种重复只可能由旧版 update_spent_ref_id
--      竞态产生，需要在升级前手动清理（见 db.rs 中的迁移前清理逻辑）。

-- spent 流水：(ref_type, ref_id) 唯一，防止同一生成任务被重复扣费
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txn_spent_ref_unique
    ON credit_transactions(ref_type, ref_id)
    WHERE kind = 'spent' AND ref_id IS NOT NULL;

-- refund 流水：(ref_type, ref_id) 唯一，防止同一生成任务被重复退款
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_txn_refund_ref_unique
    ON credit_transactions(ref_type, ref_id)
    WHERE kind = 'refund' AND ref_id IS NOT NULL;