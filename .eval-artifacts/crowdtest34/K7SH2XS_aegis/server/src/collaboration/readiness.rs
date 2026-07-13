#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadinessResult {
    pub ready: bool,
    pub missing: Vec<String>,
}

const GENRE_KEYWORDS: &[&str] = &[
    "短剧", "故事", "剧情", "悬疑", "喜剧", "爱情", "科幻", "古装", "现实", "题材",
];
const DIRECTION_KEYWORDS: &[&str] = &[
    "主角", "冲突", "目标", "反转", "成长", "复仇", "救赎", "关系", "方向", "讲述",
];
const AUDIENCE_KEYWORDS: &[&str] = &[
    "受众",
    "观众",
    "用户",
    "年轻人",
    "女性",
    "男性",
    "家庭",
    "儿童",
    "职场",
    "学生",
];
const FORMAT_KEYWORDS: &[&str] = &[
    "秒", "分钟", "集", "章", "幕", "竖屏", "横屏", "短片", "系列", "体量",
];

pub fn evaluate(messages: &[String]) -> ReadinessResult {
    let text = messages
        .iter()
        .rev()
        .take(20)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    let checks = [
        ("题材", GENRE_KEYWORDS),
        ("故事方向", DIRECTION_KEYWORDS),
        ("目标受众", AUDIENCE_KEYWORDS),
        ("内容体量", FORMAT_KEYWORDS),
    ];
    let missing = checks
        .into_iter()
        .filter_map(|(label, keywords)| {
            (!keywords.iter().any(|keyword| text.contains(keyword))).then(|| label.to_string())
        })
        .collect::<Vec<_>>();

    ReadinessResult {
        ready: missing.is_empty(),
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_complete_project_intent() {
        let result =
            evaluate(&["做一部面向年轻女性观众的悬疑短剧，主角追查真相，竖屏 60 秒".into()]);
        assert!(result.ready);
        assert!(result.missing.is_empty());
    }

    #[test]
    fn reports_missing_dimensions() {
        let result = evaluate(&["做一个悬疑故事".into()]);
        assert!(!result.ready);
        assert!(result.missing.contains(&"目标受众".to_string()));
        assert!(result.missing.contains(&"内容体量".to_string()));
    }
}
