//! NDJSON 解析核心：把 `claude -p --output-format stream-json` 输出的每一行
//! 解析成统一的中立事件，供 claude_chat 模块转发到前端。
//!
//! 流式策略（CLI 2.1.119 实测）：
//! - 真正的增量文本/推理走 `stream_event.content_block_delta`（text_delta /
//!   thinking_delta），按块累积；`assistant` 事件只在大块边界出现（首/尾），
//!   并非逐 token 增量。
//! - 工具调用：`content_block_start` 给出 id/name；`input_json_delta` 把
//!   partial_json 片段拼成完整 input；最终 `assistant` 事件里的完整 input 兜底。
//! - `assistant` 累积事件作为旧版 CLI 的兼容回退（无 stream_event 时）。

use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 一次 turn 内解析出的中立事件
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ParsedEvent {
    SessionId(String),
    TextDelta(String),
    ReasoningDelta(String),
    ToolStarted {
        tool_id: String,
        tool_name: String,
        input: Value,
    },
    ToolInput {
        tool_id: String,
        input: Value,
    },
    QuestionRequested {
        tool_id: String,
        input: Value,
    },
    ToolCompleted {
        tool_id: String,
        tool_name: Option<String>,
        output: Option<String>,
        error: Option<String>,
    },
    TurnFinished {
        cost_usd: Option<f64>,
        session_id: Option<String>,
        is_error: bool,
        result_text: Option<String>,
        /// 归一化后的 token 用量：{ threadId, last, session, contextWindow }
        usage: Option<Value>,
    },
}

/// 单 turn 的解析状态（每轮 send 新建一个）
#[derive(Default)]
pub(crate) struct StreamParser {
    // assistant 累积回退（旧版 CLI 用）
    last_text: String,
    last_reasoning: String,
    saw_stream_text: bool,
    saw_stream_thinking: bool,
    // 工具调用：按 id 去重；按 block index 追踪 input_json_delta
    seen_tool_ids: HashSet<String>,
    tool_ids_by_index: HashMap<usize, String>,
    tool_names_by_index: HashMap<usize, String>,
    tool_input_buffers: HashMap<usize, String>,
    // 原生 AskUserQuestion：按 tool_id 去重，避免多份 assistant 快照重复发问题卡
    seen_questions: HashSet<String>,
    // token 用量：last = 最近一次 API 调用的 message.usage / usage；
    // session = result 事件顶层的累计 usage；context_window_* = 实时 context_window 遥测
    last_usage: Option<Value>,
    session_usage: Option<Value>,
    model: Option<String>,
    context_window_size: Option<u64>,
    context_used: Option<u64>,
    context_used_percent: Option<f64>,
    context_remaining_percent: Option<f64>,
    pub emitted_any_text: bool,
    pub result_seen: bool,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一行 NDJSON，返回 0..n 个中立事件
    pub fn process_line(&mut self, line: &str) -> Vec<ParsedEvent> {
        let value: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        self.scan_usage(&value);
        match value.get("type").and_then(|t| t.as_str()) {
            Some("stream_event") => self.handle_stream_event(&value),
            Some("system") => self.handle_system(&value),
            Some("assistant") => self.handle_assistant(&value),
            Some("user") => self.handle_user(&value),
            Some("result") => self.handle_result(&value),
            _ => Vec::new(),
        }
    }

    /// 捕获 token 用量：非 result 事件的 message.usage / usage 作为最近一次用量，
    /// result 事件顶层的 usage 作为会话累计，context_window 记录模型窗口大小与实时占用。
    fn scan_usage(&mut self, value: &Value) {
        if value.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(usage) = value.get("usage") {
                if usage.is_object() {
                    self.session_usage = Some(usage.clone());
                }
            }
            return;
        }
        // context_window 可能出现在顶层或 payload/data/hook 里（--include-hook-events）
        if let Some(window) = find_context_window(value) {
            let size = num_from(
                window
                    .get("context_window_size")
                    .or_else(|| window.get("contextWindowSize")),
            );
            if let Some(size) = size {
                self.context_window_size = Some(size);
            }
            if let Some(used) = window.get("current_usage").or_else(|| window.get("currentUsage")) {
                let used_tokens = num_from(Some(used)).or_else(|| {
                    if used.is_object() {
                        let input =
                            num_from(used.get("input_tokens").or_else(|| used.get("inputTokens")));
                        let cached = num_from(
                            used.get("cache_read_input_tokens")
                                .or_else(|| used.get("cacheReadInputTokens")),
                        );
                        match (input, cached) {
                            (Some(i), Some(c)) => i.checked_add(c),
                            (Some(i), None) => Some(i),
                            (None, Some(c)) => Some(c),
                            _ => None,
                        }
                    } else {
                        None
                    }
                });
                if used_tokens.is_some() {
                    self.context_used = used_tokens;
                }
            }
            let used_percent = num_f64(
                window
                    .get("used_percentage")
                    .or_else(|| window.get("usedPercentage")),
            );
            if used_percent.is_some() {
                self.context_used_percent = used_percent;
            }
            let remaining_percent = num_f64(
                window
                    .get("remaining_percentage")
                    .or_else(|| window.get("remainingPercentage")),
            );
            if remaining_percent.is_some() {
                self.context_remaining_percent = remaining_percent;
            }
        }
        if let Some(model) = value
            .get("message")
            .and_then(|message| message.get("model"))
            .and_then(|model| model.as_str())
        {
            self.model = Some(model.to_string());
        }
        let usage = value
            .get("message")
            .and_then(|message| message.get("usage"))
            .or_else(|| value.get("usage"))
            .or_else(|| value.get("payload").and_then(|payload| payload.get("usage")));
        if let Some(usage) = usage {
            if usage.is_object() {
                self.last_usage = Some(usage.clone());
            }
        }
    }

    fn handle_system(&self, value: &Value) -> Vec<ParsedEvent> {
        let mut out = Vec::new();
        if let Some(sid) = value.get("session_id").and_then(|s| s.as_str()) {
            out.push(ParsedEvent::SessionId(sid.to_string()));
        }
        out
    }

    /// stream_event：真正的增量流
    fn handle_stream_event(&mut self, value: &Value) -> Vec<ParsedEvent> {
        let event = &value["event"];
        let mut out = Vec::new();
        match event.get("type").and_then(|t| t.as_str()) {
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    let index = event["index"].as_u64().unwrap_or(0) as usize;
                    if let Some(tool_id) = block.get("id").and_then(|i| i.as_str()) {
                        if !self.seen_tool_ids.contains(tool_id) {
                            self.seen_tool_ids.insert(tool_id.to_string());
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            // 原生 AskUserQuestion：不渲染通用工具卡，改由 assistant
                            // 快照里的完整 input 发出 QuestionRequested。
                            if name != "AskUserQuestion" {
                                self.tool_ids_by_index.insert(index, tool_id.to_string());
                                self.tool_names_by_index.insert(index, name.clone());
                                out.push(ParsedEvent::ToolStarted {
                                    tool_id: tool_id.to_string(),
                                    tool_name: name,
                                    input,
                                });
                            }
                        }
                    }
                }
            }
            Some("content_block_delta") => {
                let index = event["index"].as_u64().map(|v| v as usize);
                let delta = &event["delta"];
                match delta.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                self.saw_stream_text = true;
                                self.emitted_any_text = true;
                                out.push(ParsedEvent::TextDelta(text.to_string()));
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                self.saw_stream_thinking = true;
                                out.push(ParsedEvent::ReasoningDelta(text.to_string()));
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(index) = index {
                            if let Some(part) = delta.get("partial_json").and_then(|p| p.as_str()) {
                                let buffer = self.tool_input_buffers.entry(index).or_default();
                                buffer.push_str(part);
                                if let Ok(input) = serde_json::from_str::<Value>(buffer) {
                                    if let Some(tool_id) = self.tool_ids_by_index.get(&index) {
                                        out.push(ParsedEvent::ToolInput {
                                            tool_id: tool_id.clone(),
                                            input,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("message_delta") => {
                // 兜底：某些版本用 message_delta.output_text_delta
                let delta = &event["delta"];
                if delta.get("type").and_then(|t| t.as_str()) == Some("output_text_delta") {
                    if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            self.saw_stream_text = true;
                            self.emitted_any_text = true;
                            out.push(ParsedEvent::TextDelta(text.to_string()));
                        }
                    }
                }
            }
            _ => {}
        }
        out
    }

    /// assistant：累积快照。有 stream_event 时文本/推理已覆盖，仅处理工具兜底。
    fn handle_assistant(&mut self, value: &Value) -> Vec<ParsedEvent> {
        let Some(content) = value["message"]["content"].as_array() else {
            return Vec::new();
        };
        let mut out = Vec::new();

        // 文本：仅旧版 CLI（无 stream_event）才用累积串差量
        if !self.saw_stream_text {
            let cumulative = concat_blocks(content, "text", "text");
            if !cumulative.is_empty() {
                let delta = text_delta(&self.last_text, &cumulative);
                if !delta.is_empty() {
                    out.push(ParsedEvent::TextDelta(delta));
                    self.emitted_any_text = true;
                }
                self.last_text = cumulative;
            }
        }

        if !self.saw_stream_thinking {
            let reasoning = concat_blocks(content, "thinking", "thinking");
            if !reasoning.is_empty() {
                let delta = text_delta(&self.last_reasoning, &reasoning);
                if !delta.is_empty() {
                    out.push(ParsedEvent::ReasoningDelta(delta));
                }
                self.last_reasoning = reasoning;
            }
        }

        // 工具调用：新 id 则补发 started；已见则用完整 input 兜底
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let Some(tool_id) = block.get("id").and_then(|i| i.as_str()) else {
                continue;
            };
            let tool_name = block
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("tool")
                .to_string();

            // 原生 AskUserQuestion：assistant 快照里 input 完整，转成问题卡事件。
            if tool_name == "AskUserQuestion" {
                self.seen_tool_ids.insert(tool_id.to_string());
                if self.seen_questions.insert(tool_id.to_string()) {
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    out.push(ParsedEvent::QuestionRequested {
                        tool_id: tool_id.to_string(),
                        input,
                    });
                }
                continue;
            }

            if !self.seen_tool_ids.contains(tool_id) {
                self.seen_tool_ids.insert(tool_id.to_string());
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                out.push(ParsedEvent::ToolStarted {
                    tool_id: tool_id.to_string(),
                    tool_name,
                    input,
                });
            } else {
                let input = block.get("input").cloned();
                if let Some(input) = input {
                    if !input.is_null() {
                        out.push(ParsedEvent::ToolInput {
                            tool_id: tool_id.to_string(),
                            input,
                        });
                    }
                }
            }
        }

        out
    }

    fn handle_user(&mut self, value: &Value) -> Vec<ParsedEvent> {
        let Some(content) = value["message"]["content"].as_array() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(|t| t.as_str()) else {
                continue;
            };
            let is_error = block
                .get("is_error")
                .and_then(|e| e.as_bool())
                .unwrap_or(false);
            let output = extract_tool_result_text(block);
            out.push(ParsedEvent::ToolCompleted {
                tool_id: tool_use_id.to_string(),
                tool_name: None,
                output: if is_error { None } else { Some(output.clone()) },
                error: if is_error { Some(output) } else { None },
            });
        }
        out
    }

    fn handle_result(&mut self, value: &Value) -> Vec<ParsedEvent> {
        self.result_seen = true;
        let cost_usd = value
            .get("cost_usd")
            .and_then(|c| c.as_f64())
            .or_else(|| value.get("total_cost_usd").and_then(|c| c.as_f64()));
        let session_id = value
            .get("session_id")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let is_error = value
            .get("is_error")
            .and_then(|e| e.as_bool())
            .unwrap_or(false);
        let result_text = value
            .get("result")
            .and_then(|r| r.as_str())
            .map(|s| s.to_string());
        let usage = if self.last_usage.is_some()
            || self.session_usage.is_some()
            || self.context_window_size.is_some()
            || self.context_used.is_some()
            || self.model.is_some()
        {
            Some(serde_json::json!({
                "threadId": session_id.clone(),
                "model": self.model,
                "last": normalize_usage(self.last_usage.as_ref()),
                "session": normalize_usage(self.session_usage.as_ref()),
                "contextWindow": self.context_window_size,
                "contextUsed": self.context_used,
                "contextUsedPercent": self.context_used_percent,
                "contextRemainingPercent": self.context_remaining_percent,
            }))
        } else {
            None
        };
        vec![ParsedEvent::TurnFinished {
            cost_usd,
            session_id,
            is_error,
            result_text,
            usage,
        }]
    }
}

/// 归一化单个 usage 对象为 { input, cached, output }；无有效字段返回 None。
fn normalize_usage(usage: Option<&Value>) -> Option<Value> {
    let usage = usage?;
    let input = num_from(usage.get("input_tokens").or_else(|| usage.get("inputTokens")));
    let output = num_from(usage.get("output_tokens").or_else(|| usage.get("outputTokens")));
    let cache_creation = num_from(
        usage
            .get("cache_creation_input_tokens")
            .or_else(|| usage.get("cacheCreationInputTokens"))
            .or_else(|| usage.get("cache_creation_tokens")),
    )
    .unwrap_or(0);
    let cache_read = num_from(
        usage
            .get("cache_read_input_tokens")
            .or_else(|| usage.get("cacheReadInputTokens"))
            .or_else(|| usage.get("cache_read_tokens")),
    )
    .unwrap_or(0);
    let cached = if cache_creation > 0 || cache_read > 0 {
        Some(cache_creation + cache_read)
    } else {
        None
    };
    if input.is_none() && cached.is_none() && output.is_none() {
        return None;
    }
    Some(serde_json::json!({
        "input": input.unwrap_or(0),
        "cached": cached.unwrap_or(0),
        "output": output.unwrap_or(0),
    }))
}

fn num_from(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .or_else(|| value.and_then(Value::as_i64).and_then(|v| (v >= 0).then_some(v as u64)))
        .or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|text| text.parse::<u64>().ok())
        })
}

fn num_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| {
        v.as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .or_else(|| {
                v.as_str()
                    .and_then(|text| text.parse::<f64>().ok())
                    .filter(|n| n.is_finite() && *n >= 0.0)
            })
    })
}

/// 递归查找 context_window 对象（顶层 / payload / data / hook，对齐 desktop-cc-gui）。
fn find_context_window(value: &Value) -> Option<&Value> {
    value
        .get("context_window")
        .or_else(|| value.get("contextWindow"))
        .or_else(|| value.get("payload").and_then(find_context_window))
        .or_else(|| value.get("data").and_then(find_context_window))
        .or_else(|| value.get("hook").and_then(find_context_window))
}

/// 累积式文本去重：cumulative 是否只是 last 的延伸
fn text_delta(last: &str, cumulative: &str) -> String {
    if cumulative.starts_with(last) {
        cumulative[last.len()..].to_string()
    } else if last.starts_with(cumulative) {
        // 变短了（压缩/重试），不回退
        String::new()
    } else {
        // 完全不连续，直接发全量
        cumulative.to_string()
    }
}

/// 按 type 过滤 content 数组，把对应字段按顺序拼成累积串
fn concat_blocks(content: &[Value], block_type: &str, field: &str) -> String {
    let mut out = String::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) == Some(block_type) {
            if let Some(s) = block.get(field).and_then(|f| f.as_str()) {
                out.push_str(s);
            }
        }
    }
    out
}

/// 从 tool_result 块提取可读文本（content 可能是字符串或 blocks 数组）
fn extract_tool_result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant_line(content: &str) -> String {
        format!(r#"{{"type":"assistant","message":{{"role":"assistant","content":{content}}}}}"#)
    }

    fn stream_line(event: &str) -> String {
        format!(r#"{{"type":"stream_event","event":{event},"session_id":"s1"}}"#)
    }

    #[test]
    fn stream_event_text_deltas_emit_directly() {
        let mut p = StreamParser::new();
        let l1 = stream_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#,
        );
        let l2 = stream_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}"#,
        );
        assert_eq!(
            p.process_line(&l1),
            vec![ParsedEvent::TextDelta("你好".into())]
        );
        assert_eq!(
            p.process_line(&l2),
            vec![ParsedEvent::TextDelta("世界".into())]
        );
        assert!(p.emitted_any_text);
    }

    #[test]
    fn assistant_cumulative_is_skipped_when_stream_event_seen() {
        let mut p = StreamParser::new();
        // stream_event 先覆盖文本
        p.process_line(&stream_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}"#,
        ));
        // assistant 快照不该再重复发文本
        let events = p.process_line(&assistant_line(r#"[{"type":"text","text":"hello"}]"#));
        assert!(events.is_empty());
    }

    #[test]
    fn assistant_cumulative_streams_when_no_stream_event() {
        // 旧版 CLI 回退路径
        let mut p = StreamParser::new();
        let l1 = assistant_line(r#"[{"type":"text","text":"Hel","partial":true}]"#);
        let l2 = assistant_line(r#"[{"type":"text","text":"Hello","partial":true}]"#);
        assert_eq!(
            p.process_line(&l1),
            vec![ParsedEvent::TextDelta("Hel".into())]
        );
        assert_eq!(
            p.process_line(&l2),
            vec![ParsedEvent::TextDelta("lo".into())]
        );
    }

    #[test]
    fn tool_use_streams_via_content_block_and_input_json() {
        let mut p = StreamParser::new();
        // content_block_start 给出 id/name
        let start = stream_line(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}"#,
        );
        let events = p.process_line(&start);
        assert_eq!(
            events,
            vec![ParsedEvent::ToolStarted {
                tool_id: "t1".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({}),
            }]
        );
        // input_json_delta 拼出完整 input
        let delta1 = stream_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls"}}"#,
        );
        let delta2 = stream_line(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" -la\"}"}}"#,
        );
        assert!(p.process_line(&delta1).is_empty()); // 未拼完整
        let events2 = p.process_line(&delta2);
        assert_eq!(
            events2,
            vec![ParsedEvent::ToolInput {
                tool_id: "t1".into(),
                input: serde_json::json!({"command": "ls -la"}),
            }]
        );
        // assistant 快照兜底完整 input（重复也无害）
        let snap = assistant_line(
            r#"[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]"#,
        );
        let events3 = p.process_line(&snap);
        assert_eq!(
            events3,
            vec![ParsedEvent::ToolInput {
                tool_id: "t1".into(),
                input: serde_json::json!({"command": "ls -la"}),
            }]
        );
    }

    #[test]
    fn tool_result_pairs_with_streamed_tool() {
        let mut p = StreamParser::new();
        p.process_line(&stream_line(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}"#,
        ));
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file list","is_error":false}]}}"#;
        let events = p.process_line(line);
        assert_eq!(
            events,
            vec![ParsedEvent::ToolCompleted {
                tool_id: "t1".into(),
                tool_name: None,
                output: Some("file list".into()),
                error: None,
            }]
        );
    }

    #[test]
    fn error_tool_result_surfaces_as_error() {
        let mut p = StreamParser::new();
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t9","content":"denied","is_error":true}]}}"#;
        let events = p.process_line(line);
        assert_eq!(
            events,
            vec![ParsedEvent::ToolCompleted {
                tool_id: "t9".into(),
                tool_name: None,
                output: None,
                error: Some("denied".into()),
            }]
        );
    }

    #[test]
    fn result_extracts_cost_and_session() {
        let mut p = StreamParser::new();
        let line = r#"{"type":"result","subtype":"success","result":"done","session_id":"abc-123","cost_usd":0.42,"is_error":false}"#;
        let events = p.process_line(line);
        assert_eq!(
            events,
            vec![ParsedEvent::TurnFinished {
                cost_usd: Some(0.42),
                session_id: Some("abc-123".into()),
                is_error: false,
                result_text: Some("done".into()),
                usage: None,
            }]
        );
        assert!(p.result_seen);
    }

    #[test]
    fn result_captures_usage_snapshot() {
        let mut p = StreamParser::new();
        // assistant 事件带 message.usage（最近一次调用）
        p.process_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[],"usage":{"input_tokens":121,"cache_read_input_tokens":27904,"output_tokens":59}}}"#,
        );
        // result 事件带顶层累计 usage 和会话 id
        let line = r#"{"type":"result","session_id":"abc-123","usage":{"input_tokens":121,"cache_read_input_tokens":27904,"output_tokens":59}}"#;
        let events = p.process_line(line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ParsedEvent::TurnFinished { usage: Some(usage), .. } => {
                assert_eq!(usage["threadId"], "abc-123");
                assert_eq!(usage["last"]["input"], 121);
                assert_eq!(usage["last"]["cached"], 27904);
                assert_eq!(usage["last"]["output"], 59);
                assert_eq!(usage["session"]["input"], 121);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn context_window_size_is_captured() {
        let mut p = StreamParser::new();
        p.process_line(
            r#"{"type":"system","session_id":"s1","context_window":{"context_window_size":200000,"current_usage":1000}}"#,
        );
        let line = r#"{"type":"result","session_id":"s1"}"#;
        let events = p.process_line(line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ParsedEvent::TurnFinished { usage: Some(usage), .. } => {
                assert_eq!(usage["contextWindow"], 200000);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn context_window_telemetry_is_captured() {
        let mut p = StreamParser::new();
        // 带模型名与完整 context_window 遥测的 assistant 事件
        p.process_line(
            r#"{"type":"assistant","session_id":"s1","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":100,"output_tokens":50}},"context_window":{"context_window_size":1000000,"current_usage":27300,"used_percentage":2.73,"remaining_percentage":97.27}}"#,
        );
        let events = p.process_line(r#"{"type":"result","session_id":"s1"}"#);
        assert_eq!(events.len(), 1);
        match &events[0] {
            ParsedEvent::TurnFinished { usage: Some(usage), .. } => {
                assert_eq!(usage["model"], "claude-sonnet-4-6");
                assert_eq!(usage["contextWindow"], 1000000);
                assert_eq!(usage["contextUsed"], 27300);
                assert_eq!(usage["contextUsedPercent"], 2.73);
                assert_eq!(usage["contextRemainingPercent"], 97.27);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn garbage_lines_are_ignored() {
        let mut p = StreamParser::new();
        assert!(p.process_line("not json").is_empty());
        assert!(p.process_line(r#"{"type":"unknown","foo":1}"#).is_empty());
    }

    #[test]
    fn native_ask_user_question_emits_question_requested_once() {
        let mut p = StreamParser::new();
        // stream_event 的 content_block_start 不渲染通用工具卡
        let start = stream_line(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{}}}"#,
        );
        assert!(p.process_line(&start).is_empty());
        // assistant 快照里的完整 input 触发 QuestionRequested
        let snap = assistant_line(
            r#"[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[{"question":"A?","options":[{"label":"x"}]}]}}]"#,
        );
        let events = p.process_line(&snap);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ParsedEvent::QuestionRequested { ref tool_id, .. } if tool_id == "q1"));
        // 重复快照不再重复发
        assert!(p.process_line(&snap).is_empty());
    }

    #[test]
    fn mcp_ask_user_question_still_renders_as_tool_card() {
        let mut p = StreamParser::new();
        let start = stream_line(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"m1","name":"mcp__kkcoder__AskUserQuestion","input":{}}}"#,
        );
        let events = p.process_line(&start);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ParsedEvent::ToolStarted { ref tool_name, .. } if tool_name == "mcp__kkcoder__AskUserQuestion"));
    }
}
