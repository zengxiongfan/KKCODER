use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};

use super::state::RemoteServerState;

/// 对话消息 DTO
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ConversationMessageDTO {
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub seq: u64,
}

/// 单个会话的对话状态
struct ConversationSession {
    jsonl_path: PathBuf,
    file_offset: u64,
    next_seq: u64,
    seen_hashes: HashSet<u64>,
    messages: Vec<ConversationMessageDTO>,
}

/// 全局对话状态管理
pub struct ConversationState {
    sessions: DashMap<String, ConversationSession>,
    /// 用于向 chat WebSocket 客户端广播对话事件
    pub event_txs: DashMap<String, broadcast::Sender<String>>,
}

impl ConversationState {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            event_txs: DashMap::new(),
        }
    }

    /// 注册一个会话的 JSONL 路径（在 spawn_terminal 时调用）
    pub fn register_session(&self, session_id: &str, agent_session_id: &str, project_path: &str) {
        if let Some(jsonl_path) = crate::find_claude_jsonl(agent_session_id, project_path) {
            log_to_file(&format!(
                "ConversationState: registered session {} -> {}",
                session_id,
                jsonl_path.display()
            ));
            self.sessions.insert(
                session_id.to_string(),
                ConversationSession {
                    jsonl_path,
                    file_offset: 0,
                    next_seq: 1,
                    seen_hashes: HashSet::new(),
                    messages: Vec::new(),
                },
            );
        } else {
            log_to_file(&format!(
                "ConversationState: no JSONL found for session {} (agent={}, project={})",
                session_id, agent_session_id, project_path
            ));
        }
    }

    /// 注销会话（PTY 退出时调用）
    pub fn unregister_session(&self, session_id: &str) {
        self.sessions.remove(session_id);
        self.event_txs.remove(session_id);
        log_to_file(&format!(
            "ConversationState: unregistered session {}",
            session_id
        ));
    }

    /// 为 chat WebSocket 客户端创建事件订阅
    pub fn subscribe(&self, session_id: &str) -> broadcast::Receiver<String> {
        let tx = self
            .event_txs
            .entry(session_id.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(64);
                tx
            });
        tx.subscribe()
    }

    /// 加载完整对话快照（首次连接时调用）
    pub fn load_snapshot(&self, session_id: &str) -> Vec<ConversationMessageDTO> {
        log_to_file(&format!("load_snapshot: called for session {}, registered sessions: {:?}", session_id, self.sessions.iter().map(|r| r.key().clone()).collect::<Vec<_>>()));
        let mut session = match self.sessions.get_mut(session_id) {
            Some(s) => s,
            None => {
                log_to_file(&format!("load_snapshot: session {} not found in ConversationState", session_id));
                return vec![];
            }
        };

        log_to_file(&format!("load_snapshot: reading JSONL from {}", session.jsonl_path.display()));

        // 读取完整 JSONL
        let raw_messages = crate::read_claude_transcript(&session.jsonl_path);
        session.messages.clear();
        session.seen_hashes.clear();

        let mut seq: u64 = 1;
        for (role, text) in &raw_messages {
            let hash = content_hash(role, text);
            if session.seen_hashes.contains(&hash) {
                continue;
            }
            session.seen_hashes.insert(hash);
            session.messages.push(ConversationMessageDTO {
                id: format!("{:016x}", hash),
                role: role.clone(),
                text: text.clone(),
                created_at: String::new(),
                seq,
            });
            seq += 1;
        }
        session.next_seq = seq;

        // 更新 file_offset 为当前文件大小（后续增量读取从这里开始）
        if let Ok(metadata) = std::fs::metadata(&session.jsonl_path) {
            session.file_offset = metadata.len();
        }

        session.messages.clone()
    }

    /// 增量读取 JSONL 新增内容，返回新消息
    pub fn tail_new_messages(&self, session_id: &str) -> Vec<ConversationMessageDTO> {
        let mut session = match self.sessions.get_mut(session_id) {
            Some(s) => s,
            None => return vec![],
        };

        let metadata = match std::fs::metadata(&session.jsonl_path) {
            Ok(m) => m,
            Err(_) => return vec![],
        };

        if metadata.len() <= session.file_offset {
            return vec![];
        }

        // 增量读取：从 file_offset 开始读取新行
        let new_messages = read_jsonl_since(&session.jsonl_path, session.file_offset);
        let mut added = Vec::new();

        for (role, text) in new_messages {
            let hash = content_hash(&role, &text);
            if session.seen_hashes.contains(&hash) {
                continue;
            }
            session.seen_hashes.insert(hash);
            let msg = ConversationMessageDTO {
                id: format!("{:016x}", hash),
                role,
                text,
                created_at: String::new(),
                seq: session.next_seq,
            };
            session.next_seq += 1;
            session.messages.push(msg.clone());
            added.push(msg);
        }

        // 更新 offset
        session.file_offset = metadata.len();
        added
    }
}

/// 从指定偏移量读取 JSONL 文件中的新 user/assistant 消息
fn read_jsonl_since(path: &std::path::Path, offset: u64) -> Vec<(String, String)> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(offset)).is_err() {
        return vec![];
    }

    let mut msgs = Vec::new();
    let mut last_user = String::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if !line.contains("\"user\"")
            && !line.contains("\"assistant\"")
            && !line.contains("\"last-prompt\"")
        {
            continue;
        }
        let obj: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ == "last-prompt" {
            let prompt = obj
                .get("lastPrompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !prompt.is_empty() && prompt != last_user {
                msgs.push(("user".into(), prompt.clone()));
                last_user = prompt;
            }
        } else if typ == "user" {
            let text = crate::extract_message_content(&obj);
            if !text.trim().is_empty() && text != last_user {
                msgs.push(("user".into(), text.clone()));
                last_user = text;
            }
        } else if typ == "assistant" {
            let text = crate::extract_assistant_text(&obj);
            if !text.trim().is_empty() {
                msgs.push(("assistant".into(), text));
            }
        }
    }
    msgs
}

/// 内容 hash 用于去重
fn content_hash(role: &str, text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    role.hash(&mut hasher);
    text.hash(&mut hasher);
    hasher.finish()
}

// ==================== HTTP Handlers ====================

/// GET /api/sessions/{id}/messages — 返回历史对话快照
pub async fn get_messages(
    Path(session_id): Path<String>,
    State(state): State<Arc<RemoteServerState>>,
) -> Result<axum::Json<Vec<ConversationMessageDTO>>, (StatusCode, String)> {
    let conversation = match &state.conversation {
        Some(c) => c.clone(),
        None => return Err((StatusCode::SERVICE_UNAVAILABLE, "Conversation not available".into())),
    };

    let messages = tokio::task::spawn_blocking(move || conversation.load_snapshot(&session_id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(axum::Json(messages))
}

/// WebSocket 查询参数
#[derive(serde::Deserialize)]
pub struct ChatWsQuery {
    pub token: Option<String>,
}

/// GET /api/sessions/{id}/chat-ws — 对话模式 WebSocket
pub async fn chat_ws_handler(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<ChatWsQuery>,
    State(state): State<Arc<RemoteServerState>>,
    req: axum::http::Request<axum::body::Body>,
) -> impl IntoResponse {
    // 认证：复用与 ws.rs 相同的逻辑
    let token = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| query.token.clone());

    let token = match token {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                "Missing token (use Authorization header or ?token= query param)",
            )
                .into_response();
        }
    };

    if !state.paired_devices.contains_key(&token) {
        return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
    }

    ws.on_upgrade(move |socket| handle_chat_session(socket, session_id, state, token))
}

/// 处理 chat WebSocket 会话
async fn handle_chat_session(
    socket: WebSocket,
    session_id: String,
    state: Arc<RemoteServerState>,
    token: String,
) {
    log_to_file(&format!("chat_ws: new connection for session {}", session_id));

    // 获取 session handle（用于 submit_prompt 写入 PTY）
    let handle = match state.session_registry.get(&session_id) {
        Some(h) => h,
        None => {
            log_to_file(&format!("chat_ws: session {} not found in registry", session_id));
            let (mut sender, _) = socket.split();
            let err = serde_json::json!({"type": "error", "message": "Session not found"});
            let _ = sender.send(Message::Text(err.to_string().into())).await;
            return;
        }
    };

    let conversation = match &state.conversation {
        Some(c) => c.clone(),
        None => {
            log_to_file("chat_ws: ConversationState not available");
            let (mut sender, _) = socket.split();
            let err = serde_json::json!({"type": "error", "message": "Conversation not available"});
            let _ = sender.send(Message::Text(err.to_string().into())).await;
            return;
        }
    };

    // 如果会话未注册，尝试动态注册（兼容启动前就存在的会话）
    if !conversation.sessions.contains_key(&session_id) {
        log_to_file(&format!("chat_ws: session {} not registered, attempting dynamic registration", session_id));
        let agent_session_id = handle.agent_session_id.clone();
        let project_path = handle.project_path.clone();
        conversation.register_session(&session_id, &agent_session_id, &project_path);
    }

    log_to_file(&format!("chat_ws: session {} found, registered sessions count: {}", session_id, conversation.sessions.len()));

    // 更新设备最后活跃时间
    if let Some(mut device) = state.paired_devices.get_mut(&token) {
        device.last_seen = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let mut event_rx = conversation.subscribe(&session_id);

    // 用于从 recv_task 向 send_task 发送 replay 数据
    let (relay_tx, mut relay_rx) = mpsc::channel::<String>(64);

    // 任务1: 推送对话事件 → WebSocket 客户端
    let conversation_for_send = conversation.clone();
    let session_id_for_send = session_id.clone();
    let send_task = tokio::spawn(async move {
        // 先发送初始快照
        let snapshot = {
            let conv = conversation_for_send.clone();
            let sid = session_id_for_send.clone();
            tokio::task::spawn_blocking(move || {
                log_to_file(&format!("chat_ws: loading snapshot for session {}", sid));
                let snap = conv.load_snapshot(&sid);
                log_to_file(&format!("chat_ws: snapshot loaded, {} messages", snap.len()));
                snap
            })
                .await
                .unwrap_or_default()
        };
        let last_seq = snapshot.last().map(|m| m.seq).unwrap_or(0);
        log_to_file(&format!("chat_ws: sending snapshot with {} messages, last_seq={}", snapshot.len(), last_seq));
        let snap_msg = serde_json::json!({
            "type": "conversation_snapshot",
            "messages": snapshot,
            "last_seq": last_seq
        });
        if ws_sender
            .send(Message::Text(snap_msg.to_string().into()))
            .await
            .is_err()
        {
            log_to_file("chat_ws: failed to send snapshot");
            return;
        }
        log_to_file("chat_ws: snapshot sent successfully");

        // 然后监听对话事件和 relay 消息
        loop {
            tokio::select! {
                event = event_rx.recv() => {
                    match event {
                        Ok(json) => {
                            if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                Some(json) = relay_rx.recv() => {
                    if ws_sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 任务2: 处理客户端输入
    let pty_writer = handle.pty_writer.clone();
    let conversation_for_recv = conversation.clone();
    let session_id_for_recv = session_id.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) {
                        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match msg_type {
                            "submit_prompt" => {
                                // 用户输入：写入 PTY
                                if let Some(prompt_text) =
                                    msg.get("text").and_then(|v| v.as_str())
                                {
                                    // 广播 thinking 状态
                                    if let Some(tx) = conversation_for_recv.event_txs.get(&session_id_for_recv) {
                                        let status_msg = serde_json::json!({"type": "run_status", "status": "thinking"});
                                        let _ = tx.send(status_msg.to_string());
                                    }

                                    if let Some(ref writer) = pty_writer {
                                        if let Ok(mut w) = writer.lock() {
                                            use std::io::Write;
                                            let _ = w.write_all(prompt_text.as_bytes());
                                            let _ = w.write_all(b"\r");
                                            let _ = w.flush();
                                        }
                                    }
                                }
                            }
                            "replay" => {
                                // 断线重连：重新发送快照
                                let conv = conversation_for_recv.clone();
                                let sid = session_id_for_recv.clone();
                                let messages =
                                    tokio::task::spawn_blocking(move || conv.load_snapshot(&sid))
                                        .await
                                        .unwrap_or_default();
                                let last_seq = messages.last().map(|m| m.seq).unwrap_or(0);
                                let snap = serde_json::json!({
                                    "type": "conversation_snapshot",
                                    "messages": messages,
                                    "last_seq": last_seq
                                });
                                let _ = relay_tx.send(snap.to_string()).await;
                            }
                            _ => {}
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

/// 后台任务：定期检查 JSONL 文件变更，广播新消息
pub async fn run_jsonl_watcher(
    conversation: Arc<ConversationState>,
    session_registry: Arc<super::state::SessionRegistry>,
) {
    log_to_file("[JSONL Watcher] Started");
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // 遍历所有已注册的会话
        let session_ids: Vec<String> = {
            conversation
                .sessions
                .iter()
                .map(|r| r.key().clone())
                .collect()
        };

        // 动态注册：检查 session_registry 中是否有未注册的会话
        for handle_entry in session_registry.sessions_iter() {
            let (sid, handle) = handle_entry;
            if !conversation.sessions.contains_key(&sid) {
                log_to_file(&format!("[JSONL Watcher] Auto-registering session {}", sid));
                conversation.register_session(&sid, &handle.agent_session_id, &handle.project_path);
            }
        }

        for session_id in session_ids {
            let added = conversation.tail_new_messages(&session_id);
            if added.is_empty() {
                continue;
            }

            log_to_file(&format!("[JSONL Watcher] Session {} has {} new messages", session_id, added.len()));

            // 广播新消息
            if let Some(tx) = conversation.event_txs.get(&session_id) {
                // 先发送 run_status: idle（因为有新 assistant 消息说明 Claude 已回复）
                let has_assistant = added.iter().any(|m| m.role == "assistant");
                if has_assistant {
                    log_to_file(&format!("[JSONL Watcher] Sending run_status: idle for session {}", session_id));
                    let status_msg = serde_json::json!({"type": "run_status", "status": "idle"});
                    let _ = tx.send(status_msg.to_string());
                }

                for msg in added {
                    let event = serde_json::json!({
                        "type": "message_added",
                        "seq": msg.seq,
                        "id": msg.id,
                        "role": msg.role,
                        "text": msg.text,
                        "created_at": msg.created_at
                    });
                    let _ = tx.send(event.to_string());
                }
            }
        }
    }
}

fn log_to_file(message: &str) {
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open("kkcoder_debug.log")
    {
        let now = std::time::SystemTime::now();
        let since = now
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let _ = writeln!(file, "[Timestamp: {}ms] {}", since.as_millis(), message);
    }
}
