use std::collections::{HashMap, HashSet};

use anyhow::Result;
use sqlx::SqlitePool;

use super::model::MessageKind;
use super::repo;

/// 同智能体重复追问硬上限
const QUESTION_LIMIT_PER_AGENT: i64 = 3;
/// 语义近似 Jaccard 相似度阈值（超过此值判定为近似重复）
const SEMANTIC_SIMILARITY_THRESHOLD: f64 = 0.65;
/// 语义检测窗口（最近 N 条问题）
const SEMANTIC_WINDOW_SIZE: i64 = 8;

/// 循环检测信号
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopSignal {
    RoundLimitReached,
    HighFingerprintRepeatRate,
    NoStateChangeInRecentRounds,
    NoNewReadyAssignments,
    PingPongBetweenAgents,
    /// 语义近似重复问题
    SemanticSimilarQuestion,
    /// 同智能体重复追问达到硬上限
    QuestionLimitReached,
}

impl LoopSignal {
    pub fn as_str(&self) -> &'static str {
        match self {
            LoopSignal::RoundLimitReached => "round_limit_reached",
            LoopSignal::HighFingerprintRepeatRate => "high_fingerprint_repeat_rate",
            LoopSignal::NoStateChangeInRecentRounds => "no_state_change_in_recent_rounds",
            LoopSignal::NoNewReadyAssignments => "no_new_ready_assignments",
            LoopSignal::PingPongBetweenAgents => "ping_pong_between_agents",
            LoopSignal::SemanticSimilarQuestion => "semantic_similar_question",
            LoopSignal::QuestionLimitReached => "question_limit_reached",
        }
    }
}

/// 循环检测器
pub struct LoopDetector;

impl LoopDetector {
    /// 执行循环检测，返回检测到的信号列表
    pub async fn detect(pool: &SqlitePool, session_id: &str) -> Result<Vec<LoopSignal>> {
        let session = repo::get_session(pool, session_id).await?;

        // 使用会话可配置的轮次上限（027 迁移新增字段，默认 20）
        let max_rounds = if session.max_round_limit > 0 {
            session.max_round_limit
        } else {
            20
        };

        if session.round_count >= max_rounds {
            return Ok(vec![LoopSignal::RoundLimitReached]);
        }

        // 同智能体重复追问硬上限检查（始终执行，不受 round_count 限制）
        let mut signals = Vec::new();
        signals.extend(Self::check_question_limit(pool, session_id).await?);

        if session.round_count < 5 {
            return Ok(signals);
        }

        signals.extend(Self::check_fingerprint_repeat(pool, session_id).await?);
        signals.extend(Self::check_no_state_change(pool, session_id).await?);
        signals.extend(Self::check_ping_pong(pool, session_id).await?);
        signals.extend(Self::check_semantic_similarity(pool, session_id).await?);

        Ok(signals)
    }

    /// 检查同智能体重复追问是否达到硬上限
    async fn check_question_limit(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Vec<LoopSignal>> {
        let assignments = repo::list_assignments(pool, session_id).await?;

        let over_limit = assignments
            .iter()
            .any(|a| a.blocking_question_count >= QUESTION_LIMIT_PER_AGENT);

        if over_limit {
            return Ok(vec![LoopSignal::QuestionLimitReached]);
        }

        Ok(vec![])
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

    /// 检查语义近似重复问题（基于 token Jaccard 相似度）
    async fn check_semantic_similarity(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Vec<LoopSignal>> {
        let contents = repo::get_recent_question_contents(pool, session_id, SEMANTIC_WINDOW_SIZE)
            .await?;

        if contents.len() < 2 {
            return Ok(vec![]);
        }

        // 对每对问题计算 Jaccard 相似度
        for i in 0..contents.len() {
            for j in (i + 1)..contents.len() {
                let similarity = jaccard_similarity(&contents[i], &contents[j]);
                if similarity >= SEMANTIC_SIMILARITY_THRESHOLD {
                    return Ok(vec![LoopSignal::SemanticSimilarQuestion]);
                }
            }
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

        // 硬上限信号直接升级到 level 4
        if signals.contains(&LoopSignal::QuestionLimitReached) {
            return 4;
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

/// 计算两段文本的 Jaccard 相似度（基于字符级 bigram 集合）
/// 返回 [0.0, 1.0]，值越大表示越相似
fn jaccard_similarity(a: &str, b: &str) -> f64 {
    let set_a = text_to_bigrams(a);
    let set_b = text_to_bigrams(b);

    if set_a.is_empty() && set_b.is_empty() {
        return 1.0;
    }
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }

    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();

    if union == 0 {
        return 0.0;
    }

    intersection as f64 / union as f64
}

/// 将文本归一化为字符级 bigram 集合（用于语义近似检测）
/// 归一化：小写化、去除标点和空白、按 unicode 字符分 bigram
fn text_to_bigrams(text: &str) -> HashSet<String> {
    let normalized: String = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();

    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() < 2 {
        return chars.into_iter().map(|c| c.to_string()).collect();
    }

    (0..chars.len() - 1)
        .map(|i| format!("{}{}", chars[i], chars[i + 1]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jaccard_similarity_identical_text_returns_one() {
        let text = "如何设计大纲结构";
        assert!((jaccard_similarity(text, text) - 1.0).abs() < 0.001);
    }

    #[test]
    fn jaccard_similarity_completely_different_returns_zero() {
        let a = "abc";
        let b = "xyz";
        assert!(jaccard_similarity(a, b) < 0.01);
    }

    #[test]
    fn jaccard_similarity_similar_questions_detected() {
        let a = "如何设计大纲结构";
        let b = "大纲结构怎么设计";
        let sim = jaccard_similarity(a, b);
        assert!(sim > 0.3, "similar questions should have similarity > 0.3, got {}", sim);
    }

    #[test]
    fn jaccard_similarity_empty_text_handled() {
        assert_eq!(jaccard_similarity("", ""), 1.0);
        assert_eq!(jaccard_similarity("abc", ""), 0.0);
    }

    #[test]
    fn calculate_level_question_limit_returns_four() {
        let signals = vec![LoopSignal::QuestionLimitReached];
        assert_eq!(LoopDetector::calculate_level(&signals, 5), 4);
    }

    #[test]
    fn calculate_level_semantic_signal_elevates_level() {
        let signals = vec![LoopSignal::SemanticSimilarQuestion, LoopSignal::PingPongBetweenAgents];
        assert_eq!(LoopDetector::calculate_level(&signals, 10), 2);
    }
}
