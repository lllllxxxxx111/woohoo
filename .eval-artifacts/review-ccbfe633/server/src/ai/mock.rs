use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Deserialize)]
pub struct MockChatRequest {
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<MockChatMessage>,
    #[allow(dead_code)]
    pub temperature: Option<f64>,
    #[allow(dead_code)]
    pub max_tokens: Option<i64>,
    #[allow(dead_code)]
    pub stream: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MockChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct MockChatResponse {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub choices: Vec<MockChoice>,
    pub usage: MockUsage,
}

#[derive(Debug, Serialize)]
pub struct MockChoice {
    pub index: usize,
    pub message: MockResponseMessage,
    pub finish_reason: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MockResponseMessage {
    pub role: &'static str,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct MockUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

pub async fn chat_completions(
    Json(req): Json<MockChatRequest>,
) -> AppResult<Json<MockChatResponse>> {
    let content = build_mock_reply(&req.messages);
    let prompt_tokens = req
        .messages
        .iter()
        .map(|message| estimate_tokens(&message.content))
        .sum::<i64>();
    let completion_tokens = estimate_tokens(&content);

    Ok(Json(MockChatResponse {
        id: format!("mockcmpl-{}", uuid::Uuid::new_v4()),
        object: "chat.completion",
        created: Utc::now().timestamp(),
        model: req
            .model
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "woohoo-local-mock".to_string()),
        choices: vec![MockChoice {
            index: 0,
            message: MockResponseMessage {
                role: "assistant",
                content,
            },
            finish_reason: "stop",
        }],
        usage: MockUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        },
    }))
}

fn build_mock_reply(messages: &[MockChatMessage]) -> String {
    let execution_context = messages
        .iter()
        .rev()
        .find(|message| message.role == "system" && message.content.contains("[执行上下文]"))
        .map(|message| message.content.as_str());
    let user_message = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.trim())
        .unwrap_or("");

    if user_message.is_empty() {
        return "请先告诉我你想推进哪一步，我会按 Woohoo Studio 的创作流程给出下一步建议。"
            .to_string();
    }

    if user_message.contains("请只回复") && user_message.contains("连接成功") {
        return "连接成功".to_string();
    }

    let summary = user_message.replace('\n', " ");
    let short_summary = if summary.chars().count() > 48 {
        format!("{}...", summary.chars().take(48).collect::<String>())
    } else {
        summary
    };

    if let Some(context) = execution_context {
        let duty = extract_context_value(context, "你的工作职责:");
        let progress = extract_context_value(context, "当前工作进度/负载:");
        let last_error = extract_context_value(context, "最近一次失败原因:");
        let is_redo = context.contains("这是一次重做任务");

        if is_redo {
            return format!(
                "职责确认：{}\n当前工作进度：{}\n\n优化方案\n1. 先复盘上一轮失败点：{}。\n2. 本轮改为更紧凑、结构化地输出，优先交付最关键结果。\n3. 结果前先锁定目标范围和交付格式，避免重复上轮问题。\n\n执行结果\n本地 Mock AI 已按重做模式处理你的需求：{}。\n我会先给优化方案，再给最终结果，用于验证智能体的职责感知、进度感知和重试链路。",
                duty.unwrap_or("未声明职责"),
                progress.unwrap_or("状态未知"),
                last_error.unwrap_or("未记录失败原因"),
                short_summary
            );
        }

        return format!(
            "职责确认：{}\n当前工作进度：{}\n\n执行结果\n本地 Mock AI 已收到你的需求：{}。\n建议直接按这三步推进：\n1. 先明确目标镜头或剧情节点。\n2. 把关键角色、场景和冲突写成 3 到 5 条要点。\n3. 确认后我可以继续给你扩成剧本、分镜或审核意见。\n\n这条回复由本地 mock 服务生成，用于验证职责、进度和任务链路，不消耗外部模型额度。",
            duty.unwrap_or("未声明职责"),
            progress.unwrap_or("状态未知"),
            short_summary
        );
    }

    format!(
        "本地 Mock AI 已收到你的需求：{}。\n\n建议直接按这三步推进：\n1. 先明确目标镜头或剧情节点。\n2. 把关键角色、场景和冲突写成 3 到 5 条要点。\n3. 确认后我可以继续给你扩成剧本、分镜或审核意见。\n\n这条回复由本地 mock 服务生成，用于验证端到端流程，不消耗外部模型额度。",
        short_summary
    )
}

fn estimate_tokens(content: &str) -> i64 {
    let chars = content.chars().count() as i64;
    ((chars + 3) / 4).max(1)
}

fn extract_context_value<'a>(context: &'a str, prefix: &str) -> Option<&'a str> {
    context
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::trim))
        .filter(|value| !value.is_empty())
}
