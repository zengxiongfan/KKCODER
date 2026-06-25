use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

use super::conversation;
use super::handlers;
use super::state::RemoteServerState;
use super::ws;

/// 构建 axum 路由
pub fn build_router(state: Arc<RemoteServerState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // 设备配对（无需认证）
        .route("/api/pair/init", post(handlers::init_pairing))
        .route("/api/pair/verify", post(handlers::verify_pairing))
        // 会话管理（需要认证）
        .route("/api/sessions", get(handlers::list_sessions).post(handlers::create_session))
        .route("/api/sessions/{id}/spawn", post(handlers::spawn_session))
        // WebSocket 会话连接（需要认证）
        .route("/api/sessions/{id}/ws", get(ws::ws_connect))
        // 对话模式：REST 获取历史消息 + WebSocket 推送对话事件（需要认证）
        .route(
            "/api/sessions/{id}/messages",
            get(conversation::get_messages),
        )
        .route(
            "/api/sessions/{id}/chat-ws",
            get(conversation::chat_ws_handler),
        )
        // 桌面端轮询 spawn 请求（无需认证，仅本机访问）
        .route("/api/spawn-requests", get(handlers::poll_spawn_requests))
        // 服务器状态
        .route("/api/status", get(handlers::server_status))
        // 设备管理（需要认证）
        .route("/api/devices", get(handlers::list_devices))
        .route("/api/devices/{id}", delete(handlers::revoke_device))
        .with_state(state)
        .layer(cors)
}

/// 启动远程服务器
pub async fn start_remote_server(state: Arc<RemoteServerState>) -> Result<(), String> {
    let (port, listen_mode) = {
        let config = state.config.lock().await;
        if !config.enabled {
            return Ok(());
        }
        (config.port, config.listen_mode.clone())
    };

    let bind_host = if listen_mode == "localhost" {
        "127.0.0.1"
    } else {
        "0.0.0.0"
    };
    let addr = format!("{}:{}", bind_host, port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind to {}: {}", addr, e))?;

    log_to_file(&format!(
        "Remote server listening on {}",
        listener.local_addr().map_err(|e| e.to_string())?
    ));

    let app = build_router(state);

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("Server error: {}", e))
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
