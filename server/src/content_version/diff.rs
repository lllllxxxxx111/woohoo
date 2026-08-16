use serde::Serialize;
use std::collections::VecDeque;

use super::model::{ContentType, StoryboardSnapshot};

/// 参与逐行 LCS 对比的最大行数；超出则截断并标记 truncated
const MAX_DIFF_LINES: usize = 1200;
/// 返回给前端的最大 diff 行条目数，避免超大响应
const MAX_HUNK_ENTRIES: usize = 400;
/// 分镜 diff 返回的最大变更条目数
const MAX_STORYBOARD_CHANGES: usize = 200;
/// 单行预览最大字符数
const MAX_LINE_PREVIEW_CHARS: usize = 200;

/// 脚本逐行 diff 的一条记录
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiffEntry {
    /// "add" | "remove" | "modify_from" | "modify_to" | "context"
    pub op: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiff {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub unchanged: usize,
    pub truncated: bool,
    pub entries: Vec<ScriptDiffEntry>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardLineChange {
    pub line_id: String,
    pub scene_number: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// modified 时发生变化的字段名列表
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardDiff {
    pub added: Vec<StoryboardLineChange>,
    pub removed: Vec<StoryboardLineChange>,
    pub modified: Vec<StoryboardLineChange>,
    pub unchanged: usize,
    pub truncated: bool,
    pub summary: String,
}

/// 统一 diff 结果
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContentDiff {
    Script(ScriptDiff),
    Storyboard(StoryboardDiff),
}

/// 顶层入口：按内容类型对两个版本内容做有界 diff
pub fn diff_contents(
    content_type: ContentType,
    base_content: &str,
    target_content: &str,
) -> ContentDiff {
    match content_type {
        ContentType::Script => diff_script(base_content, target_content),
        ContentType::Storyboard => diff_storyboard(base_content, target_content),
    }
}

/// 剧本文本 diff：基于 LCS 的逐行对比，输出新增/删除/修改摘要
pub fn diff_script(base_content: &str, target_content: &str) -> ContentDiff {
    if base_content == target_content {
        let line_count = count_lines(target_content);
        return ContentDiff::Script(ScriptDiff {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: line_count,
            truncated: false,
            entries: Vec::new(),
            summary: "内容无变化".to_string(),
        });
    }

    let mut base_lines: Vec<&str> = base_content.lines().collect();
    let mut target_lines: Vec<&str> = target_content.lines().collect();
    let mut truncated = false;
    if base_lines.len() > MAX_DIFF_LINES || target_lines.len() > MAX_DIFF_LINES {
        truncated = true;
        base_lines.truncate(MAX_DIFF_LINES);
        target_lines.truncate(MAX_DIFF_LINES);
    }

    let ops = lcs_diff(&base_lines, &target_lines);

    // Rust 的 lines() 会忽略“末尾有没有换行符”这一差异（"A" 与 "A\n" 行数
    // 相同）。字符串确实不同而行完全一致时，唯一可能的差异就是末尾换行，
    // 显式标注出来，否则 diff 会声称“无变化”但内容其实不同。
    let trailing_newline_only = !truncated
        && base_lines == target_lines
        && base_content != target_content;

    // 将紧邻的 remove+add 组合识别为 modify
    let grouped = group_modifications(ops);

    let mut added = 0usize;
    let mut removed = 0usize;
    let mut modified = 0usize;
    let mut unchanged = 0usize;
    let mut entries: Vec<ScriptDiffEntry> = Vec::new();

    for item in &grouped {
        match item {
            DiffItem::Keep(text, old_line, new_line) => {
                unchanged += 1;
                if entries.len() < MAX_HUNK_ENTRIES {
                    entries.push(ScriptDiffEntry {
                        op: "context".to_string(),
                        text: truncate_preview(text),
                        old_line: Some(*old_line),
                        new_line: Some(*new_line),
                    });
                }
            }
            DiffItem::Add(text, new_line) => {
                added += 1;
                if entries.len() < MAX_HUNK_ENTRIES {
                    entries.push(ScriptDiffEntry {
                        op: "add".to_string(),
                        text: truncate_preview(text),
                        old_line: None,
                        new_line: Some(*new_line),
                    });
                }
            }
            DiffItem::Remove(text, old_line) => {
                removed += 1;
                if entries.len() < MAX_HUNK_ENTRIES {
                    entries.push(ScriptDiffEntry {
                        op: "remove".to_string(),
                        text: truncate_preview(text),
                        old_line: Some(*old_line),
                        new_line: None,
                    });
                }
            }
            DiffItem::Modify(from_text, to_text, old_line, new_line) => {
                modified += 1;
                // modify 产出两条条目（from/to），容量检查按 +2 计，
                // 否则上限会溢出 1 条。
                if entries.len() + 2 <= MAX_HUNK_ENTRIES {
                    entries.push(ScriptDiffEntry {
                        op: "modify_from".to_string(),
                        text: truncate_preview(from_text),
                        old_line: Some(*old_line),
                        new_line: None,
                    });
                    entries.push(ScriptDiffEntry {
                        op: "modify_to".to_string(),
                        text: truncate_preview(to_text),
                        old_line: None,
                        new_line: Some(*new_line),
                    });
                } else {
                    truncated = true;
                }
            }
        }
    }

    if entries.len() >= MAX_HUNK_ENTRIES {
        truncated = true;
    }

    let mut summary = format!(
        "新增 {} 行，删除 {} 行，修改 {} 行，未变 {} 行",
        added, removed, modified, unchanged
    );
    if trailing_newline_only {
        summary.push_str("（差异仅为末尾换行符）");
    }
    if truncated {
        summary.push_str("（内容过大，仅统计前 1200 行/前 400 条，未显示部分可能还有差异）");
    }

    ContentDiff::Script(ScriptDiff {
        added,
        removed,
        modified,
        unchanged,
        truncated,
        entries,
        summary,
    })
}

/// 分镜结构 diff：按行 id 对齐，输出新增/删除/字段级修改
pub fn diff_storyboard(base_content: &str, target_content: &str) -> ContentDiff {
    let base_snapshot = parse_snapshot(base_content);
    let target_snapshot = parse_snapshot(target_content);

    let base_lines = base_snapshot.lines;
    let target_lines = target_snapshot.lines;
    let mut truncated = false;

    use std::collections::HashMap;
    let mut base_by_id: HashMap<&str, usize> = HashMap::new();
    for (index, line) in base_lines.iter().enumerate() {
        base_by_id.entry(line.id.as_str()).or_insert(index);
    }
    let mut target_by_id: HashMap<&str, usize> = HashMap::new();
    for (index, line) in target_lines.iter().enumerate() {
        target_by_id.entry(line.id.as_str()).or_insert(index);
    }

    let mut added: Vec<StoryboardLineChange> = Vec::new();
    let mut removed: Vec<StoryboardLineChange> = Vec::new();
    let mut modified: Vec<StoryboardLineChange> = Vec::new();
    let mut unchanged = 0usize;

    // 新增 + 修改（以 target 为准遍历）
    for target_line in &target_lines {
        if let Some(&base_index) = base_by_id.get(target_line.id.as_str()) {
            let base_line = &base_lines[base_index];
            let mut changed_fields: Vec<String> = Vec::new();
            if base_line.scene_number != target_line.scene_number {
                changed_fields.push("sceneNumber".to_string());
            }
            if base_line.description != target_line.description {
                changed_fields.push("description".to_string());
            }
            if base_line.duration != target_line.duration {
                changed_fields.push("duration".to_string());
            }
            if base_line.asset_ids != target_line.asset_ids {
                changed_fields.push("assetIds".to_string());
            }

            if changed_fields.is_empty() {
                unchanged += 1;
            } else {
                if modified.len() < MAX_STORYBOARD_CHANGES {
                    modified.push(StoryboardLineChange {
                        line_id: target_line.id.clone(),
                        scene_number: target_line.scene_number,
                        description: Some(truncate_preview(&target_line.description)),
                        changed_fields,
                    });
                } else {
                    truncated = true;
                }
            }
        } else {
            if added.len() < MAX_STORYBOARD_CHANGES {
                added.push(StoryboardLineChange {
                    line_id: target_line.id.clone(),
                    scene_number: target_line.scene_number,
                    description: Some(truncate_preview(&target_line.description)),
                    changed_fields: Vec::new(),
                });
            } else {
                truncated = true;
            }
        }
    }

    // 删除（base 中存在但 target 中不存在）
    for base_line in &base_lines {
        if !target_by_id.contains_key(base_line.id.as_str()) {
            if removed.len() < MAX_STORYBOARD_CHANGES {
                removed.push(StoryboardLineChange {
                    line_id: base_line.id.clone(),
                    scene_number: base_line.scene_number,
                    description: Some(truncate_preview(&base_line.description)),
                    changed_fields: Vec::new(),
                });
            } else {
                truncated = true;
            }
        }
    }

    let summary = format!(
        "新增 {} 个镜头，删除 {} 个镜头，修改 {} 个镜头，未变 {} 个",
        added.len(),
        removed.len(),
        modified.len(),
        unchanged
    );

    ContentDiff::Storyboard(StoryboardDiff {
        added,
        removed,
        modified,
        unchanged,
        truncated,
        summary,
    })
}

fn parse_snapshot(content: &str) -> StoryboardSnapshot {
    serde_json::from_str::<StoryboardSnapshot>(content).unwrap_or(StoryboardSnapshot {
        lines: Vec::new(),
    })
}

fn count_lines(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.lines().count()
    }
}

fn truncate_preview(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.chars().count() <= MAX_LINE_PREVIEW_CHARS {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(MAX_LINE_PREVIEW_CHARS).collect();
        format!("{}…", truncated)
    }
}

#[derive(Debug, Clone)]
enum DiffItem {
    Keep(String, usize, usize),
    Add(String, usize),
    Remove(String, usize),
    Modify(String, String, usize, usize),
}

/// 经典 LCS 逐行 diff，返回 Keep/Add/Remove 序列（行号从 1 开始）
fn lcs_diff(base_lines: &[&str], target_lines: &[&str]) -> Vec<DiffItem> {
    let n = base_lines.len();
    let m = target_lines.len();

    // DP 表：lcs[i][j] = base[i..] 与 target[j..] 的最长公共子序列长度
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if base_lines[i] == target_lines[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut result = Vec::new();
    let mut i = 0usize;
    let mut j = 0usize;
    while i < n && j < m {
        if base_lines[i] == target_lines[j] {
            result.push(DiffItem::Keep(
                base_lines[i].to_string(),
                i + 1,
                j + 1,
            ));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            result.push(DiffItem::Remove(base_lines[i].to_string(), i + 1));
            i += 1;
        } else {
            result.push(DiffItem::Add(target_lines[j].to_string(), j + 1));
            j += 1;
        }
    }
    while i < n {
        result.push(DiffItem::Remove(base_lines[i].to_string(), i + 1));
        i += 1;
    }
    while j < m {
        result.push(DiffItem::Add(target_lines[j].to_string(), j + 1));
        j += 1;
    }

    result
}

/// 将紧邻的 Remove…Add… 段配对为 Modify，提升可读性
fn group_modifications(items: Vec<DiffItem>) -> Vec<DiffItem> {
    let mut output: Vec<DiffItem> = Vec::new();
    let mut removes: VecDeque<(String, usize)> = VecDeque::new();

    for item in items {
        match item {
            DiffItem::Remove(text, old_line) => {
                removes.push_back((text, old_line));
            }
            DiffItem::Add(text, new_line) => {
                // FIFO 配对（队首而非队尾）：连续多行修改按文档顺序配对
                // 第 1 个旧行 ↔ 第 1 个新行。LIFO 会把配对与输出顺序颠倒，
                // 整段重写（AI 重新生成的常见形态）会显示错乱的 diff。
                if let Some((from_text, old_line)) = removes.pop_front() {
                    output.push(DiffItem::Modify(from_text, text, old_line, new_line));
                } else {
                    output.push(DiffItem::Add(text, new_line));
                }
            }
            other => {
                while let Some((text, old_line)) = removes.pop_front() {
                    output.push(DiffItem::Remove(text, old_line));
                }
                output.push(other);
            }
        }
    }
    while let Some((text, old_line)) = removes.pop_front() {
        output.push(DiffItem::Remove(text, old_line));
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_diff_identical_content_reports_no_change() {
        let diff = diff_script("行一\n行二", "行一\n行二");
        match diff {
            ContentDiff::Script(script) => {
                assert_eq!(script.added, 0);
                assert_eq!(script.removed, 0);
                assert_eq!(script.modified, 0);
                assert_eq!(script.unchanged, 2);
                assert!(script.entries.is_empty());
            }
            _ => panic!("expected script diff"),
        }
    }

    #[test]
    fn script_diff_detects_added_removed_and_modified_lines() {
        let diff = diff_script("A\nB\nC", "A\nX\nC\nD");
        match diff {
            ContentDiff::Script(script) => {
                // B -> X 视为一次修改，D 为新增
                assert_eq!(script.modified, 1);
                assert_eq!(script.added, 1);
                assert_eq!(script.removed, 0);
                assert_eq!(script.unchanged, 2);
            }
            _ => panic!("expected script diff"),
        }
    }

    /// 连续多行替换必须按文档顺序 FIFO 配对，且行号升序输出。
    #[test]
    fn script_diff_pairs_consecutive_modified_lines_in_order() {
        let diff = diff_script("A\nB\nC", "X\nY\nZ");
        match diff {
            ContentDiff::Script(script) => {
                assert_eq!(script.modified, 3);
                assert_eq!(script.added, 0);
                assert_eq!(script.removed, 0);
                // A→X、B→Y、C→Z 按顺序配对：旧行号 1,2,3 与新行号 1,2,3 对齐
                let pairs: Vec<(&str, &str, usize, usize)> = script
                    .entries
                    .iter()
                    .filter(|entry| entry.op == "modify_from" || entry.op == "modify_to")
                    .map(|entry| {
                        (
                            entry.op.as_str(),
                            entry.text.as_str(),
                            entry.old_line.unwrap_or(0),
                            entry.new_line.unwrap_or(0),
                        )
                    })
                    .collect();
                // A→X、B→Y、C→Z 按顺序配对，而非 C→X、B→Y、A→Z
                assert_eq!(pairs[0], ("modify_from", "A", 1, 0));
                assert_eq!(pairs[1], ("modify_to", "X", 0, 1));
                assert_eq!(pairs[2], ("modify_from", "B", 2, 0));
                assert_eq!(pairs[3], ("modify_to", "Y", 0, 2));
                assert_eq!(pairs[4], ("modify_from", "C", 3, 0));
                assert_eq!(pairs[5], ("modify_to", "Z", 0, 3));
            }
            _ => panic!("expected script diff"),
        }
    }

    /// 行内容一致但末尾换行不同：必须显式提示而不是报告“无变化”。
    #[test]
    fn script_diff_reports_trailing_newline_difference() {
        let diff = diff_script("A\nB", "A\nB\n");
        match diff {
            ContentDiff::Script(script) => {
                assert_eq!(script.added, 0);
                assert_eq!(script.removed, 0);
                assert!(script.summary.contains("末尾换行"), "summary={}", script.summary);
            }
            _ => panic!("expected script diff"),
        }
    }

    #[test]
    fn script_diff_handles_empty_versions() {
        let from_empty = diff_script("", "新增一\n新增二");
        match from_empty {
            ContentDiff::Script(script) => {
                assert_eq!(script.added, 2);
                assert_eq!(script.removed, 0);
            }
            _ => panic!("expected script diff"),
        }

        let to_empty = diff_script("旧内容", "");
        match to_empty {
            ContentDiff::Script(script) => {
                assert_eq!(script.removed, 1);
                assert_eq!(script.added, 0);
            }
            _ => panic!("expected script diff"),
        }
    }

    #[test]
    fn script_diff_truncates_huge_input() {
        let make = |prefix: &str| {
            (0..(MAX_DIFF_LINES + 100))
                .map(|i| format!("{}-{}", prefix, i))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let diff = diff_script(&make("base"), &make("target"));
        match diff {
            ContentDiff::Script(script) => {
                assert!(script.truncated);
                assert!(script.entries.len() <= MAX_HUNK_ENTRIES);
            }
            _ => panic!("expected script diff"),
        }
    }

    fn line(id: &str, scene: i64, desc: &str, duration: i64) -> super::super::model::StoryboardSnapshotLine {
        super::super::model::StoryboardSnapshotLine {
            id: id.to_string(),
            scene_number: scene,
            description: desc.to_string(),
            duration,
            asset_ids: Vec::new(),
        }
    }

    fn snapshot_json(lines: Vec<super::super::model::StoryboardSnapshotLine>) -> String {
        serde_json::to_string(&super::super::model::StoryboardSnapshot { lines })
            .expect("serialize snapshot")
    }

    #[test]
    fn storyboard_diff_detects_added_removed_modified() {
        let base = snapshot_json(vec![line("l1", 1, "开场", 3), line("l2", 2, "将被删除", 4)]);
        let target = snapshot_json(vec![line("l1", 1, "开场改写", 5), line("l3", 3, "新增镜头", 2)]);

        let diff = diff_storyboard(&base, &target);
        match diff {
            ContentDiff::Storyboard(storyboard) => {
                assert_eq!(storyboard.added.len(), 1);
                assert_eq!(storyboard.added[0].line_id, "l3");
                assert_eq!(storyboard.removed.len(), 1);
                assert_eq!(storyboard.removed[0].line_id, "l2");
                assert_eq!(storyboard.modified.len(), 1);
                assert_eq!(storyboard.modified[0].line_id, "l1");
                assert!(storyboard.modified[0].changed_fields.contains(&"description".to_string()));
                assert!(storyboard.modified[0].changed_fields.contains(&"duration".to_string()));
            }
            _ => panic!("expected storyboard diff"),
        }
    }

    #[test]
    fn storyboard_diff_identical_and_invalid_json() {
        let same = snapshot_json(vec![line("l1", 1, "开场", 3)]);
        match diff_storyboard(&same, &same) {
            ContentDiff::Storyboard(storyboard) => {
                assert_eq!(storyboard.unchanged, 1);
                assert!(storyboard.added.is_empty());
                assert!(storyboard.removed.is_empty());
                assert!(storyboard.modified.is_empty());
            }
            _ => panic!("expected storyboard diff"),
        }

        // 非法 JSON 视为空分镜，不应 panic
        match diff_storyboard("not-json", &same) {
            ContentDiff::Storyboard(storyboard) => {
                assert_eq!(storyboard.added.len(), 1);
            }
            _ => panic!("expected storyboard diff"),
        }
    }
}

