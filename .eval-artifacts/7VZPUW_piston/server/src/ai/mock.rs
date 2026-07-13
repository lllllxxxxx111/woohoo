use axum::{
    body::Body,
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

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

#[derive(Debug, Serialize)]
pub struct MockModelsResponse {
    pub object: &'static str,
    pub data: Vec<MockModel>,
}

#[derive(Debug, Serialize)]
pub struct MockModel {
    pub id: &'static str,
    pub object: &'static str,
    pub created: i64,
    pub owned_by: &'static str,
}

pub async fn models() -> AppResult<Json<MockModelsResponse>> {
    Ok(Json(MockModelsResponse {
        object: "list",
        data: vec![MockModel {
            id: "woohoo-local-mock",
            object: "model",
            created: 0,
            owned_by: "woohoo",
        }],
    }))
}

pub async fn chat_completions(
    Json(req): Json<MockChatRequest>,
) -> AppResult<Response> {
    let content = build_mock_reply(&req.messages);
    let prompt_tokens = req
        .messages
        .iter()
        .map(|message| estimate_tokens(&message.content))
        .sum::<i64>();
    let completion_tokens = estimate_tokens(&content);
    let model = req
        .model
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "woohoo-local-mock".to_string());

    if req.stream.unwrap_or(false) {
        let chunk = json!({
            "id": format!("mockcmpl-{}", uuid::Uuid::new_v4()),
            "object": "chat.completion.chunk",
            "created": Utc::now().timestamp(),
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": null
            }]
        });
        let body = format!("data: {}\n\ndata: [DONE]\n\n", chunk);
        let mut response = Response::new(Body::from(body));
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return Ok(response);
    }

    Ok(Json(MockChatResponse {
        id: format!("mockcmpl-{}", uuid::Uuid::new_v4()),
        object: "chat.completion",
        created: Utc::now().timestamp(),
        model,
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
    })
    .into_response())
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

    if user_message.contains("完整剧本") || user_message.contains("分场剧本") {
        return "# 完整剧本\n\n## 第1场 外景 遗忘回收站 傍晚\n\n暮色里，废弃车站被改造成记忆回收点。透明收纳盒在传送带上缓慢移动，每个盒子里都闪着一小团光。\n\n林澈抱着旧背包站在入口，指尖攥着一张褪色车票。\n\n林澈：如果把这段记忆丢掉，我是不是就不会再难过了？\n小满：会少一点痛，也会少掉你当时真的开心过的证据。\n回收站AI：检测到高价值情绪片段，建议暂存，不建议销毁。\n\n林澈抬头，看到玻璃柜里漂浮着无数别人的记忆。那些光点短暂照亮他的脸。\n\n## 第2场 内景 回收站值班室 夜\n\n值班室里只剩一盏台灯。小满把透明盒推到林澈面前，盒子里是他不敢碰的回忆。\n\n小满：你不需要现在就打开它。\n林澈：那我还能把它留在这里多久？\n回收站AI：暂存期限可以续约。条件是，保管人仍愿意承认它属于自己。\n\n林澈沉默很久，把车票贴在盒子侧面。\n\n林澈：那就先替我保管。等我有勇气的时候，我再来取。\n小满：我会陪你一起等。\n\n## 第3场 外景 回收站月台 清晨\n\n第一班无人列车穿过薄雾。林澈和小满并肩坐在月台边，透明盒在两人中间发出柔和的光。\n\n林澈：原来不丢掉，也可以先不打开。\n小满：是啊。记忆不是负担，它只是还没找到被安放的位置。\n\n列车驶来，风吹动林澈手里的车票。他终于把盒子放进背包，站起身。\n\n林澈：走吧，我想先去吃一碗热面。\n小满：这次你请客。\n\n## 制作备注\n\n- 章节拆解：第一场建立设定和核心选择，第二场推动情绪决定，第三场完成温暖收束。\n- 合规提醒：避免把记忆删除拍成现实自伤行为，回收站 AI 保持功能型表达，不塑造成诱导伤害的角色。".to_string();
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
