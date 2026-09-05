//! 会话缓存命中率探针。
//!
//! 记录同一会话相邻两次请求的序列化消息，计算共享前缀字符占本次请求字符数的比例，
//! 对应缓存命中率 PRD 的 G1 指标。分母取本次请求（而非较短一侧），口径与供应商
//! cached_tokens / prompt_tokens 一致，可与 usage 上报的缓存命中 tokens 直接对照。
//! 数据仅保存在进程内存中并按会话有界淘汰，重启后从零开始积累。

use super::client::ChatMessage;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// 最多跟踪的会话数量，超出后按插入顺序淘汰最早记录，防止内存无限增长。
const MAX_TRACKED_CONVERSATIONS: usize = 256;
/// 单会话缓存的请求文本上限（字符数）；超长请求不参与探针，避免单条占用过多内存。
const MAX_TRACKED_REQUEST_CHARS: usize = 512 * 1024;

#[derive(Default)]
struct ProbeStore {
    previous_requests: HashMap<String, String>,
    eviction_order: VecDeque<String>,
}

impl ProbeStore {
    /// 计算本次请求与该会话上一次请求的共享前缀占比，并记录本次请求供下次比较。
    /// 会话首次出现时返回 None。
    fn measure(&mut self, conversation_id: &str, messages: &[ChatMessage]) -> Option<f64> {
        let current = serialize_request(messages);
        if current.chars().count() > MAX_TRACKED_REQUEST_CHARS {
            // 超长请求不参与比较，同时清除旧记录，避免下次与过期快照对比。
            self.previous_requests.remove(conversation_id);
            self.eviction_order.retain(|id| id != conversation_id);
            return None;
        }

        let ratio = self
            .previous_requests
            .get(conversation_id)
            .and_then(|previous| common_prefix_ratio(previous, &current));

        if self.previous_requests.len() >= MAX_TRACKED_CONVERSATIONS
            && !self.previous_requests.contains_key(conversation_id)
        {
            if let Some(oldest) = self.eviction_order.pop_front() {
                self.previous_requests.remove(&oldest);
            }
        }
        if self
            .previous_requests
            .insert(conversation_id.to_string(), current)
            .is_none()
        {
            self.eviction_order.push_back(conversation_id.to_string());
        }

        ratio
    }
}

static PROBE_STORE: OnceLock<Mutex<ProbeStore>> = OnceLock::new();

fn probe_store() -> &'static Mutex<ProbeStore> {
    PROBE_STORE.get_or_init(|| Mutex::new(ProbeStore::default()))
}

/// 计算本次请求与该会话上一次请求的共享前缀占比（0.0-1.0），并记录本次请求。
/// 该会话在进程生命周期内首次请求时返回 None。
pub fn measure_prefix_hit_ratio(conversation_id: &str, messages: &[ChatMessage]) -> Option<f64> {
    probe_store()
        .lock()
        .expect("cache probe mutex poisoned")
        .measure(conversation_id, messages)
}

/// 序列化一次请求的全部消息（含 system 与末尾 runtime 快照）。
/// 相邻请求的共享前缀自然终止于第一条不同的消息，因此无需单独排除末尾快照。
fn serialize_request(messages: &[ChatMessage]) -> String {
    let mut serialized = String::new();
    for message in messages {
        serialized.push_str(&message.role);
        serialized.push('\u{1}');
        serialized.push_str(&message.content);
        serialized.push('\u{2}');
    }
    serialized
}

/// 共享前缀字符数占本次请求字符数的比例（与供应商 cached_tokens / prompt_tokens 同口径）。
/// 任一侧为空时返回 None（无比较基线）。
fn common_prefix_ratio(previous: &str, current: &str) -> Option<f64> {
    if previous.is_empty() || current.is_empty() {
        return None;
    }
    let shared = previous
        .chars()
        .zip(current.chars())
        .take_while(|(previous_char, current_char)| previous_char == current_char)
        .count();
    Some(shared as f64 / current.chars().count() as f64)
}

#[cfg(test)]
mod tests {
    use super::{common_prefix_ratio, serialize_request, ProbeStore};
    use crate::ai::client::ChatMessage;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn sample_request() -> Vec<ChatMessage> {
        vec![
            message("system", "stable system prompt"),
            message("user", "hello"),
            message("assistant", "hi there"),
        ]
    }

    #[test]
    fn first_request_has_no_previous_ratio() {
        let mut store = ProbeStore::default();
        assert_eq!(store.measure("conv-1", &sample_request()), None);
    }

    #[test]
    fn identical_request_scores_full_ratio() {
        let mut store = ProbeStore::default();
        store.measure("conv-1", &sample_request());
        let ratio = store
            .measure("conv-1", &sample_request())
            .expect("second request must have a ratio");
        assert!((ratio - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn appended_message_keeps_mostly_stable_prefix() {
        let mut store = ProbeStore::default();
        store.measure("conv-1", &sample_request());

        let mut next = sample_request();
        next.push(message("user", "next question"));
        let ratio = store.measure("conv-1", &next).expect("ratio");

        // 新增一条消息后，旧请求完整保留在新请求的前缀中，
        // 占比 = 旧请求长度 / 新请求长度（与供应商缓存命中口径一致）。
        let previous = serialize_request(&sample_request());
        let expected =
            previous.chars().count() as f64 / serialize_request(&next).chars().count() as f64;
        assert!((ratio - expected).abs() < 1e-9);
        assert!(
            ratio > 0.5,
            "stable conversation should reuse most of the request: {ratio}"
        );
    }

    #[test]
    fn changed_system_prompt_drops_ratio() {
        let mut store = ProbeStore::default();
        store.measure("conv-1", &sample_request());

        let mut next = sample_request();
        next[0].content = "different system prompt".to_string();
        let ratio = store.measure("conv-1", &next).expect("ratio");
        assert!(ratio < 0.5, "unstable prefix should score low: {ratio}");
    }

    #[test]
    fn conversations_are_tracked_independently() {
        let mut store = ProbeStore::default();
        store.measure("conv-1", &sample_request());
        assert_eq!(store.measure("conv-2", &sample_request()), None);
    }

    #[test]
    fn oversized_request_is_not_tracked() {
        let mut store = ProbeStore::default();
        store.measure("conv-1", &sample_request());

        let oversized = vec![message("user", &"x".repeat(512 * 1024 + 1))];
        assert_eq!(store.measure("conv-1", &oversized), None);

        // 超长请求之后，旧快照已被清除，下一次请求重新从 None 开始。
        assert_eq!(store.measure("conv-1", &sample_request()), None);
    }

    #[test]
    fn evicts_oldest_conversation_at_capacity() {
        let mut store = ProbeStore::default();
        let total = super::MAX_TRACKED_CONVERSATIONS + 1;
        for index in 0..total {
            store.measure(&format!("conv-{index}"), &sample_request());
        }
        assert_eq!(
            store.measure("conv-0", &sample_request()),
            None,
            "oldest conversation should have been evicted"
        );
        assert_eq!(
            store.measure("conv-1", &sample_request()),
            None,
            "second oldest conversation should also have been evicted"
        );
    }

    #[test]
    fn common_prefix_ratio_handles_empty_input() {
        assert_eq!(common_prefix_ratio("", "abc"), None);
        assert_eq!(common_prefix_ratio("abc", ""), None);
    }
}
