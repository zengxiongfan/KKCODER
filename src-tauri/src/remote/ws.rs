use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use super::state::RemoteServerState;

/// WebSocket 查询参数
#[derive(serde::Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

/// 客户端消息类型
#[derive(serde::Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "replay")]
    Replay { last_seq: u64 },
}

/// WebSocket 会话连接端点（支持 Authorization 头和 ?token= 查询参数）
pub async fn ws_connect(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<RemoteServerState>>,
    req: axum::http::Request<axum::body::Body>,
) -> impl IntoResponse {
    // 从 Authorization 头或 query 参数中提取 token
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

    // 验证 token
    if !state.paired_devices.contains_key(&token) {
        return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
    }

    ws.on_upgrade(move |socket| handle_session(socket, session_id, state, token))
}

/// 处理会话 WebSocket 连接
async fn handle_session(
    socket: WebSocket,
    session_id: String,
    state: Arc<RemoteServerState>,
    token: String,
) {
    let handle = match state.session_registry.get(&session_id) {
        Some(h) => h,
        None => {
            let (mut sender, _) = socket.split();
            let err = serde_json::json!({
                "type": "error",
                "message": "Session not found"
            });
            let _ = sender.send(Message::Text(err.to_string().into())).await;
            return;
        }
    };

    // 更新设备最后活跃时间
    if let Some(mut device) = state.paired_devices.get_mut(&token) {
        device.last_seen = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let mut output_rx = handle.output_tx.subscribe();
    let pty_writer = handle.pty_writer.clone();
    let replay = handle.replay.clone();

    // 用于从 recv_task 向 send_task 发送需要直接推送的消息（如 replay 数据）
    let (relay_tx, mut relay_rx) = mpsc::channel::<String>(64);

    // 任务1: 订阅输出 + relay 消息 → WebSocket 客户端
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // PTY 输出
                frame = output_rx.recv() => {
                    match frame {
                        Ok(frame) => {
                            let msg = serde_json::json!({
                                "type": "pty_output",
                                "seq": frame.seq,
                                "data": frame.data,
                                "timestamp": frame.timestamp
                            });
                            if ws_sender.send(Message::Text(msg.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                // relay 消息（replay 数据等）
                Some(json) = relay_rx.recv() => {
                    if ws_sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 任务2: WebSocket 客户端输入 → PTY
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(msg) = serde_json::from_str::<ClientMessage>(&text) {
                        match msg {
                            ClientMessage::Input { data } => {
                                // 通过共享的 pty_writer 直接写入 PTY
                                if let Some(ref writer) = pty_writer {
                                    if let Ok(mut w) = writer.lock() {
                                        use std::io::Write;
                                        let _ = w.write_all(data.as_bytes());
                                        let _ = w.flush();
                                    }
                                }
                            }
                            ClientMessage::Resize { cols, rows } => {
                                // Resize 需要通过 Tauri 命令处理
                                let _ = (cols, rows);
                            }
                            ClientMessage::Replay { last_seq } => {
                                // 断线重连：补发 last_seq 之后的输出
                                let frames = replay.get_since(last_seq);
                                let count = frames.len();
                                for frame in frames {
                                    let msg = serde_json::json!({
                                        "type": "pty_output",
                                        "seq": frame.seq,
                                        "data": frame.data,
                                        "timestamp": frame.timestamp
                                    });
                                    let _ = relay_tx.send(msg.to_string()).await;
                                }
                                // 发送 replay 完成通知
                                let complete = serde_json::json!({
                                    "type": "replay_complete",
                                    "replayed_count": count
                                });
                                let _ = relay_tx.send(complete.to_string()).await;
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // 任一任务结束即关闭连接
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
