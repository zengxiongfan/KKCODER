use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

use super::auth::AuthToken;
use super::state::RemoteServerState;

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

/// 会话 DTO（匹配手机端 Session 模型）
#[derive(serde::Serialize)]
pub struct SessionDTO {
    pub id: String,
    pub name: String,
    pub project: String,
    pub path: String,
    #[serde(rename = "type")]
    pub session_type: String,
    #[serde(rename = "agentSessionId")]
    pub agent_session_id: String,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "lastUserMessageAt", skip_serializing_if = "Option::is_none")]
    pub last_user_message_at: Option<String>,
    /// 是否在桌面端运行中
    pub active: bool,
    /// 运行状态: "thinking" | "idle"
    #[serde(rename = "runStatus")]
    pub run_status: String,
}

/// 服务器状态 DTO
#[derive(serde::Serialize)]
pub struct ServerStatusDTO {
    pub running: bool,
    pub port: u16,
    pub active_sessions: usize,
    pub paired_devices: usize,
}

/// 设备 DTO
#[derive(serde::Serialize)]
pub struct DeviceDTO {
    pub device_id: String,
    pub device_name: String,
    pub paired_at: String,
    pub last_seen: String,
}

/// 配对初始化响应
#[derive(serde::Serialize)]
pub struct PairInitResponse {
    pub pin: String,
    pub expires_in: u64,
}

/// 配对验证请求（兼容 camelCase 和 snake_case）
#[derive(serde::Deserialize)]
pub struct PairVerifyRequest {
    pub pin: String,
    #[serde(alias = "deviceName")]
    pub device_name: String,
}

/// 配对验证响应
#[derive(serde::Serialize)]
pub struct PairVerifyResponse {
    pub token: String,
    pub device_id: String,
}

/// GET /api/sessions - 获取会话列表（从 SQLite 读取非删除会话，标记是否运行中）
pub async fn list_sessions(
    State(state): State<Arc<RemoteServerState>>,
    AuthToken(_): AuthToken,
) -> Result<Json<Vec<SessionDTO>>, (StatusCode, String)> {
    let db_path = state.db_path.clone();
    let registry = state.session_registry.clone();
    let conversation = state.conversation.clone();
    let sessions = tokio::task::spawn_blocking(move || -> Result<Vec<SessionDTO>, String> {
        let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, project, path, type, agent_session_id, created_at, last_user_message_at \
                 FROM sessions WHERE deleted = 0 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let active = registry.get(&id).is_some();
                let run_status = if active {
                    conversation
                        .as_ref()
                        .map(|c| c.get_run_status(&id))
                        .unwrap_or_else(|| "idle".to_string())
                } else {
                    "idle".to_string()
                };
                Ok(SessionDTO {
                    id,
                    name: row.get(1)?,
                    project: row.get(2)?,
                    path: row.get(3)?,
                    session_type: row.get(4)?,
                    agent_session_id: row.get(5)?,
                    created_at: row.get(6)?,
                    last_user_message_at: row.get(7)?,
                    active,
                    run_status,
                })
            })
            .map_err(|e| e.to_string())?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(sessions))
}

/// GET /api/status - 服务器状态
pub async fn server_status(
    State(state): State<Arc<RemoteServerState>>,
) -> Json<ServerStatusDTO> {
    let config = state.config.lock().await;
    Json(ServerStatusDTO {
        running: true,
        port: config.port,
        active_sessions: state.session_registry.len(),
        paired_devices: state.paired_devices.len(),
    })
}

/// GET /api/devices - 获取已配对设备列表
pub async fn list_devices(
    State(state): State<Arc<RemoteServerState>>,
    AuthToken(_): AuthToken,
) -> Json<Vec<DeviceDTO>> {
    let devices: Vec<DeviceDTO> = state
        .paired_devices
        .iter()
        .map(|r| DeviceDTO {
            device_id: r.device_id.clone(),
            device_name: r.device_name.clone(),
            paired_at: r.paired_at.clone(),
            last_seen: r.last_seen.clone(),
        })
        .collect();
    Json(devices)
}

/// DELETE /api/devices/:id - 吊销设备
pub async fn revoke_device(
    State(state): State<Arc<RemoteServerState>>,
    axum::extract::Path(device_id): axum::extract::Path<String>,
    AuthToken(_): AuthToken,
) -> Result<StatusCode, (StatusCode, String)> {
    // 从内存缓存中移除（key 是 token，需要按 device_id 查找）
    let token_to_remove: Option<String> = state
        .paired_devices
        .iter()
        .find(|r| r.device_id == device_id)
        .map(|r| r.key().clone());
    let removed = token_to_remove
        .and_then(|token| state.paired_devices.remove(&token));
    if removed.is_some() {
        // 同步删除数据库记录
        let db_path = state.db_path.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let _ = conn.execute(
                    "DELETE FROM paired_devices WHERE device_id = ?1",
                    [&device_id],
                );
            }
        });
        Ok(StatusCode::OK)
    } else {
        Err((StatusCode::NOT_FOUND, "Device not found".to_string()))
    }
}

/// POST /api/pair/init - 初始化配对（生成 PIN）
pub async fn init_pairing(
    State(state): State<Arc<RemoteServerState>>,
) -> Result<Json<PairInitResponse>, (StatusCode, String)> {
    let pin = super::auth::generate_pin();
    let expiry = super::auth::pin_expiry();

    {
        let mut config = state.config.lock().await;
        config.pairing_pin = Some(pin.clone());
        config.pin_expires_at = Some(expiry);
    }

    Ok(Json(PairInitResponse {
        pin,
        expires_in: 300,
    }))
}

/// POST /api/pair/verify - 验证 PIN，返回 token (v2 - with JSON errors)
pub async fn verify_pairing(
    State(state): State<Arc<RemoteServerState>>,
    Json(req): Json<PairVerifyRequest>,
) -> Result<Json<PairVerifyResponse>, (StatusCode, Json<serde_json::Value>)> {
    log_to_file("[verify_pairing] v2 handler called!");
    // 从数据库读取 PIN（Tauri 命令写入的位置）
    let (pin_value, pin_expires_at) = {
        let db_path = state.db_path.clone();
        tokio::task::spawn_blocking(move || -> Result<(Option<String>, Option<std::time::SystemTime>), String> {
            let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

            // 列出所有 remote_config 用于调试
            if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM remote_config") {
                if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
                    for row in rows.flatten() {
                        log_to_file(&format!("[verify_pairing] remote_config: {} = {}", row.0, row.1));
                    }
                }
            }

            let pin: Option<String> = conn.query_row(
                "SELECT value FROM remote_config WHERE key = 'pairing_pin'",
                [],
                |row| row.get(0),
            ).ok();
            let expires_str: Option<String> = conn.query_row(
                "SELECT value FROM remote_config WHERE key = 'pin_expires_at'",
                [],
                |row| row.get(0),
            ).ok();
            let expires_at = expires_str.and_then(|s| {
                let millis: u64 = s.parse().ok()?;
                std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_millis(millis))
            });
            log_to_file(&format!("[verify_pairing] db_path={}, pin_found={}, pin_value={:?}, expires_at={:?}, input_pin={}",
                db_path.display(), pin.is_some(), pin, expires_at, "hidden"));
            Ok((pin, expires_at))
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?
    };

    let pin_value = pin_value.ok_or((
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": "No active pairing session. Please generate a PIN on the desktop first."})),
    ))?;

    if !super::auth::verify_pin(&req.pin, &pin_value, pin_expires_at) {
        log_to_file(&format!("[verify_pairing] PIN mismatch: input='{}', stored='{}'", req.pin, pin_value));
        return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid or expired PIN"}))));
    }

    let token = super::auth::generate_token();
    let device_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    // 存入内存缓存
    state.paired_devices.insert(
        token.clone(),
        super::state::DeviceInfo {
            device_id: device_id.clone(),
            device_name: req.device_name.clone(),
            paired_at: now.clone(),
            last_seen: now.clone(),
        },
    );

    // 清除 PIN（一次性使用）
    {
        let mut config = state.config.lock().await;
        config.pairing_pin = None;
        config.pin_expires_at = None;
    }

    // 持久化到数据库
    let db_path = state.db_path.clone();
    let token_clone = token.clone();
    let device_id_clone = device_id.clone();
    let device_name = req.device_name.clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO paired_devices (device_id, device_name, token, paired_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![device_id_clone, device_name, token_clone, now, now],
            );
        }
    });

    Ok(Json(PairVerifyResponse {
        token,
        device_id,
    }))
}

/// 创建会话请求
#[derive(serde::Deserialize)]
pub struct CreateSessionRequest {
    pub id: String,
    pub name: Option<String>,
    pub project: String,
    pub path: String,
    #[serde(rename = "type", alias = "sessionType")]
    pub session_type: Option<String>,
    #[serde(rename = "agentSessionId", alias = "agent_session_id")]
    pub agent_session_id: Option<String>,
}

/// POST /api/sessions - 创建新会话
pub async fn create_session(
    State(state): State<Arc<RemoteServerState>>,
    AuthToken(_): AuthToken,
    Json(req): Json<CreateSessionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let db_path = state.db_path.clone();
    let session_id = req.id.clone();
    let name = req.name.unwrap_or_else(|| "新会话".to_string());
    let session_type = req.session_type.unwrap_or_else(|| "claude".to_string());
    let agent_session_id = req.agent_session_id.unwrap_or_default();

    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, name, project, path, type, agent_session_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)",
            rusqlite::params![session_id, name, req.project, req.path, session_type, agent_session_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO recent_projects (path, name, last_used_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
            rusqlite::params![req.path, req.project],
        )
        .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(StatusCode::CREATED)
}

/// POST /api/sessions/:id/spawn - 请求桌面端启动会话
pub async fn spawn_session(
    State(state): State<Arc<RemoteServerState>>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    AuthToken(_): AuthToken,
    Json(req): Json<serde_json::Value>,
) -> Result<StatusCode, (StatusCode, String)> {
    // 如果会话已在运行，直接返回
    if state.session_registry.get(&session_id).is_some() {
        return Ok(StatusCode::OK);
    }

    // 从数据库读取会话信息
    let db_path = state.db_path.clone();
    let session_id_clone = session_id.clone();
    let session_info = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT path, type, agent_session_id FROM sessions WHERE id = ?1 AND deleted = 0",
            [&session_id_clone],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, // path
                    row.get::<_, String>(1)?, // type
                    row.get::<_, String>(2)?, // agent_session_id
                ))
            },
        )
        .map_err(|e| format!("Session not found: {}", e))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::NOT_FOUND, e))?;

    // 加入 spawn 队列
    let spawn_req = super::state::SpawnRequest {
        session_id: session_id.clone(),
        directory: session_info.0,
        agent_type: session_info.1,
        agent_session_id: session_info.2,
        is_reopen: req.get("is_reopen").and_then(|v| v.as_bool()).unwrap_or(true),
    };

    state.spawn_requests.lock().await.push(spawn_req);
    Ok(StatusCode::ACCEPTED)
}

/// GET /api/spawn-requests - 桌面端轮询获取待执行的 spawn 请求
pub async fn poll_spawn_requests(
    State(state): State<Arc<RemoteServerState>>,
) -> Json<Vec<super::state::SpawnRequest>> {
    let mut requests = state.spawn_requests.lock().await;
    let result = requests.clone();
    requests.clear();
    Json(result)
}
