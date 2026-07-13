use std::collections::HashMap;

use anyhow::Result;
use sqlx::SqlitePool;

use super::model::MessageKind;
use super::repo;

/// 循环检测信号
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopSignal {
    HighFingerprintRepeatRate,
    NoStateChangeInRecentRounds,
    NoNewReadyAssignments,
    PingPongBetweenAgents,
}

impl LoopSignal {
    pub fn as_str(&self) -> &'static str {
        match self {
            LoopSignal::HighFingerprintRepeatRate => "high_fingerprint_repeat_rate",
            LoopSignal::NoStateChangeInRecentRounds => "no_state_change_in_recent_rounds",
            LoopSignal::NoNewReadyAssignments => "no_new_ready_assignments",
            LoopSignal::PingPongBetweenAgents => "ping_pong_between_agents",
        }
    }
}

/// 循环检测器
pub struct LoopDetector;

impl LoopDetector {
    /// 执行循环检测，返回检测到的信号列表
    pub async fn detect(pool: &SqlitePool, session_id: &str) -> Result<Vec<LoopSignal>> {
        let session = repo::get_session(pool, session_id).await?;

        if session.round_count < 5 {
            return Ok(vec![]);
        }

        let mut signals = Vec::new();

        signals.extend(Self::check_fingerprint_repeat(pool, session_id).await?);
        signals.extend(Self::check_no_state_change(pool, session_id).await?);
        signals.extend(Self::check_ping_pong(pool, session_id).await?);

        Ok(signals)
    }

    /// 检查问题指纹重复率
    async fn check_fingerprint_repeat(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Vec<LoopSignal>> {
        let fingerprints = repo::get_recent_fingerprints(pool, session_id, 5).await?;

        let non_empty: Vec<&str> = fingerprints.iter().filter_map(|fp| fp.as_deref()).collect();

        if non_empty.len() < 3 {
            return Ok(vec![]);
        }

        let mut freq: HashMap<&str, i32> = HashMap::new();
        for fp in &non_empty {
            *freq.entry(fp).or_insert(0) += 1;
        }

        if freq.values().any(|&count| count >= 3) {
            return Ok(vec![LoopSignal::HighFingerprintRepeatRate]);
        }

        Ok(vec![])
    }

    /// 检查是否有状态变化
    async fn check_no_state_change(pool: &SqlitePool, session_id: &str) -> Result<Vec<LoopSignal>> {
        let session = repo::get_session(pool, session_id).await?;
        let assignments = repo::list_assignments(pool, session_id).await?;

        let ready_count = assignments.iter().filter(|a| a.status == "ready").count();
        let blocked_count = assignments.iter().filter(|a| a.status == "blocked").count();

        let mut signals = Vec::new();

        if ready_count == 0 && blocked_count > 0 && session.round_count >= 5 {
            signals.push(LoopSignal::NoStateChangeInRecentRounds);
        }

        if ready_count == 0 && session.round_count >= 5 {
            signals.push(LoopSignal::NoNewReadyAssignments);
        }

        Ok(signals)
    }

    /// 检查两个智能体之间是否来回转发
    async fn check_ping_pong(pool: &SqlitePool, session_id: &str) -> Result<Vec<LoopSignal>> {
        let messages = repo::list_messages(pool, session_id).await?;

        let recent_questions: Vec<_> = messages
            .iter()
            .rev()
            .filter(|m| m.message_kind == MessageKind::Question.as_str())
            .take(10)
            .collect();

        if recent_questions.len() < 4 {
            return Ok(vec![]);
        }

        let mut pair_count: HashMap<(String, String), i32> = HashMap::new();
        for msg in &recent_questions {
            if let (Some(src), Some(tgt)) = (&msg.source_agent_id, &msg.target_agent_id) {
                let key = if src < tgt {
                    (src.clone(), tgt.clone())
                } else {
                    (tgt.clone(), src.clone())
                };
                *pair_count.entry(key).or_insert(0) += 1;
            }
        }

        if pair_count.values().any(|&count| count >= 2) {
            return Ok(vec![LoopSignal::PingPongBetweenAgents]);
        }

        Ok(vec![])
    }

    /// 根据信号数量计算循环等级
    pub fn calculate_level(signals: &[LoopSignal], round_count: i64) -> i32 {
        if signals.is_empty() {
            return 0;
        }

        let base_level = match signals.len() {
            1 => 1,
            2 => 2,
            _ => 3,
        };

        if round_count >= 20 {
            return 4;
        }

        base_level
    }
}
