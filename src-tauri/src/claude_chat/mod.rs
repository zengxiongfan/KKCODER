//! Claude Code GUI 聊天引擎：以 `claude -p --output-format stream-json` 非交互模式
//! 驱动 Claude Code，解析 NDJSON 流并通过 `claude-chat-event` 事件通道推送到前端。
//!
//! 移植自 desktop-cc-gui 的核心封装思路（claude.rs build_command_with_profile），
//! 精简为文本消息 + 工具调用卡片 + 会话续聊，不引入 MCP/权限弹窗/图片/provider。

mod askuser_mcp;
pub(crate) mod catalog;
mod parser;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{find_claude_jsonl, log_session, log_to_file, read_claude_transcript};

pub const CHAT_EVENT_CHANNEL: &str = "claude-chat-event";

/// 单会话当前活跃的 turn（存在 == busy）
pub struct ActiveChatTurn {
    pub pid: u32,
    pub cancelled: Arc<AtomicBool>,
    /// 该 turn 使用的模型（AskUserQuestion 恢复路径沿用）
    pub model: Option<String>,
    /// 该 turn 的临时 settings 文件（--settings，仅本次进程生效；收尾时删除）
    pub settings_file: Option<std::path::PathBuf>,
    /// 该 turn 的访问模式（full-access / read-only / default / current，
    /// AskUserQuestion 恢复路径沿用）
    pub access_mode: Option<String>,
}

/// 原生 AskUserQuestion 的待回答项：回答经 sender 回传给阻塞中的 reader 线程
struct NativeQuestion {
    session_id: String,
    sender: mpsc::Sender<String>,
}

/// ExitPlanMode 的待批准项：GUI 回传批准（true）后，reader 向仍打开的
/// claude stdin 注入 tool_result（"Plan approved"），模型随即退出计划模式继续执行。
struct PendingPlanApproval {
    session_id: String,
    sender: mpsc::Sender<bool>,
}

#[derive(Default)]
pub struct ClaudeChatManager {
    /// session_id -> 活跃 turn
    turns: Arc<Mutex<HashMap<String, ActiveChatTurn>>>,
    /// 已成功建过会话（result 已出现）的 session_id，后续轮用 --resume
    started_sessions: Arc<Mutex<HashSet<String>>>,
    pending_questions: askuser_mcp::PendingQuestions,
    askuser_mcp: Arc<OnceLock<askuser_mcp::AskUserMcpServer>>,
    /// 原生 AskUserQuestion：request_id -> 回传回答的通道（reader 线程阻塞等待）
    native_questions: Arc<Mutex<HashMap<String, NativeQuestion>>>,
    /// 计划模式退出批准：request_id -> 待批准项
    plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    /// 每会话最近一次归一化 token 用量（/context 用）
    session_usage: Arc<Mutex<HashMap<String, serde_json::Value>>>,
}

/// 推送给前端的扁平事件载荷（字段按需出现）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    questions: Option<serde_json::Value>,
}

impl ChatStreamEvent {
    fn new(session_id: &str, kind: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            text: None,
            tool_id: None,
            tool_name: None,
            input: None,
            output: None,
            error: None,
            message: None,
            cost_usd: None,
            is_error: None,
            request_id: None,
            questions: None,
        }
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit(CHAT_EVENT_CHANNEL, self);
    }
}

/// 拼装并 spawn 一个 `claude -p` 进程，写入 stream-json 输入并关闭 stdin。
/// `model` 为 KKCODER 全局选择的模型覆盖（None = 跟随 CC Switch 默认配置）。
/// `settings_file` 为所选供应商的临时 settings 文件（None = 跟随 CC Switch 现状）。
#[allow(clippy::too_many_arguments)]
fn spawn_claude_process(
    app: &AppHandle,
    askuser_mcp: &OnceLock<askuser_mcp::AskUserMcpServer>,
    pending_questions: &askuser_mcp::PendingQuestions,
    session_id: &str,
    directory: &str,
    agent_session_id: &str,
    resume: bool,
    content: Vec<serde_json::Value>,
    model: Option<&str>,
    settings_file: Option<&std::path::Path>,
    access_mode: Option<&str>,
) -> Result<
    (
        Child,
        Option<std::process::ChildStdin>,
        std::process::ChildStdout,
        std::process::ChildStderr,
    ),
    String,
> {
    let ask_server =
        askuser_mcp::ensure_started(askuser_mcp, app.clone(), pending_questions.clone())?;
    let session_flag = if resume { "--resume" } else { "--session-id" };
    // 访问模式 → CLI 权限标志（对齐 CC-GUI：用户在聊天界面选择，规划模式 =
    // 会话从 --permission-mode plan 启动，模型无需自己切计划模式）
    let mut access_args: Vec<String> = match access_mode {
        Some("read-only") => vec!["--permission-mode".to_string(), "plan".to_string()],
        Some("default") => vec!["--permission-mode".to_string(), "default".to_string()],
        Some("current") => vec!["--permission-mode".to_string(), "acceptEdits".to_string()],
        _ => vec!["--dangerously-skip-permissions".to_string()],
    };
    let mut args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--include-hook-events".to_string(),
        "--mcp-config".to_string(),
        ask_server.config_json(session_id),
        "--allowedTools".to_string(),
        askuser_mcp::AskUserMcpServer::allowed_tool_name(),
        // claude 2.1 内置了原生 AskUserQuestion 工具：在 -p 非交互模式下被
        // cc-switch/claude 立即判为权限拒绝并返回 "Answer questions?" 错误，
        // 模型一旦选它：面板不会出现，且 reader 线程会阻塞空等 30 分钟。
        // 禁用内置工具，强制模型走我们的 MCP 桥（mcp__kkcoder__AskUserQuestion）。
        // 计划模式工具（EnterPlanMode/ExitPlanMode）保持可用：reader 检测到
        // ExitPlanMode 时通过仍打开的 stdin 注入 tool_result 完成 GUI 批准。
        "--disallowedTools".to_string(),
        "AskUserQuestion".to_string(),
        session_flag.to_string(),
        agent_session_id.to_string(),
    ];
    args.append(&mut access_args);
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model.trim().to_string());
    }
    if let Some(settings_file) = settings_file {
        // 用所选供应商的临时 settings（直连），不动 ~/.claude/settings.json
        args.push("--settings".to_string());
        args.push(settings_file.display().to_string());
    }

    let mut cmd = build_claude_command(&args);
    cmd.env("MCP_TOOL_TIMEOUT", "1800000");
    cmd.current_dir(directory);

    let mut child = cmd.spawn().map_err(|e| format!("启动 claude 失败: {e}"))?;

    // 写入初始用户消息后**保留 stdin**：ExitPlanMode 等需要流式回传（注入
    // tool_result 完成 GUI 批准）的场景必须保持输入流打开（关闭/EOF 时
    // claude 无法获得批准通道，会直接把 ExitPlanMode 判为 "Exit plan mode?" 错误）。
    let stdin_handle = if let Some(mut stdin) = child.stdin.take() {
        let input_json = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        });
        if let Err(e) = writeln!(stdin, "{input_json}") {
            let _ = child.kill();
            return Err(format!("写入 claude stdin 失败: {e}"));
        }
        Some(stdin)
    } else {
        let _ = child.kill();
        return Err("无法获取 claude stdin".into());
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            return Err("无法获取 claude stdout".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            return Err("无法获取 claude stderr".into());
        }
    };

    Ok((child, stdin_handle, stdout, stderr))
}

/// 发送一条用户消息，启动一个 claude -p turn
#[tauri::command]
pub fn chat_send_message(
    app: AppHandle,
    state: State<'_, ClaudeChatManager>,
    model_state: State<'_, crate::claude_model::ClaudeModelState>,
    session_id: String,
    directory: String,
    agent_session_id: String,
    text: String,
    images: Option<Vec<String>>,
    access_mode: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() && images.as_ref().is_none_or(Vec::is_empty) {
        return Err("消息内容为空".into());
    }
    if !std::path::Path::new(&directory).is_dir() {
        return Err(format!("项目目录不存在: {directory}"));
    }
    let image_blocks = images
        .unwrap_or_default()
        .into_iter()
        .map(|image| parse_image_data_url(&image))
        .collect::<Result<Vec<_>, _>>()?;

    // KKCODER 全局模型覆盖（None = 跟随 CC Switch 默认 tier 配置）
    let model = {
        let guard = model_state
            .model
            .lock()
            .map_err(|error| error.to_string())?;
        guard.clone()
    };

    // busy 检查
    {
        let turns = state.turns.lock().map_err(|e| e.to_string())?;
        if turns.contains_key(&session_id) {
            return Err("该会话正在生成中，请先取消".into());
        }
    }

    // 是否续聊由后端事实决定，避免前端 tab 生命周期把首次发送误判为 reopen。
    // resume 必须以「转录文件真实存在」为前提：斜杠命令等合成回合不会创建
    // 会话文件，若强行 --resume 会得到 "No conversation found" 空响应。
    let resume = find_claude_jsonl(&agent_session_id, &directory).is_some()
        && {
            state
                .started_sessions
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&session_id)
        };

    let mut content = image_blocks;
    if !text.trim().is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }

    // 所选供应商的临时 settings 文件（直连该供应商，不碰 ~/.claude/settings.json 与 cc-switch.db）
    let settings_file = crate::claude_model::build_settings_override_file(&model_state, &session_id);

    let (mut child, stdin_handle, stdout, stderr) = spawn_claude_process(
        &app,
        state.askuser_mcp.as_ref(),
        &state.pending_questions,
        &session_id,
        &directory,
        &agent_session_id,
        resume,
        content,
        model.as_deref(),
        settings_file.as_deref(),
        access_mode.as_deref(),
    )?;
    let pid = child.id();
    log_session(&session_id, &format!(
        "[claude_chat] send session={session_id} resume={resume} pid={pid} model={} mode={}",
        model.as_deref().unwrap_or("(默认)"),
        access_mode.as_deref().unwrap_or("full-access")
    ));

    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut turns = state.turns.lock().map_err(|e| e.to_string())?;
        if turns.contains_key(&session_id) {
            // 并发双击兜底
            let _ = child.kill();
            return Err("该会话正在生成中，请先取消".into());
        }
        turns.insert(
            session_id.clone(),
            ActiveChatTurn {
                pid,
                cancelled: cancelled.clone(),
                model,
                settings_file,
                access_mode,
            },
        );
    }

    // turn:started
    ChatStreamEvent::new(&session_id, "turn:started").emit(&app);

    // 后台读线程：drain stderr + 逐行解析 stdout + 收尾清理
    spawn_reader_thread(
        app,
        state.turns.clone(),
        state.started_sessions.clone(),
        state.askuser_mcp.clone(),
        state.pending_questions.clone(),
        state.plan_approvals.clone(),
        state.native_questions.clone(),
        state.session_usage.clone(),
        session_id,
        directory,
        agent_session_id,
        child,
        stdin_handle,
        stdout,
        stderr,
        cancelled,
    );

    Ok(())
}

fn parse_image_data_url(value: &str) -> Result<serde_json::Value, String> {
    let (header, data) = value
        .split_once(',')
        .ok_or_else(|| "图片 data URL 格式无效".to_string())?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "图片必须使用 base64 data URL".to_string())?;
    if !matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err(format!("不支持的图片格式: {media_type}"));
    }
    if data.trim().is_empty() {
        return Err("图片内容为空".to_string());
    }
    if data.len().saturating_mul(3) / 4 > 10 * 1024 * 1024 {
        return Err("单张图片不能超过 10 MB".to_string());
    }
    Ok(serde_json::json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}

/// 取消当前活跃 turn（杀整棵进程树）
#[tauri::command]
pub fn chat_cancel(state: State<'_, ClaudeChatManager>, session_id: String) -> Result<(), String> {
    askuser_mcp::cancel_session_questions(&state.pending_questions, &session_id);
    // 断开原生 AskUserQuestion 通道，让 reader 线程从 recv_timeout 退出
    if let Ok(mut native) = state.native_questions.lock() {
        native.retain(|_, q| q.session_id != session_id);
    }
    // 断开计划模式批准：批准返回 false（保持计划模式），reader 注入拒绝后继续
    if let Ok(mut approvals) = state.plan_approvals.lock() {
        approvals.retain(|_, a| a.session_id != session_id);
    }
    let pid = {
        let turns = state.turns.lock().map_err(|e| e.to_string())?;
        let Some(turn) = turns.get(&session_id) else {
            return Ok(()); // 幂等
        };
        turn.cancelled.store(true, Ordering::SeqCst);
        turn.pid
    };
    // 保留 turns 条目直到读线程完成收尾，阻止旧 turn 与立即重发的新 turn 串流。
    kill_process_tree(pid);
    Ok(())
}

#[tauri::command]
pub fn chat_answer_question(
    state: State<'_, ClaudeChatManager>,
    session_id: String,
    request_id: String,
    answers: serde_json::Value,
) -> Result<(), String> {
    // 原生 AskUserQuestion：回答直接回传给阻塞中的 reader 线程
    {
        let mut native = state
            .native_questions
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(question) = native.remove(&request_id) {
            if question.session_id != session_id {
                return Err("问题不属于当前会话".to_string());
            }
            let answer = askuser_mcp::format_answer(&answers);
            return question
                .sender
                .send(answer)
                .map_err(|_| "Claude 已停止等待该问题".to_string());
        }
    }

    // MCP AskUserQuestion：经 oneshot 回传给 MCP server 的 tools/call
    let question = {
        let mut pending = state
            .pending_questions
            .lock()
            .map_err(|error| error.to_string())?;
        let existing = pending
            .get(&request_id)
            .ok_or_else(|| "该问题已结束或不存在".to_string())?;
        if existing.session_id != session_id {
            return Err("问题不属于当前会话".to_string());
        }
        pending
            .remove(&request_id)
            .ok_or_else(|| "该问题已结束或不存在".to_string())?
    };
    question
        .sender
        .send(Ok(askuser_mcp::format_answer(&answers)))
        .map_err(|_| "Claude 已停止等待该问题".to_string())
}

/// 计划模式退出批准：GUI 点击「批准并执行」/「拒绝」后调用。
/// approve=true → reader 向 claude stdin 注入批准 tool_result，模型退出
/// 计划模式继续执行；false → 注入拒绝，模型留在计划模式继续修改方案。
#[tauri::command]
pub fn chat_answer_plan_approval(
    state: State<'_, ClaudeChatManager>,
    session_id: String,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    let approval = {
        let mut map = state
            .plan_approvals
            .lock()
            .map_err(|error| error.to_string())?;
        map.remove(&request_id)
            .ok_or_else(|| "该批准请求已结束或不存在".to_string())?
    };
    if approval.session_id != session_id {
        return Err("该批准请求不属于当前会话".to_string());
    }
    approval
        .sender
        .send(approve)
        .map_err(|_| "Claude 已结束等待该批准".to_string())
}

/// 获取当前会话最新的规划方案内容（供前端弹窗展示或主动同步）
#[tauri::command]
pub fn chat_get_latest_plan(
    agent_session_id: String,
    directory: String,
) -> Result<serde_json::Value, String> {
    Ok(resolve_exit_plan_payload(
        &serde_json::Value::Null,
        &agent_session_id,
        &directory,
    ))
}

/// 读取 claude 的 jsonl 转录作为历史消息（复用 lib.rs 既有实现）
#[tauri::command]
pub fn chat_get_history(
    directory: String,
    agent_session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let jsonl = find_claude_jsonl(&agent_session_id, &directory)
        .ok_or_else(|| "未找到该会话的 Claude 转录文件".to_string())?;
    let msgs = read_claude_transcript(&jsonl);
    Ok(msgs
        .into_iter()
        .map(|(role, text)| serde_json::json!({ "role": role, "text": text }))
        .collect())
}

/// 重置会话上下文（/new）：删除转录文件并清掉「已建会话」标记，
/// 使下一轮发送走 `--session-id` 开启一个全新会话。
#[tauri::command]
pub fn chat_reset_context(
    state: State<'_, ClaudeChatManager>,
    session_id: String,
    agent_session_id: String,
    directory: String,
) -> Result<(), String> {
    if let Ok(mut started) = state.started_sessions.lock() {
        started.remove(&session_id);
    }
    if let Some(jsonl) = find_claude_jsonl(&agent_session_id, &directory) {
        let _ = std::fs::remove_file(&jsonl);
    }
    log_session(&session_id, &format!(
        "[claude_chat] reset context session={session_id} agent={agent_session_id}"
    ));
    Ok(())
}

/// 返回该会话归一化 token 用量（/context 用）。
/// 优先用进程内实时快照（含 Claude context_window 遥测：窗口/已用/占比），
/// 无实时快照时回退读取转录 jsonl（历史会话），都没有则返回 null。
#[tauri::command]
pub fn chat_get_context_usage(
    state: State<'_, ClaudeChatManager>,
    session_id: String,
    directory: String,
    agent_session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let live = state.session_usage.lock().map_err(|e| e.to_string())?;
    if let Some(usage) = live.get(&session_id) {
        // 实时快照含 context_window 遥测，比 jsonl 更准
        return Ok(Some(usage.clone()));
    }
    drop(live);
    if let Some(jsonl) = find_claude_jsonl(&agent_session_id, &directory) {
        if let Some(usage) = read_claude_usage(&jsonl) {
            return Ok(Some(usage));
        }
    }
    Ok(None)
}

/// 从 Claude 转录 jsonl 聚合 token 用量。
/// - last = 最后一条 assistant 消息的 `message.usage`（最近一次 API 调用）
/// - session = 最后一个 result 行的累计 usage；无 result 时累加所有 assistant usage
/// - threadId = 转录中最后出现的 session_id
fn read_claude_usage(jsonl_path: &std::path::Path) -> Option<serde_json::Value> {
    let file = std::fs::File::open(jsonl_path).ok()?;
    let reader = BufReader::new(file);
    let mut last: Option<(u64, u64, u64)> = None;
    let mut session: Option<(u64, u64, u64)> = None;
    let mut accumulated: (u64, u64, u64) = (0, 0, 0);
    let mut have_accumulated = false;
    let mut thread_id: Option<String> = None;
    let mut model: Option<String> = None;

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(sid) = value.get("session_id").and_then(serde_json::Value::as_str) {
            thread_id = Some(sid.to_string());
        }
        // result 行的顶层 usage 是整轮累计
        if value.get("type").and_then(serde_json::Value::as_str) == Some("result") {
            if let Some(totals) = value.get("usage").and_then(usage_totals) {
                session = Some(totals);
            }
            continue;
        }
        if let Some(m) = value
            .get("message")
            .and_then(|message| message.get("model"))
            .and_then(serde_json::Value::as_str)
        {
            model = Some(m.to_string());
        }
        let usage = value
            .get("message")
            .and_then(|message| message.get("usage"))
            .or_else(|| value.get("usage"));
        if let Some(totals) = usage.and_then(usage_totals) {
            last = Some(totals);
            accumulated.0 += totals.0;
            accumulated.1 += totals.1;
            accumulated.2 += totals.2;
            have_accumulated = true;
        }
    }

    if last.is_none() && !have_accumulated && session.is_none() {
        return None;
    }
    let session = session.or_else(|| have_accumulated.then_some(accumulated));
    let fmt = |t: Option<(u64, u64, u64)>| {
        t.map(|(input, cached, output)| {
            serde_json::json!({ "input": input, "cached": cached, "output": output })
        })
    };
    Some(serde_json::json!({
        "threadId": thread_id,
        "model": model,
        "last": fmt(last),
        "session": fmt(session),
        // 上下文窗口只存在于 claude -p 实时流的 context_window 事件，jsonl 里没有；
        // 前端依据 model 用映射表/用户设置补上
        "contextWindow": null,
    }))
}

/// 从单个 usage 对象归一化出 (input, cached, output)；无有效字段返回 None。
fn usage_totals(usage: &serde_json::Value) -> Option<(u64, u64, u64)> {
    if !usage.is_object() {
        return None;
    }
    let input = num_from_usage(usage.get("input_tokens").or_else(|| usage.get("inputTokens"))).unwrap_or(0);
    let output =
        num_from_usage(usage.get("output_tokens").or_else(|| usage.get("outputTokens"))).unwrap_or(0);
    let cache_creation = num_from_usage(
        usage
            .get("cache_creation_input_tokens")
            .or_else(|| usage.get("cacheCreationInputTokens"))
            .or_else(|| usage.get("cache_creation_tokens")),
    )
    .unwrap_or(0);
    let cache_read = num_from_usage(
        usage
            .get("cache_read_input_tokens")
            .or_else(|| usage.get("cacheReadInputTokens"))
            .or_else(|| usage.get("cache_read_tokens")),
    )
    .unwrap_or(0);
    let cached = if cache_creation > 0 || cache_read > 0 {
        cache_creation + cache_read
    } else {
        0
    };
    if input == 0 && cached == 0 && output == 0 {
        None
    } else {
        Some((input, cached, output))
    }
}

fn num_from_usage(value: Option<&serde_json::Value>) -> Option<u64> {
    value.and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().and_then(|n| (n >= 0).then_some(n as u64)))
            .or_else(|| v.as_str().and_then(|text| text.parse::<u64>().ok()))
    })
}

fn build_claude_command(args: &[String]) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "claude"]).args(args);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("claude");
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }
}

pub(super) fn emit_question_requested(
    app: &AppHandle,
    session_id: &str,
    request_id: &str,
    questions: serde_json::Value,
) {
    let mut event = ChatStreamEvent::new(session_id, "question:requested");
    event.request_id = Some(request_id.to_string());
    event.questions = Some(questions);
    event.emit(app);
}

#[allow(clippy::too_many_arguments)]
fn spawn_reader_thread(
    app: AppHandle,
    turns: Arc<Mutex<HashMap<String, ActiveChatTurn>>>,
    started_sessions: Arc<Mutex<HashSet<String>>>,
    askuser_mcp: Arc<OnceLock<askuser_mcp::AskUserMcpServer>>,
    pending_questions: askuser_mcp::PendingQuestions,
    plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    native_questions: Arc<Mutex<HashMap<String, NativeQuestion>>>,
    session_usage: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    session_id: String,
    directory: String,
    agent_session_id: String,
    child: Child,
    stdin_handle: Option<std::process::ChildStdin>,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    cancelled: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        run_process_loop(
            app,
            turns,
            started_sessions,
            askuser_mcp,
            pending_questions,
            plan_approvals,
            native_questions,
            session_usage,
            session_id,
            directory,
            agent_session_id,
            child,
            stdin_handle,
            Some(stdout),
            Some(stderr),
            cancelled,
        );
    });
}

/// 读取单个 claude 进程的 stdout；若中途遇到原生 AskUserQuestion 则杀进程并
/// 用 `--resume` 回传回答；遇到 ExitPlanMode 则通过保留的 stdin 注入
/// tool_result（GUI 批准），模型在同进程内继续执行。直到 turn 结束（result）
/// 或进程 EOF。
#[allow(clippy::too_many_arguments)]
fn run_process_loop(
    app: AppHandle,
    turns: Arc<Mutex<HashMap<String, ActiveChatTurn>>>,
    started_sessions: Arc<Mutex<HashSet<String>>>,
    askuser_mcp: Arc<OnceLock<askuser_mcp::AskUserMcpServer>>,
    pending_questions: askuser_mcp::PendingQuestions,
    plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApproval>>>,
    native_questions: Arc<Mutex<HashMap<String, NativeQuestion>>>,
    session_usage: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    session_id: String,
    directory: String,
    agent_session_id: String,
    mut child: Child,
    mut stdin_handle: Option<std::process::ChildStdin>,
    mut stdout: Option<std::process::ChildStdout>,
    mut stderr: Option<std::process::ChildStderr>,
    cancelled: Arc<AtomicBool>,
) {
    let mut finished_emitted = false;
    let mut session_started = false;
    let mut any_text = false;
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    loop {
        let (stdout_handle, stderr_handle) = match (stdout.take(), stderr.take()) {
            (Some(o), Some(e)) => (o, e),
            _ => break,
        };

        // stderr drain，防 claude 未安装时 stderr 撑爆管道
        let drain_buf = stderr_buf.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr_handle);
            for line in reader.lines() {
                if let Ok(l) = line {
                    if let Ok(mut buf) = drain_buf.lock() {
                        buf.push_str(&l);
                        buf.push('\n');
                        if buf.len() > 64 * 1024 {
                            buf.clear();
                        }
                    }
                }
            }
        });

        let mut resume_answer: Option<String> = None;
        let mut early_exit = false;

        {
            let mut parser = parser::StreamParser::new();
            let reader = BufReader::new(stdout_handle);
            'lines: for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                for event in parser.process_line(&line) {
                    match event {
                        parser::ParsedEvent::SessionId(_) => {}
                        parser::ParsedEvent::TextDelta(text) => {
                            any_text = true;
                            let mut e = ChatStreamEvent::new(&session_id, "text:delta");
                            e.text = Some(text);
                            e.emit(&app);
                        }
                        parser::ParsedEvent::ReasoningDelta(text) => {
                            let mut e = ChatStreamEvent::new(&session_id, "reasoning:delta");
                            e.text = Some(text);
                            e.emit(&app);
                        }
                        parser::ParsedEvent::ToolStarted {
                            tool_id,
                            tool_name,
                            input,
                        } => {
                            // 计划模式退出（ExitPlanMode）：-p 模式下关闭/EOF stdin
                            // 时 claude 会直接回 "Exit plan mode?" 错误。这里保持
                            // stdin 打开，发 GUI 批准卡片，收到批准后注入 tool_result，
                            // 模型在同进程内退出计划模式继续执行（相当于 CLI 的 y 确认）。
                            if tool_name == "ExitPlanMode" {
                                let request_id = uuid::Uuid::new_v4().to_string();
                                let (tx, rx) = mpsc::channel();
                                if let Ok(mut map) = plan_approvals.lock() {
                                    map.insert(
                                        request_id.clone(),
                                        PendingPlanApproval {
                                            session_id: session_id.clone(),
                                            sender: tx,
                                        },
                                    );
                                }
                                let enriched_input = resolve_exit_plan_payload(
                                    &input,
                                    &agent_session_id,
                                    &directory,
                                );
                                let mut e = ChatStreamEvent::new(&session_id, "plan:approval");
                                e.request_id = Some(request_id.clone());
                                e.tool_id = Some(tool_id.clone());
                                e.input = Some(enriched_input);
                                e.emit(&app);
                                let decision = rx.recv_timeout(std::time::Duration::from_secs(
                                    30 * 60,
                                ));
                                if let Ok(mut map) = plan_approvals.lock() {
                                    map.remove(&request_id);
                                }
                                // 不管批准/拒绝/超时都注入 tool_result，claude 才能继续
                                let decision_text = match decision {
                                    Ok(true) => "Plan approved. Exit plan mode and continue implementing.",
                                    Ok(false) => {
                                        "User rejected the plan. Stay in plan mode and revise the plan."
                                    }
                                    Err(_) => {
                                        "User did not respond to the plan approval. Stay in plan mode."
                                    }
                                };
                                if let Some(stdin) = stdin_handle.as_mut() {
                                    let msg = serde_json::json!({
                                        "type": "user",
                                        "message": {
                                            "role": "user",
                                            "content": [{
                                                "type": "tool_result",
                                                "tool_use_id": tool_id,
                                                "content": decision_text,
                                            }]
                                        }
                                    });
                                    if writeln!(stdin, "{msg}").is_err() {
                                        // stdin 已关闭（claude 退出）：直接收尾
                                        log_to_file(&format!(
                                            "[claude_chat] ExitPlanMode 注入失败（进程可能已退出）: {decision_text}"
                                        ));
                                    }
                                }
                                continue;
                            }
                            let mut e = ChatStreamEvent::new(&session_id, "tool:started");
                            e.tool_id = Some(tool_id);
                            e.tool_name = Some(tool_name);
                            e.input = Some(input);
                            e.emit(&app);
                        }
                        parser::ParsedEvent::ToolInput { tool_id, input } => {
                            let mut e = ChatStreamEvent::new(&session_id, "tool:input");
                            e.tool_id = Some(tool_id);
                            e.input = Some(input);
                            e.emit(&app);
                        }
                        parser::ParsedEvent::ToolCompleted {
                            tool_id,
                            tool_name,
                            output,
                            error,
                        } => {
                            let mut e = ChatStreamEvent::new(&session_id, "tool:completed");
                            e.tool_id = Some(tool_id);
                            e.tool_name = tool_name;
                            e.output = output;
                            e.error = error;
                            e.emit(&app);
                        }
                        parser::ParsedEvent::QuestionRequested { input, .. } => {
                            let questions = askuser_mcp::normalize_questions(&input);
                            if questions.as_array().is_none_or(Vec::is_empty) {
                                continue;
                            }
                            let request_id = uuid::Uuid::new_v4().to_string();
                            let (tx, rx) = mpsc::channel();
                            if let Ok(mut map) = native_questions.lock() {
                                map.insert(
                                    request_id.clone(),
                                    NativeQuestion {
                                        session_id: session_id.clone(),
                                        sender: tx,
                                    },
                                );
                            }
                            emit_question_requested(&app, &session_id, &request_id, questions);
                            // 阻塞等待前端回答；超时/取消则结束本 turn。
                            let answer = rx.recv_timeout(std::time::Duration::from_secs(30 * 60));
                            if let Ok(mut map) = native_questions.lock() {
                                map.remove(&request_id);
                            }
                            match answer {
                                Ok(text) => {
                                    resume_answer = Some(text);
                                    early_exit = true;
                                    break 'lines;
                                }
                                Err(_) => {
                                    early_exit = true;
                                    break 'lines;
                                }
                            }
                        }
                        parser::ParsedEvent::TurnFinished {
                            cost_usd,
                            session_id: new_sid,
                            is_error,
                            result_text,
                            usage,
                        } => {
                            // 记录该会话的 token 用量（/context 用）
                            if let Some(usage) = usage {
                                if let Ok(mut map) = session_usage.lock() {
                                    map.insert(session_id.clone(), usage);
                                }
                            }
                            // 本 turn 没有任何文本流时，用 result.result 合成一条
                            if !any_text && !is_error {
                                if let Some(text) = result_text.as_deref() {
                                    if !text.trim().is_empty() {
                                        let mut e = ChatStreamEvent::new(&session_id, "text:delta");
                                        e.text = Some(text.to_string());
                                        e.emit(&app);
                                        any_text = true;
                                    }
                                }
                            }
                            if !session_started {
                                session_started = true;
                                // 仅当 claude **真实创建了会话转录文件**时才标记
                                // 「已建过会话」：`-p` 模式收到以 `/` 开头的输入
                                // （斜杠命令）时，claude 返回合成回复（如
                                // "/mcp isn't available in this environment"）且
                                // **不创建会话**。若此时误标已建过，后续消息会
                                // `--resume` 一个不存在的会话 → "No conversation
                                // found" → 空响应（表现为「发什么消息都不回复」）。
                                if !is_error
                                    && find_claude_jsonl(&agent_session_id, &directory).is_some()
                                {
                                    if let Ok(mut s) = started_sessions.lock() {
                                        s.insert(session_id.clone());
                                    }
                                }
                            }
                            let mut e = ChatStreamEvent::new(&session_id, "turn:finished");
                            e.cost_usd = cost_usd;
                            e.is_error = Some(is_error);
                            if let Some(sid) = new_sid {
                                // 转发真实 session id 便于前端回写
                                let mut ev = ChatStreamEvent::new(&session_id, "session:id");
                                ev.text = Some(sid);
                                ev.emit(&app);
                            }
                            e.emit(&app);
                            finished_emitted = true;
                            // 回合已结束：立即关闭 stdin。stream-json 输入模式下
                            // 若保持 stdin 打开，claude 会无限等待更多输入而不退出
                            //（实测挂起），reader 将永远收不到 EOF。
                            if let Some(stdin) = stdin_handle.take() {
                                drop(stdin);
                            }
                        }
                    }
                }
            }
        }

        if let Some(answer) = resume_answer {
            // 子进程仍阻塞在 AskUserQuestion 上：先杀进程再 join stderr，
            // 否则 stderr 线程因子进程不退出而一直阻塞，join 会挂住。
            kill_process_tree(child.id());
            let _ = child.wait();
            let _ = stderr_thread.join();
            // 沿用本 turn 启动时的模型覆盖、临时 settings 文件与访问模式
            let turn_state = {
                let guard = turns.lock().ok();
                guard
                    .as_ref()
                    .and_then(|t| t.get(&session_id))
                    .map(|turn| {
                        (
                            turn.model.clone(),
                            turn.settings_file.clone(),
                            turn.access_mode.clone(),
                        )
                    })
            };
            let (turn_model, turn_settings_file, turn_access_mode) =
                turn_state.unwrap_or((None, None, None));
            let content = vec![serde_json::json!({ "type": "text", "text": answer })];
            match spawn_claude_process(
                &app,
                askuser_mcp.as_ref(),
                &pending_questions,
                &session_id,
                &directory,
                &agent_session_id,
                true,
                content,
                turn_model.as_deref(),
                turn_settings_file.as_deref(),
                turn_access_mode.as_deref(),
            ) {
                Ok((new_child, new_stdin, new_stdout, new_stderr)) => {
                    let pid = new_child.id();
                    if let Ok(mut t) = turns.lock() {
                        if let Some(turn) = t.get_mut(&session_id) {
                            turn.pid = pid;
                        }
                    }
                    log_session(&session_id, &format!(
                        "[claude_chat] resume session={session_id} pid={pid} model={} mode={}",
                        turn_model.as_deref().unwrap_or("(默认)"),
                        turn_access_mode.as_deref().unwrap_or("full-access")
                    ));
                    child = new_child;
                    stdin_handle = new_stdin;
                    stdout = Some(new_stdout);
                    stderr = Some(new_stderr);
                    continue;
                }
                Err(error) => {
                    let mut e = ChatStreamEvent::new(&session_id, "turn:error");
                    e.message = Some(error);
                    e.emit(&app);
                    finished_emitted = true;
                }
            }
        } else {
            // 正常 EOF：子进程已结束，stderr 线程随即返回；超时提前退出时
            // 子进程仍阻塞在 MCP 上，同样先杀掉再 join，避免挂死。
            if early_exit {
                kill_process_tree(child.id());
                let _ = child.wait();
            }
            let _ = stderr_thread.join();
        }

        break;
    }

    let exit_status = child.wait();

    // 标记会话已建立：仅当本 turn 真正到达 result 时才算建过会（此时
    // session_started 已为 true），避免把未建成功的会话误判为续聊。
    if session_started {
        if let Ok(mut s) = started_sessions.lock() {
            s.insert(session_id.clone());
        }
    }

    // 清理 turns（busy 释放）+ 删除本 turn 的临时 settings 文件
    crate::claude_model::remove_settings_override_file(&session_id);
    {
        let mut turns_guard = turns.lock().unwrap_or_else(|e| e.into_inner());
        turns_guard.remove(&session_id);
    }

    if finished_emitted {
        return;
    }

    let was_cancelled = cancelled.load(Ordering::SeqCst);
    let status_line = match &exit_status {
        Ok(status) => status.to_string(),
        Err(e) => e.to_string(),
    };
    let stderr_snippet = {
        let buf = stderr_buf.lock().unwrap_or_else(|e| e.into_inner());
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(500).collect::<String>())
        }
    };
    let message = if was_cancelled {
        "已取消".to_string()
    } else if let Some(snippet) = stderr_snippet {
        format!("Claude 进程异常退出（{status_line}）：{snippet}")
    } else {
        format!("Claude 进程异常退出（{status_line}）")
    };
    let mut e = ChatStreamEvent::new(&session_id, "turn:error");
    e.message = Some(message);
    e.emit(&app);
    log_session(&session_id, &format!(
        "[claude_chat] turn ended session={session_id} cancelled={was_cancelled} status={status_line}"
    ));
}

/// 杀整棵进程树（Windows taskkill /T /F，兜底 child.kill）
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let result = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
        if result.is_err() {
            log_to_file(&format!(
                "[claude_chat] taskkill 失败 pid={pid}，尝试直接 kill"
            ));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
}

/// 解析 ExitPlanMode 的计划内容（从 input、转录 jsonl 或 ~/.claude/plans/*.md 提取并读取）
fn resolve_exit_plan_payload(
    input: &serde_json::Value,
    agent_session_id: &str,
    directory: &str,
) -> serde_json::Value {
    let mut plan_text: Option<String> = None;
    let mut plan_file_path: Option<String> = None;

    // 1. 尝试直接从 input 提取
    if let Some(plan) = input.get("plan").and_then(serde_json::Value::as_str) {
        if !plan.trim().is_empty() {
            plan_text = Some(plan.trim().to_string());
        }
    }
    for key in &["planFilePath", "file_path", "filePath", "path"] {
        if let Some(p) = input.get(*key).and_then(serde_json::Value::as_str) {
            if !p.trim().is_empty() {
                plan_file_path = Some(p.trim().to_string());
                break;
            }
        }
    }

    // 2. 如果没有直接给出完整 plan_text，尝试从转录 jsonl 中寻找 planFilePath / slug / Write tool
    if plan_text.is_none() {
        if let Some(jsonl) = find_claude_jsonl(agent_session_id, directory) {
            if let Ok(file) = std::fs::File::open(&jsonl) {
                let reader = BufReader::new(file);
                for line in reader.lines() {
                    let Ok(line) = line else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };

                    // 2a. attachment / plan_mode
                    if let Some(attachment) = v.get("attachment") {
                        if let Some(p) = attachment.get("planFilePath").and_then(serde_json::Value::as_str) {
                            if !p.trim().is_empty() {
                                plan_file_path = Some(p.trim().to_string());
                            }
                        }
                    }
                    if let Some(slug) = v.get("slug").and_then(serde_json::Value::as_str) {
                        if !slug.trim().is_empty() {
                            if let Some(home) = dirs::home_dir() {
                                let path = home.join(".claude").join("plans").join(format!("{slug}.md"));
                                if path.is_file() {
                                    plan_file_path = Some(path.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                    // 2b. Write tool call
                    if let Some(message) = v.get("message") {
                        if let Some(content) = message.get("content").and_then(serde_json::Value::as_array) {
                            for item in content {
                                if item.get("type").and_then(serde_json::Value::as_str) == Some("tool_use")
                                    && item.get("name").and_then(serde_json::Value::as_str) == Some("Write")
                                {
                                    if let Some(p) = item.pointer("/input/file_path").and_then(serde_json::Value::as_str) {
                                        if p.contains("plans") && p.ends_with(".md") {
                                            plan_file_path = Some(p.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. 如果仍未找到 plan_file_path，扫描 ~/.claude/plans 获取最近修改的 plan 文件
    if plan_file_path.is_none() {
        if let Some(home) = dirs::home_dir() {
            let plans_dir = home.join(".claude").join("plans");
            if let Ok(entries) = std::fs::read_dir(plans_dir) {
                let mut candidates: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
                        if let Ok(meta) = path.metadata() {
                            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                            candidates.push((path, modified));
                        }
                    }
                }
                candidates.sort_by(|a, b| b.1.cmp(&a.1));
                if let Some((newest, _)) = candidates.first() {
                    plan_file_path = Some(newest.to_string_lossy().to_string());
                }
            }
        }
    }

    // 4. 从 plan_file_path 读取真实 markdown 内容
    if let Some(ref path_str) = plan_file_path {
        if let Ok(content) = std::fs::read_to_string(path_str) {
            if !content.trim().is_empty() {
                plan_text = Some(content);
            }
        }
    }

    let plan_file_name = plan_file_path
        .as_ref()
        .map(|p| std::path::Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string());

    serde_json::json!({
        "plan": plan_text,
        "planFilePath": plan_file_path,
        "planFileName": plan_file_name,
        "rawInput": input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_jsonl(content: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("kkcoder-usage-test-{timestamp}.jsonl"));
        std::fs::write(&path, content).expect("write jsonl");
        path
    }

    #[test]
    fn reads_last_and_session_usage_from_assistant_lines() {
        let path = temp_jsonl(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"type":"assistant","session_id":"sid-1","message":{"role":"assistant","content":[],"usage":{"input_tokens":121,"cache_read_input_tokens":1000,"output_tokens":20}}}
{"type":"assistant","session_id":"sid-1","message":{"role":"assistant","content":[],"usage":{"input_tokens":97,"cache_read_input_tokens":2000,"output_tokens":30}}}
"#,
        );
        let usage = read_claude_usage(&path).expect("usage");
        assert_eq!(usage["threadId"], "sid-1");
        // last = 最后一条 assistant
        assert_eq!(usage["last"]["input"], 97);
        assert_eq!(usage["last"]["cached"], 2000);
        assert_eq!(usage["last"]["output"], 30);
        // session = 累加（无 result 行）
        assert_eq!(usage["session"]["input"], 218);
        assert_eq!(usage["session"]["cached"], 3000);
        assert_eq!(usage["session"]["output"], 50);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn result_usage_overrides_accumulated_session_totals() {
        let path = temp_jsonl(
            r#"{"type":"assistant","message":{"role":"assistant","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":500,"output_tokens":10}}}
{"type":"result","session_id":"sid-2","result":"done","usage":{"input_tokens":100,"cache_read_input_tokens":500,"output_tokens":10}}
"#,
        );
        let usage = read_claude_usage(&path).expect("usage");
        assert_eq!(usage["threadId"], "sid-2");
        assert_eq!(usage["last"]["input"], 100);
        assert_eq!(usage["session"]["input"], 100);
        assert_eq!(usage["session"]["cached"], 500);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn returns_none_when_no_usage_in_jsonl() {
        let path = temp_jsonl(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
"#,
        );
        assert!(read_claude_usage(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }
}
