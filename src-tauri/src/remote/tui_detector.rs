//! TUI 交互检测器
//!
//! 监听 PTY 输出流，检测 Claude Code 的交互式元素（选择菜单、确认框等）。
//! 检测到后生成格式化的消息卡片，供 chat-ws 广播给手机端显示。

use regex_lite::Regex;
use std::sync::LazyLock;

/// 交互选项
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct InteractiveOption {
    pub index: usize,
    pub label: String,
    pub description: String,
}

/// 检测到的交互菜单（内部使用）
pub struct DetectedMenu {
    pub question: String,
    pub options: Vec<InteractiveOption>,
    pub selected: usize,
}

/// 去除 ANSI 转义序列
fn strip_ansi(input: &str) -> String {
    static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()].").unwrap()
    });
    ANSI_RE.replace_all(input, "").to_string()
}

/// 计算文本指纹
fn fingerprint(text: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// TUI 交互检测器
pub struct TuiPromptDetector {
    /// 最近 N 行的 (原始文本, 去 ANSI 文本)
    recent_lines: Vec<(String, String)>,
    /// 窗口大小
    window_size: usize,
    /// 上一次检测到的指纹
    last_fingerprint: u64,
}

impl TuiPromptDetector {
    pub fn new(window_size: usize) -> Self {
        Self {
            recent_lines: Vec::with_capacity(window_size),
            window_size,
            last_fingerprint: 0,
        }
    }

    /// 喂入 PTY 输出数据，返回格式化的消息卡片文本（如果有）
    pub fn feed(&mut self, raw_data: &str) -> Option<String> {
        let raw_lines: Vec<&str> = raw_data.lines().collect();
        let cleaned = strip_ansi(raw_data);
        let cleaned_lines: Vec<&str> = cleaned.lines().collect();

        for (raw, clean) in raw_lines.iter().zip(cleaned_lines.iter()) {
            let clean_trimmed = clean.trim_end();
            if !clean_trimmed.is_empty() {
                self.recent_lines.push((raw.to_string(), clean_trimmed.to_string()));
            }
        }

        while self.recent_lines.len() > self.window_size {
            self.recent_lines.remove(0);
        }

        self.detect().map(|menu| format_card(&menu))
    }

    /// 核心检测逻辑
    fn detect(&mut self) -> Option<DetectedMenu> {
        let lines = &self.recent_lines;
        if lines.len() < 3 {
            return None;
        }

        let cleaned: Vec<&str> = lines.iter().map(|(_, c)| c.as_str()).collect();

        // 查找选中项：❯ 标记 或 蓝色高亮
        let selected_by_arrow = cleaned.iter().position(|l| {
            l.contains('❯') && !l.starts_with("---")
        });
        let blue_re = Regex::new(r"\x1b\[(?:1;)?3[0-9]m").unwrap();
        let selected_by_color = lines.iter().position(|(raw, clean)| {
            blue_re.is_match(raw) && !clean.trim().is_empty()
        });

        // 查找编号选项（数字或字母，可能带 ❯ 前缀）
        let number_re = Regex::new(r"^\s*(?:❯\s*)?(\d+)\.\s+(.+)").unwrap();
        let letter_re = Regex::new(r"^(?:❯\s*)?([A-Z])\.\s+(.+)").unwrap();
        let mut options: Vec<InteractiveOption> = Vec::new();
        let mut option_indices: Vec<usize> = Vec::new();

        for (i, line) in cleaned.iter().enumerate() {
            if let Some(caps) = number_re.captures(line) {
                let index: usize = caps[1].parse().unwrap_or(0);
                let label = caps[2].trim().to_string();
                if index <= 20 {
                    options.push(InteractiveOption { index, label, description: String::new() });
                    option_indices.push(i);
                }
            } else if let Some(caps) = letter_re.captures(line) {
                let letter = caps[1].chars().next().unwrap_or('A');
                let index = (letter as u8 - b'A' + 1) as usize;
                let label = caps[2].trim().to_string();
                options.push(InteractiveOption { index, label, description: String::new() });
                option_indices.push(i);
            }
        }

        // 缩进行作为 description
        for (opt_i, &line_i) in option_indices.iter().enumerate() {
            if line_i + 1 < cleaned.len() {
                let next = cleaned[line_i + 1];
                if next.starts_with("   ") && !number_re.is_match(next) && !letter_re.is_match(next) {
                    options[opt_i].description = next.trim().to_string();
                }
            }
        }

        // 关键词
        let has_type_something = cleaned.iter().any(|l| l.contains("Type something"));
        let has_chat_about = cleaned.iter().any(|l| l.contains("Chat about this"));

        // 置信度
        let has_selection = selected_by_arrow.is_some() || selected_by_color.is_some();
        let mut confidence = 0;
        if has_selection { confidence += 2; }
        if options.len() >= 2 { confidence += 1; }
        if has_type_something || has_chat_about { confidence += 1; }

        if (!has_selection && confidence < 3) || options.is_empty() {
            return None;
        }

        // 选中项
        let selected = if let Some(si) = selected_by_arrow {
            let sel = cleaned[si];
            number_re.captures(sel).and_then(|c| c[1].parse().ok())
                .or_else(|| letter_re.captures(sel).map(|c| (c[1].as_bytes()[0] - b'A' + 1) as usize))
                .or_else(|| options.iter().find(|o| sel.contains(&o.label)).map(|o| o.index))
                .unwrap_or(1)
        } else if let Some(si) = selected_by_color {
            let sel = cleaned[si];
            number_re.captures(sel).and_then(|c| c[1].parse().ok())
                .or_else(|| letter_re.captures(sel).map(|c| (c[1].as_bytes()[0] - b'A' + 1) as usize))
                .or_else(|| options.iter().find(|o| sel.contains(&o.label)).map(|o| o.index))
                .unwrap_or(1)
        } else {
            1
        };

        // 添加特殊选项
        if has_type_something {
            options.push(InteractiveOption { index: options.len() + 1, label: "Type something".to_string(), description: "自定义输入".to_string() });
        }
        if has_chat_about {
            options.push(InteractiveOption { index: options.len() + 1, label: "Chat about this".to_string(), description: "就此话题展开对话".to_string() });
        }

        // 去重
        let mut seen = std::collections::HashSet::new();
        options.retain(|o| seen.insert(o.index));

        // 指纹去重
        let fp_text = options.iter().map(|o| format!("{}:{}", o.index, o.label)).collect::<Vec<_>>().join("|");
        let fp = fingerprint(&fp_text);
        if fp == self.last_fingerprint {
            return None;
        }
        self.last_fingerprint = fp;

        // 提取问题
        let first_option_line = option_indices.first().copied().unwrap_or(cleaned.len());
        let context: Vec<&str> = cleaned[..first_option_line].iter().rev().take(5)
            .filter(|l| !l.trim().is_empty()).copied().collect();
        let question = context.first().map(|s| s.to_string()).unwrap_or_default();

        Some(DetectedMenu { question, options, selected })
    }

    pub fn reset(&mut self) {
        self.recent_lines.clear();
        self.last_fingerprint = 0;
    }
}

/// 将检测到的菜单格式化为消息卡片文本
fn format_card(menu: &DetectedMenu) -> String {
    let mut card = String::new();

    if !menu.question.is_empty() {
        card.push_str(&format!("📋 **{}**\n\n", menu.question));
    }

    for opt in &menu.options {
        let marker = if opt.index == menu.selected { "❯" } else { " " };
        card.push_str(&format!("{} {}. {}", marker, opt.index, opt.label));
        if !opt.description.is_empty() {
            card.push_str(&format!("\n    {}", opt.description));
        }
        card.push('\n');
    }

    card.push_str("\n💡 输入数字或文字回复");
    card
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_and_format() {
        let mut det = TuiPromptDetector::new(30);
        let result = det.feed(
            "你想了解哪段历史？\n\x1b[34m1. 中国古代史\x1b[0m\n   秦汉三国、唐宋元明清等朝代的故事\n2. 中国近现代史\n   鸦片战争到新中国成立这段历史\n3. 世界史\n   古埃及、古罗马、两次世界大战等\n"
        );
        assert!(result.is_some());
        let card = result.unwrap();
        assert!(card.contains("中国古代史"));
        assert!(card.contains("❯ 1."));
        assert!(card.contains("输入数字"));
    }

    #[test]
    fn test_no_false_positive() {
        let mut det = TuiPromptDetector::new(30);
        let result = det.feed("首先：\n1. 安装依赖\n2. 配置环境\n3. 运行测试\n");
        assert!(result.is_none());
    }
}
