// KKCoder Tauri 后端核心代码 - SQLite 数据库持久化及 PTY 虚拟终端控制
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{State, AppHandle, Emitter};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty};
use std::io::Write;

mod remote;

// 极其可靠的本地调试文件日志输出器，自动写入 kkcoder_debug.log 以便于闪退后追溯
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
        let since_the_epoch = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let _ = writeln!(file, "[Timestamp: {}ms] {}", since_the_epoch.as_millis(), message);
    }
}

pub struct ActiveSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    spawn_token: u64,
}

pub struct PtyManager {
    pub sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    pub session_registry: Option<Arc<remote::state::SessionRegistry>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_registry: None,
        }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Session {
    id: String,
    name: String,
    project: String,
    path: String,
    #[serde(rename = "type")]
    session_type: String, // "claude" or "pi"
    #[serde(rename = "agentSessionId")]
    agent_session_id: String,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(rename = "lastUserMessageAt", skip_serializing_if = "Option::is_none")]
    last_user_message_at: Option<String>,
    #[serde(default)]
    favorite: i32, // 0 for normal, 1 for favorite
    #[serde(default)]
    deleted: i32, // 0 for active, 1 for in trash
    #[serde(rename = "deletedAt", skip_serializing_if = "Option::is_none")]
    deleted_at: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RecentProject {
    name: String,
    path: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ArchivedProject {
    id: i32,
    project_name: String,
    project_path: String,
    archived_at: String,
    archive_month: String,
    sessions_data: String,
}

#[derive(Clone, serde::Serialize)]
struct PtyOutputPayload {
    session_id: String,
    data: String,
}

// 获取本地 SQLite 数据库路径 (工作区 kkcoder.db)
fn get_db_path() -> std::path::PathBuf {
    let mut path = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    path.push("kkcoder.db");
    path
}

// 获取特定会话的缓存备份目录 (放置于系统临时目录，避免触发 Tauri 开发模式下的热重载)
fn get_shadows_dir(session_id: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push("kkcoder_shadows");
    path.push(session_id);
    path
}


// 初始化本地 SQLite 数据库表结构
fn initialize_database() -> Result<(), rusqlite::Error> {
    let db_path = get_db_path();
    log_to_file(&format!("initialize_database called. DB Path: {:?}", db_path));
    let conn = rusqlite::Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            project TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            agent_session_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_user_message_at DATETIME,
            favorite INTEGER DEFAULT 0
        )",
        [],
    )?;

    // 动态平滑迁移：尝试添加 favorite, deleted, deleted_at 字段。忽略错误（若字段已存在）
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN favorite INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN deleted INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN deleted_at DATETIME", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_user_message_at DATETIME", []);
    let _ = conn.execute(
        "UPDATE sessions SET last_user_message_at = created_at WHERE last_user_message_at IS NULL",
        [],
    );

    // 物理清理超过 7 天的已删除会话 (基于本地时间计算或直接按 UTC)
    let _ = conn.execute(
        "DELETE FROM sessions WHERE deleted = 1 AND datetime(deleted_at) < datetime('now', '-7 days')",
        [],
    );

    conn.execute(
        "CREATE TABLE IF NOT EXISTS recent_projects (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // 创建归档项目表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS archived_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT NOT NULL,
            project_path TEXT NOT NULL,
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            archive_month TEXT NOT NULL,
            sessions_data TEXT DEFAULT '[]'
        )",
        [],
    )?;

    // 兼容旧表：如果 sessions_data 列不存在则自动添加
    let _ = conn.execute(
        "ALTER TABLE archived_projects ADD COLUMN sessions_data TEXT DEFAULT '[]'",
        [],
    );

    // 远程访问：已配对设备表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS paired_devices (
            device_id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            paired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // 远程访问：配置表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS remote_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    log_to_file("initialize_database completed successfully.");
    Ok(())
}

// ==================== SQLite 数据库 Tauri Commands ====================

// 1. 获取所有持久化保存的终端会话
#[tauri::command]
fn get_sessions() -> Result<Vec<Session>, String> {
    log_to_file("get_sessions command called.");
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| {
        log_to_file(&format!("get_sessions DB open error: {}", e));
        e.to_string()
    })?;
    let mut stmt = conn.prepare("SELECT id, name, project, path, type, agent_session_id, created_at, last_user_message_at, favorite, deleted, deleted_at FROM sessions ORDER BY created_at ASC")
        .map_err(|e| {
            log_to_file(&format!("get_sessions prepare stmt error: {}", e));
            e.to_string()
        })?;
    
    let rows = stmt.query_map([], |row| {
        Ok(Session {
            id: row.get(0)?,
            name: row.get(1)?,
            project: row.get(2)?,
            path: row.get(3)?,
            session_type: row.get(4)?,
            agent_session_id: row.get(5)?,
            created_at: row.get(6)?,
            last_user_message_at: row.get(7)?,
            favorite: row.get(8)?,
            deleted: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    }).map_err(|e| {
        log_to_file(&format!("get_sessions query map error: {}", e));
        e.to_string()
    })?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok(sess) = row {
            result.push(sess);
        }
    }
    log_to_file(&format!("get_sessions finished. Found {} sessions.", result.len()));
    Ok(result)
}

// 2. 插入或修改会话，并同步登记项目路径到最近使用列表中
#[tauri::command]
fn add_session(session: Session) -> Result<(), String> {
    log_to_file(&format!("add_session command called: id={}, name={}, project={}, path={}, type={}, agent_session_id={}, favorite={}", 
        session.id, session.name, session.project, session.path, session.session_type, session.agent_session_id, session.favorite));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| {
        log_to_file(&format!("add_session DB open error: {}", e));
        e.to_string()
    })?;
    
    log_to_file("add_session execute UPSERT into sessions...");
    conn.execute(
        "INSERT INTO sessions (
            id, name, project, path, type, agent_session_id, created_at, last_user_message_at, favorite, deleted, deleted_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, CURRENT_TIMESTAMP), ?8, ?9, ?10, ?11
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            project = excluded.project,
            path = excluded.path,
            type = excluded.type,
            agent_session_id = excluded.agent_session_id,
            created_at = COALESCE(excluded.created_at, sessions.created_at),
            last_user_message_at = COALESCE(excluded.last_user_message_at, sessions.last_user_message_at),
            favorite = excluded.favorite,
            deleted = excluded.deleted,
            deleted_at = excluded.deleted_at",
        rusqlite::params![
            &session.id,
            &session.name,
            &session.project,
            &session.path,
            &session.session_type,
            &session.agent_session_id,
            session.created_at,
            session.last_user_message_at,
            session.favorite,
            session.deleted,
            session.deleted_at,
        ],
    ).map_err(|e| {
        log_to_file(&format!("add_session execute sessions row error: {}", e));
        e.to_string()
    })?;
    log_to_file("add_session sessions row written.");
    
    log_to_file("add_session execute INSERT OR REPLACE into recent_projects...");
    // 更新最近项目使用列表
    conn.execute(
        "INSERT OR REPLACE INTO recent_projects (path, name, last_used_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
        [&session.path, &session.project],
    ).map_err(|e| {
        log_to_file(&format!("add_session execute recent_projects row error: {}", e));
        e.to_string()
    })?;
    log_to_file("add_session recent_projects row written.");

    log_to_file("add_session completed successfully.");
    Ok(())
}

// 3. 删除本地持久化的会话 (软删除，移入回收站)
#[tauri::command]
fn delete_session(id: String) -> Result<(), String> {
    log_to_file(&format!("delete_session (soft delete) command called: id={}", id));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE sessions SET deleted = 1, deleted_at = datetime('now', 'localtime') WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 3a. 彻底删除本地持久化的会话 (物理删除)
#[tauri::command]
fn delete_session_permanently(id: String) -> Result<(), String> {
    log_to_file(&format!("delete_session_permanently command called: id={}", id));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    
    // 清理对应的 shadow 文件夹
    let shadows_dir = get_shadows_dir(&id);
    if shadows_dir.exists() {
        let _ = std::fs::remove_dir_all(&shadows_dir);
    }
    Ok(())
}

// 3b. 恢复从回收站中的会话
#[tauri::command]
fn restore_session(id: String) -> Result<(), String> {
    log_to_file(&format!("restore_session command called: id={}", id));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE sessions SET deleted = 0, deleted_at = NULL WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 3c. 清空回收站
#[tauri::command]
fn empty_trash() -> Result<(), String> {
    log_to_file("empty_trash command called.");
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    // 获取所有待删除会话的 ID 并清理对应的 shadow 文件夹
    if let Ok(mut stmt) = conn.prepare("SELECT id FROM sessions WHERE deleted = 1") {
        if let Ok(deleted_ids) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for id_res in deleted_ids {
                if let Ok(id) = id_res {
                    let shadows_dir = get_shadows_dir(&id);
                    if shadows_dir.exists() {
                        let _ = std::fs::remove_dir_all(&shadows_dir);
                    }
                }
            }
        }
    }

    conn.execute("DELETE FROM sessions WHERE deleted = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cleanup_stale_sessions(days: i64) -> Result<usize, String> {
    let safe_days = days.clamp(1, 3650);
    log_to_file(&format!("cleanup_stale_sessions called: days={}", safe_days));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let modifier = format!("-{} days", safe_days);
    let affected = conn
        .execute(
            "UPDATE sessions
             SET deleted = 1, deleted_at = datetime('now', 'localtime')
             WHERE deleted = 0
               AND datetime(COALESCE(last_user_message_at, created_at)) < datetime('now', ?1)",
            [&modifier],
        )
        .map_err(|e| e.to_string())?;
    log_to_file(&format!("cleanup_stale_sessions completed. affected={}", affected));
    Ok(affected)
}

/// 启动时清理空白会话：名为"新会话"且无实际对话内容的会话自动移入垃圾桶
#[tauri::command]
fn cleanup_empty_sessions() -> Result<usize, String> {
    log_to_file("cleanup_empty_sessions called.");
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, type, agent_session_id, path, created_at, last_user_message_at FROM sessions WHERE deleted = 0 AND name = '新会话'")
        .map_err(|e| e.to_string())?;

    let candidates: Vec<(String, String, String, String, Option<String>, Option<String>)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,         // id
                row.get::<_, String>(1)?,         // type
                row.get::<_, String>(2)?,         // agent_session_id
                row.get::<_, String>(3)?,         // path
                row.get::<_, Option<String>>(4)?, // created_at
                row.get::<_, Option<String>>(5)?, // last_user_message_at
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    log_to_file(&format!("cleanup_empty_sessions: found {} candidates named '新会话'", candidates.len()));

    let mut cleaned = 0usize;
    for (session_id, session_type, agent_session_id, project_path, created_at, last_user_msg_at) in &candidates {
        let is_empty = if session_type == "claude" {
            match find_claude_jsonl(agent_session_id, project_path) {
                Some(jsonl_path) => {
                    // JSONL 存在，检查是否有用户消息
                    let transcript = read_claude_transcript(&jsonl_path);
                    transcript.is_empty()
                }
                None => {
                    // JSONL 不存在，且数据库中没有对话记录
                    last_user_msg_at.is_none() || last_user_msg_at == created_at
                }
            }
        } else {
            // 其他类型（如 Pi）：直接根据数据库时间戳判断是否从未有过对话
            last_user_msg_at.is_none() || last_user_msg_at == created_at
        };

        if is_empty {
            if let Err(e) = conn.execute(
                "UPDATE sessions SET deleted = 1, deleted_at = datetime('now', 'localtime') WHERE id = ?1",
                [&session_id],
            ) {
                log_to_file(&format!("cleanup_empty_sessions: failed to delete {}: {}", session_id, e));
            } else {
                log_to_file(&format!("cleanup_empty_sessions: removed empty session {}", session_id));
                cleaned += 1;
            }
        }
    }

    log_to_file(&format!("cleanup_empty_sessions completed. removed={}", cleaned));
    Ok(cleaned)
}

#[derive(serde::Serialize)]
struct ContentSearchResult {
    #[serde(rename = "sessionId")]
    session_id: String,
    snippets: Vec<String>,
}

/// 增强全局聊天记录搜索：并行检索所有非删除状态会话中的实际聊天记录内容，并返回匹配高亮片段 (最多 3 条)
#[tauri::command]
fn search_session_contents(query: String) -> Result<Vec<ContentSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    log_to_file(&format!("search_session_contents called: query={}", query));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, type, agent_session_id, path FROM sessions WHERE deleted = 0")
        .map_err(|e| e.to_string())?;

    let sessions: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for (session_id, session_type, agent_session_id, project_path) in sessions {
        if session_type != "claude" {
            continue;
        }

        if let Some(jsonl_path) = find_claude_jsonl(&agent_session_id, &project_path) {
            if let Ok(file) = std::fs::File::open(&jsonl_path) {
                use std::io::{BufRead, BufReader};
                let reader = BufReader::new(file);

                let mut snippets = Vec::new();
                for line in reader.lines() {
                    let line_str = match line {
                        Ok(l) => l,
                        Err(_) => continue,
                    };

                    // 快速子串过滤，大幅减少 JSON 反序列化的开销
                    if line_str.to_lowercase().contains(&query_lower) {
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&line_str) {
                            let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            let text = if typ == "user" {
                                extract_message_content(&obj)
                            } else if typ == "assistant" {
                                extract_assistant_text(&obj)
                            } else if typ == "last-prompt" {
                                obj.get("lastPrompt").and_then(|v| v.as_str()).unwrap_or("").to_string()
                            } else {
                                String::new()
                            };

                            let text_lower = text.to_lowercase();
                            if let Some(byte_idx) = text_lower.find(&query_lower) {
                                // 将字节索引转换为字符索引，确保在多字节字符（如中文）下切片安全
                                let char_idx = text[..byte_idx].chars().count();
                                let chars: Vec<char> = text.chars().collect();
                                let total_chars = chars.len();

                                // 适当增加上下文提取范围 (前 25 字符，后 40 字符)
                                let start = if char_idx > 25 { char_idx - 25 } else { 0 };
                                let end = std::cmp::min(total_chars, char_idx + query.chars().count() + 40);
                                
                                let sub: String = chars[start..end].iter().collect();
                                let mut snippet = sub.replace('\r', " ").replace('\n', " ").trim().to_string();

                                if start > 0 {
                                    snippet = format!("...{}", snippet);
                                }
                                if end < total_chars {
                                    snippet = format!("{}...", snippet);
                                }

                                snippets.push(snippet);
                                if snippets.len() >= 3 {
                                    break;
                                }
                            }
                        }
                    }
                }

                if !snippets.is_empty() {
                    results.push(ContentSearchResult {
                        session_id: session_id.clone(),
                        snippets,
                    });
                }
            }
        }
    }

    log_to_file(&format!("search_session_contents completed. Found {} hits.", results.len()));
    Ok(results)
}

// 4. 读取最近点选的项目路径 (前 20 个，过滤掉左侧栏已不存在的无会话项目)
#[tauri::command]
fn get_recent_projects() -> Result<Vec<RecentProject>, String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT name, path FROM recent_projects WHERE path IN (SELECT DISTINCT path FROM sessions) ORDER BY last_used_at DESC LIMIT 20")
        .map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(RecentProject {
            name: row.get(0)?,
            path: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok(proj) = row {
            result.push(proj);
        }
    }
    Ok(result)
}

// ==================== 系统控制与 PTY 引擎 Tauri Commands ====================

// 5. 呼起系统原生目录选择框
#[tauri::command]
fn select_directory() -> Option<String> {
    let folder = rfd::FileDialog::new()
        .set_title("选择项目路径")
        .pick_folder();
    folder.map(|p| p.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(serde::Serialize)]
struct DirListResult {
    current_path: String,
    parent_path: Option<String>,
    entries: Vec<DirEntry>,
    drives: Vec<String>,
    home_dir: Option<String>,
    desktop_dir: Option<String>,
}

#[cfg(target_os = "windows")]
mod win_drives {
    extern "system" {
        fn GetLogicalDrives() -> u32;
    }

    pub fn get_drives() -> Vec<String> {
        let mut drives = Vec::new();
        unsafe {
            let mask = GetLogicalDrives();
            for i in 0..26 {
                if (mask & (1 << i)) != 0 {
                    let drive = format!("{}:\\", (b'A' + i) as char);
                    drives.push(drive);
                }
            }
        }
        drives
    }
}

#[cfg(not(target_os = "windows"))]
mod win_drives {
    pub fn get_drives() -> Vec<String> {
        vec!["/".to_string()]
    }
}

#[tauri::command]
fn list_directory_folders(
    path: Option<String>,
    show_files: Option<bool>,
    extensions: Option<Vec<String>>,
) -> Result<DirListResult, String> {
    let mut target_path = if let Some(ref p) = path {
        if p.trim().is_empty() {
            dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?
        } else {
            std::path::PathBuf::from(p)
        }
    } else {
        dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?
    };

    // 如果给出的路径是一个存在的文件，则使用其父目录作为遍历起点
    if target_path.exists() && target_path.is_file() {
        if let Some(parent) = target_path.parent() {
            target_path = parent.to_path_buf();
        }
    }

    // 如果路径不存在，尝试返回其父目录或主目录
    if !target_path.exists() {
        if let Some(parent) = target_path.parent() {
            if parent.exists() && parent.is_dir() {
                target_path = parent.to_path_buf();
            } else {
                target_path = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
            }
        } else {
            target_path = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
        }
    }

    // 规范化路径，在 Windows 下去除 UNC 前缀 \\?\
    let canonical = target_path.canonicalize().unwrap_or_else(|_| target_path.clone());
    let canonical_str = canonical.to_string_lossy().to_string();
    let clean_current = if canonical_str.starts_with(r"\\?\") {
        canonical_str[4..].to_string()
    } else {
        canonical_str
    };

    let target_path_clean = std::path::PathBuf::from(&clean_current);

    let show_files_val = show_files.unwrap_or(false);
    let mut entries_list = Vec::new();
    if let Ok(dir_entries) = std::fs::read_dir(&target_path_clean) {
        for entry in dir_entries {
            if let Ok(entry) = entry {
                let p = entry.path();
                let file_name = p.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                // 跳过隐藏文件夹与系统敏感文件夹
                if file_name.starts_with('.') && file_name != "." && file_name != ".." {
                    continue;
                }
                if file_name.eq_ignore_ascii_case("System Volume Information") || file_name.starts_with('$') {
                    continue;
                }

                let is_dir = p.is_dir();
                
                if !is_dir && !show_files_val {
                    continue; // 过滤文件，如果不需要显示文件
                }

                // 如果需要显示文件，且有扩展名过滤器
                if !is_dir && show_files_val {
                    if let Some(ref exts) = extensions {
                        let matches_filter = p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e_str| exts.iter().any(|x| x.eq_ignore_ascii_case(e_str)))
                            .unwrap_or(false);
                        
                        if !matches_filter {
                            continue; // 过滤掉不匹配后缀的文件
                        }
                    }
                }

                let p_str = p.to_string_lossy().to_string();
                let clean_p = if p_str.starts_with(r"\\?\") {
                    p_str[4..].to_string()
                } else {
                    p_str
                };

                entries_list.push(DirEntry {
                    name: file_name,
                    path: clean_p,
                    is_dir,
                });
            }
        }
    }

    // 排序逻辑：文件夹优先展示在前面，然后按字母不区分大小写排序
    entries_list.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    // 获取父路径并清理
    let parent_path = target_path_clean.parent().map(|p| {
        let p_str = p.to_string_lossy().to_string();
        if p_str.starts_with(r"\\?\") {
            p_str[4..].to_string()
        } else {
            p_str
        }
    });

    let drives = win_drives::get_drives();
    
    let home_dir = dirs::home_dir().map(|p| {
        let p_str = p.to_string_lossy().to_string();
        if p_str.starts_with(r"\\?\") {
            p_str[4..].to_string()
        } else {
            p_str
        }
    });

    let desktop_dir = dirs::desktop_dir().map(|p| {
        let p_str = p.to_string_lossy().to_string();
        if p_str.starts_with(r"\\?\") {
            p_str[4..].to_string()
        } else {
            p_str
        }
    });

    Ok(DirListResult {
        current_path: clean_current,
        parent_path,
        entries: entries_list,
        drives,
        home_dir,
        desktop_dir,
    })
}

// 5b. 呼起系统原生文件选择框选择 ccswitch.exe 路径
#[tauri::command]
fn select_ccswitch_file() -> Option<String> {
    let file = rfd::FileDialog::new()
        .set_title("选择 ccswitch.exe 路径")
        .add_filter("可执行文件", &["exe"])
        .pick_file();
    file.map(|p| p.to_string_lossy().to_string())
}

// 5c. 打开指定的 ccswitch.exe 可执行文件
#[tauri::command]
fn launch_ccswitch(path: String) -> Result<(), String> {
    log_to_file(&format!("launch_ccswitch called: path={}", path));
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err("指定的 ccswitch.exe 路径不存在或不是有效文件，请在设置中配置正确路径。".to_string());
    }
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(p)
            .spawn()
            .map_err(|e| format!("启动 ccswitch 失败: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("该功能仅在 Windows 系统中可用".to_string())
    }
}


#[tauri::command]
fn open_project_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("该操作系统暂不支持直接打开文件夹".to_string())
    }
}

// 6b. 打开终端中检测到的文件路径 (如果是文件则在文件管理器中选中该文件)
#[tauri::command]
fn open_terminal_path(path: String) -> Result<(), String> {
    use std::path::Path;
    let p = Path::new(&path);
    if p.exists() {
        #[cfg(target_os = "windows")]
        {
            if p.is_file() {
                use std::os::windows::process::CommandExt;
                let win_path = path.replace('/', "\\");
                std::process::Command::new("explorer")
                    .raw_arg(format!(r#"/select,"{}""#, win_path))
                    .spawn()
                    .map_err(|e| e.to_string())?;
            } else {
                std::process::Command::new("explorer")
                    .arg(p)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        {
            let dir = if p.is_file() {
                p.parent().unwrap_or(p)
            } else {
                p
            };
            let _ = dir;
            return Err("该操作系统暂不支持直接打开文件夹".to_string());
        }
    } else {
        // 路径不存在时，检查其父目录是否存在
        if let Some(parent) = p.parent() {
            if parent.exists() {
                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer")
                        .arg(parent)
                        .spawn()
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                }
                #[cfg(not(target_os = "windows"))]
                {
                    return Err("该操作系统暂不支持直接打开文件夹".to_string());
                }
            }
        }
    }
    Err("指定路径及其父目录均不存在".to_string())
}

// 7. 拉起本地虚拟终端并运行 Agent (重连会话自动键入 /resume 恢复上下文)
#[tauri::command]
fn spawn_terminal(
    session_id: String,
    directory: String,
    agent_type: String,
    agent_session_id: String,
    is_reopen: bool,
    initial_cols: Option<u16>,
    initial_rows: Option<u16>,
    state: State<'_, PtyManager>,
    app_handle: AppHandle,
) -> Result<(), String> {
    log_to_file(&format!(
        "spawn_terminal called: session_id={}, directory={}, agent_type={}, agent_session_id={}, is_reopen={}, initial_cols={:?}, initial_rows={:?}",
        session_id, directory, agent_type, agent_session_id, is_reopen, initial_cols, initial_rows
    ));

    // 生成微秒级唯一启动识别 Token，防止 React StrictMode 双重挂载或快速切换导致的多线程重复输入
    let spawn_token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    log_to_file(&format!("spawn_terminal generated spawn_token: {}", spawn_token));

    // 🎯 检查是否已经在运行中，若是则直接返回，防范 duplicate spawning 重复拉起
    {
        let sessions = state.sessions.lock().unwrap();
        if sessions.contains_key(&session_id) {
            log_to_file(&format!("spawn_terminal: Session {} is already active in sessions map. Skipping duplicate spawn.", session_id));
            return Ok(());
        }
    }

    // 物理路径预检，防止 ConPTY 引擎工作目录无效导致进程 Panic 崩溃闪退
    let path = std::path::Path::new(&directory);
    if !path.exists() || !path.is_dir() {
        let err_msg = format!("项目目录路径不存在或不是一个有效文件夹，请核对路径: {}", directory);
        log_to_file(&format!("spawn_terminal path error: {}", err_msg));
        return Err(err_msg);
    }
    log_to_file("spawn_terminal directory exists and is a valid directory.");

    log_to_file("Obtaining native PTY system...");
    let pty_system = native_pty_system();
    log_to_file("PTY system obtained. Opening PTY...");
    let pty_cols = initial_cols.unwrap_or(80).clamp(20, 300);
    let pty_rows = initial_rows.unwrap_or(24).clamp(5, 120);
    let pair = pty_system.openpty(PtySize {
        rows: pty_rows,
        cols: pty_cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e: anyhow::Error| {
        let err_msg = format!("openpty failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    log_to_file("PTY opened successfully.");

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c.arg("-NoProfile");
        c.arg("-ExecutionPolicy");
        c.arg("Bypass");
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("bash");

    log_to_file(&format!("Setting slave working directory to: {}", directory));
    cmd.cwd(std::path::PathBuf::from(&directory));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "KKCoder");

    log_to_file("Spawning command in PTY slave...");
    let mut _child = pair.slave.spawn_command(cmd).map_err(|e: anyhow::Error| {
        let err_msg = format!("spawn_command failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    log_to_file("Slave process spawned successfully.");
    
    let master = pair.master;
    log_to_file("Taking master writer...");
    let mut writer = master.take_writer().map_err(|e: anyhow::Error| {
        let err_msg = format!("take_writer failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    log_to_file("Cloning master reader...");
    let reader = master.try_clone_reader().map_err(|e: anyhow::Error| {
        let err_msg = format!("try_clone_reader failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    log_to_file("Master reader cloned.");

    // 自动运行 Agent CLI 脚本
    // 自动运行 Agent CLI 脚本
    let initial_cmd = if agent_type == "claude" {
        if is_reopen {
            "claude --dangerously-skip-permissions\r\n".to_string()
        } else {
            format!("claude --dangerously-skip-permissions --session-id \"{}\"\r\n", agent_session_id)
        }
    } else if agent_type == "pi" {
        if is_reopen {
            format!("pi --session \"{}\"\r\n", agent_session_id)
        } else {
            "pi\r\n".to_string()
        }
    } else {
        "\r\n".to_string()
    };
    log_to_file(&format!("initial_cmd prepared: {:?}", initial_cmd));

    log_to_file("Sleeping 300ms before initial command write...");
    std::thread::sleep(std::time::Duration::from_millis(300));
    
    log_to_file("Writing initial command to PTY master writer...");
    writer.write_all(initial_cmd.as_bytes()).map_err(|e: std::io::Error| {
        let err_msg = format!("write_all initial_cmd failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    writer.flush().map_err(|e: std::io::Error| {
        let err_msg = format!("flush initial_cmd failed: {}", e);
        log_to_file(&format!("spawn_terminal error: {}", err_msg));
        err_msg
    })?;
    log_to_file("Initial command written and flushed.");

    // 包装 writer 为 Arc<Mutex<>> 以便远程输入共享
    let writer = Arc::new(Mutex::new(writer));

    // 如果是重新唤起已有的克劳德会话，则延时 2.5 秒等 Claude Banner 加载后，自动键入 /resume 还原会话
    if is_reopen && agent_type == "claude" {
        log_to_file("is_reopen is true for Claude: spawning background thread for `/resume` writing...");
        let sessions_clone = state.sessions.clone();
        let session_id_clone = session_id.clone();
        let agent_session_id_clone = agent_session_id.clone();
        std::thread::spawn(move || {
            log_to_file(&format!("Background `/resume` thread spawned. spawn_token={}. Sleeping 2500ms...", spawn_token));
            // 等待 2.5 秒让 Claude 客户端完全拉起并输出提示符
            std::thread::sleep(std::time::Duration::from_millis(2500));
            log_to_file("Background `/resume` thread sleep finished. Locking sessions map...");
            let mut sessions = sessions_clone.lock().unwrap();
            if let Some(session) = sessions.get_mut(&session_id_clone) {
                // 校验 Token：若已被新 Spawn 实例覆盖，则放弃本次过期的键入操作，彻底杜绝重复键入
                if session.spawn_token != spawn_token {
                    log_to_file(&format!("Stale spawn token detected (active={}, thread={}). Safely skipping resume typing.", session.spawn_token, spawn_token));
                    return;
                }

                let resume_cmd = format!("/resume {}", agent_session_id_clone);
                log_to_file(&format!("Background thread: writing resume cmd: {:?}", resume_cmd));
                {
                    let mut w = session.writer.lock().unwrap();
                    w.write_all(resume_cmd.as_bytes()).ok();
                    w.flush().ok();
                }
                log_to_file("Background thread: resume cmd written. Dropping lock and sleeping 500ms...");

                // 释放锁，防止阻塞其他线程
                drop(sessions);
                std::thread::sleep(std::time::Duration::from_millis(500));

                // 重新获取锁并触发一次回车
                log_to_file("Background thread: re-acquiring lock to trigger Enter...");
                let mut sessions = sessions_clone.lock().unwrap();
                if let Some(session) = sessions.get_mut(&session_id_clone) {
                    if session.spawn_token != spawn_token {
                        log_to_file("Stale spawn token during Enter key trigger. Safely skipping Enter.");
                        return;
                    }
                    let mut w = session.writer.lock().unwrap();
                    w.write_all(b"\r\n").ok();
                    w.flush().ok();
                    log_to_file("Background thread: Enter key sent!");
                } else {
                    log_to_file("Background thread error during Enter send: session lost!");
                }
            } else {
                log_to_file("Background thread error: active session not found inside sessions map!");
            }
        });
    }

    // 如果是首次创建的 Pi 会话，则延时 2.0 秒等 Pi 客户端完全拉起后，自动键入 /session 获取并存储 session ID
    if !is_reopen && agent_type == "pi" {
        log_to_file("!is_reopen is true for Pi: spawning background thread for `/session` writing...");
        let sessions_clone = state.sessions.clone();
        let session_id_clone = session_id.clone();
        std::thread::spawn(move || {
            log_to_file(&format!("Background `/session` thread spawned. spawn_token={}. Sleeping 2000ms...", spawn_token));
            std::thread::sleep(std::time::Duration::from_millis(2000));
            log_to_file("Background `/session` thread sleep finished. Locking sessions map...");
            let mut sessions = sessions_clone.lock().unwrap();
            if let Some(session) = sessions.get_mut(&session_id_clone) {
                if session.spawn_token != spawn_token {
                    log_to_file(&format!("Stale spawn token detected (active={}, thread={}). Safely skipping session query.", session.spawn_token, spawn_token));
                    return;
                }

                log_to_file("Background thread: writing /session cmd...");
                {
                    let mut w = session.writer.lock().unwrap();
                    w.write_all(b"/session\r\n").ok();
                    w.flush().ok();
                }
                log_to_file("Background thread: /session cmd written!");
            }
        });
    }

    let session_id_clone = session_id.clone();
    let app_handle_clone = app_handle.clone();
    let sessions_map_clone = state.sessions.clone();
    let registry_clone = state.session_registry.clone();

    // 远程访问：注册到 SessionRegistry（broadcast 通道同步输出，输入通过 Tauri write_to_terminal 命令写入）
    let remote_output_tx = if let Some(ref registry) = state.session_registry {
        let (output_tx, _) = tokio::sync::broadcast::channel(256);
        let replay = Arc::new(remote::state::ReplayBuffer::new(3000));
        let status = Arc::new(remote::state::AtomicSessionStatus::new(
            remote::state::SessionStatus::Idle,
        ));

        let handle = Arc::new(remote::state::SessionHandle {
            input_tx: {
                // 创建一个虚拟通道（实际输入通过 pty_writer 直接写入）
                let (tx, _rx) = tokio::sync::mpsc::channel(1);
                tx
            },
            output_tx: output_tx.clone(),
            status: status.clone(),
            replay: replay.clone(),
            session_name: String::new(),
            pty_writer: Some(writer.clone()),
        });

        registry.insert(session_id.clone(), handle);
        Some(output_tx)
    } else {
        None
    };

    log_to_file("Spawning PTY reader listener thread...");
    std::thread::spawn(move || {
        log_to_file("PTY reader listener thread spawned.");
        let mut reader = reader;
        let mut buffer = [0u8; 4096];
        let mut seq: u64 = 0;
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 {
                log_to_file("PTY reader thread: read EOF (0 bytes). Exiting reader loop.");
                break;
            }
            let data = String::from_utf8_lossy(&buffer[..n]).to_string();

            // 发送到前端
            app_handle_clone
                .emit(
                    "pty-output",
                    PtyOutputPayload {
                        session_id: session_id_clone.clone(),
                        data: data.clone(),
                    },
                )
                .ok();

            // 发送到远程广播通道（带序号和时间戳，用于断线重连）
            if let Some(ref output_tx) = remote_output_tx {
                seq += 1;
                let frame = remote::state::OutputFrame {
                    seq,
                    session_id: session_id_clone.clone(),
                    data,
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                };
                // 存入 replay buffer
                if let Some(ref registry) = registry_clone {
                    if let Some(handle) = registry.get(&session_id_clone) {
                        handle.replay.push(frame.clone());
                    }
                }
                let _ = output_tx.send(frame);
            }
        }
        log_to_file("PTY reader listener thread exited.");
        // 当进程退出时，自动从 sessions map 中清理，以防下一次无法重新拉起
        let mut sessions = sessions_map_clone.lock().unwrap();
        sessions.remove(&session_id_clone);
        log_to_file(&format!(
            "Session {} cleaned up from sessions map after PTY EOF.",
            session_id_clone
        ));
    });

    log_to_file("Locking sessions map to insert active session...");
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(
        session_id.clone(),
        ActiveSession {
            master,
            writer: writer.clone(),
            spawn_token,
        },
    );

    // 将 writer 注册到远程状态（用于远程 WebSocket 输入写入）
    // 通过 SessionRegistry 的 SessionHandle 存储 writer 引用
    // 实际上，远程输入通过共享的 writer Arc<Mutex<>> 直接写入
    log_to_file(&format!(
        "Session inserted into sessions map with spawn_token {}. spawn_terminal finished successfully!",
        spawn_token
    ));

    Ok(())
}

// 8. 写入 PTY 终端
#[tauri::command]
fn write_to_terminal(
    session_id: String,
    data: String,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data.as_bytes()).map_err(|e: std::io::Error| e.to_string())?;
        writer.flush().map_err(|e: std::io::Error| e.to_string())?;
        Ok(())
    } else {
        Err(format!("会话 {} 不存在", session_id))
    }
}

// 9. PTY 视口缩放
#[tauri::command]
fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e: anyhow::Error| e.to_string())?;
        Ok(())
    } else {
        Err(format!("会话 {} 不存在", session_id))
    }
}

// 11. 在本地数据库中对会话进行重命名
#[tauri::command]
fn rename_session(id: String, new_name: String) -> Result<(), String> {
    log_to_file(&format!("rename_session called: id={}, new_name={}", id, new_name));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE sessions SET name = ?1 WHERE id = ?2", [&new_name, &id])
        .map_err(|e| e.to_string())?;
    log_to_file("rename_session completed successfully.");
    Ok(())
}

// 12. 在本地数据库中切换会话收藏状态
#[tauri::command]
fn toggle_favorite(id: String, favorite: i32) -> Result<(), String> {
    log_to_file(&format!("toggle_favorite called: id={}, favorite={}", id, favorite));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute("UPDATE sessions SET favorite = ?1 WHERE id = ?2", [&favorite.to_string(), &id])
        .map_err(|e| e.to_string())?;
    log_to_file("toggle_favorite completed successfully.");
    Ok(())
}

#[tauri::command]
fn touch_session_last_user_message(id: String) -> Result<(), String> {
    log_to_file(&format!("touch_session_last_user_message called: id={}", id));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE sessions SET last_user_message_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    log_to_file("touch_session_last_user_message completed successfully.");
    Ok(())
}

// 13. 检查路径是否存在且为目录，如果不存在，返回特定的状态 (如 "not_exists")
#[tauri::command]
fn check_directory(path: String) -> String {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        "not_exists".to_string()
    } else if !p.is_dir() {
        "not_dir".to_string()
    } else {
        "ok".to_string()
    }
}

// 14. 自动创建多级物理目录
#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    log_to_file(&format!("create_directory called: path={}", path));
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    log_to_file("create_directory completed successfully.");
    Ok(())
}

// 10. 关闭并销毁运行时 PTY 终端进程
#[tauri::command]
fn close_terminal(
    session_id: String,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    log_to_file(&format!("close_terminal called: session_id={}", session_id));
    let mut sessions = state.sessions.lock().unwrap();
    if sessions.remove(&session_id).is_some() {
        log_to_file(&format!("Session {} successfully removed and dropped.", session_id));
        Ok(())
    } else {
        log_to_file(&format!("Session {} not found in active sessions map.", session_id));
        Ok(())
    }
}

// 15. 播放本地通知音效与系统气泡通知（极其可靠，不受浏览器沙盒和后台静音限制）
#[tauri::command]
fn play_notification_sound(
    tone: String,
    volume: f64,
    title: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    log_to_file(&format!(
        "play_notification_sound called: tone={}, volume={}, title={:?}, message={:?}",
        tone, volume, title, message
    ));

    let file_name = match tone.as_str() {
        "dingdong" => "ding.wav",
        "bell" => "chimes.wav",
        "success" => "tada.wav",
        "alarm" => "Alarm01.wav",
        "bubble" => "Windows Balloon.wav",
        "crystal" => "chord.wav",
        "dream" => "Windows Notify.wav",
        "water" => "Windows Default.wav",
        _ => "ding.wav",
    };

    let wav_path = format!("C:/Windows/Media/{}", file_name);
    let vol_scaled = volume / 100.0;

    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut ps_script = format!(
                "Add-Type -AssemblyName PresentationCore; \
                 $p = New-Object System.Windows.Media.MediaPlayer; \
                 $p.Open('{}'); \
                 $p.Volume = {}; \
                 $p.Play();",
                wav_path, vol_scaled
            );

            if let (Some(t), Some(m)) = (title, message) {
                ps_script.push_str(&format!(
                    " [void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); \
                     $notification = New-Object System.Windows.Forms.NotifyIcon; \
                     $notification.Icon = [System.Drawing.SystemIcons]::Information; \
                     $notification.BalloonTipTitle = '{}'; \
                     $notification.BalloonTipText = '{}'; \
                     $notification.Visible = $true; \
                     $notification.ShowBalloonTip(3000);",
                    t.replace('\'', "''"),
                    m.replace('\'', "''")
                ));
            }

            ps_script.push_str(" Start-Sleep -s 3;");

            let _ = std::process::Command::new("powershell")
                .args(["-Command", &ps_script])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (wav_path, vol_scaled, title, message);
        }
    });

    Ok(())
}

#[tauri::command]
fn save_clipboard_image(bytes: Vec<u8>, filename: String) -> Result<String, String> {
    use std::fs::File;
    use std::io::Write;
    
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(&filename);
    
    let mut file = File::create(&file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write bytes: {}", e))?;
        
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn check_if_paths_exist(text: String) -> bool {
    if text.is_empty() {
        return false;
    }
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return false;
    }
    for line in lines {
        let clean = line.trim_matches(|c| c == '"' || c == '\'');
        let p = std::path::Path::new(clean);
        if !p.exists() {
            return false;
        }
    }
    true
}

#[tauri::command]
fn read_markdown_file(path: String, filename: String) -> Result<String, String> {
    use std::fs;
    let file_path = std::path::Path::new(&path).join(&filename);
    if !file_path.exists() {
        return Ok("".to_string());
    }
    fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_markdown_file(path: String, filename: String, content: String) -> Result<(), String> {
    use std::fs;
    let file_path = std::path::Path::new(&path).join(&filename);
    fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn get_claude_version() -> Result<String, String> {
    use std::process::Command;
    
    let run_cmd = || -> Result<String, std::io::Error> {
        #[cfg(target_os = "windows")]
        let output = {
            use std::os::windows::process::CommandExt;
            Command::new("cmd")
                .args(&["/C", "claude --version"])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output()?
        };
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("sh").args(&["-c", "claude --version"]).output()?;
        
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(stdout)
        } else {
            Err(std::io::Error::new(std::io::ErrorKind::Other, "Command status non-zero"))
        }
    };

    match run_cmd() {
        Ok(stdout) => {
            if let Some(pos) = stdout.find(' ') {
                let version_num = &stdout[..pos];
                if stdout.contains("Claude Code") {
                    return Ok(format!("Claude Code {}", version_num));
                }
            }
            if !stdout.is_empty() {
                return Ok(format!("Claude Code {}", stdout));
            }
            Ok("Claude Code".to_string())
        }
        Err(_) => {
            Ok("Claude Code".to_string())
        }
    }
}

// ==================== 会话名称自动修正 (移植自 rename 项目) ====================

/// 将系统路径编码为 Claude Code 的项目目录名格式
/// 例如: D:\MyCode\KKCODER → D--MyCode-KKCODER
fn encode_claude_project_path(path: &str) -> String {
    path.replace(':', "-")
        .replace('\\', "-")
        .replace('/', "-")
}

/// 在 ~/.claude/projects/ 下查找指定 session 的 JSONL 文件
fn find_claude_jsonl(agent_session_id: &str, project_path: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let projects_root = home.join(".claude").join("projects");
    if !projects_root.is_dir() {
        return None;
    }

    // 先尝试精确匹配编码后的路径
    let encoded = encode_claude_project_path(project_path);
    let exact_path = projects_root.join(&encoded).join(format!("{}.jsonl", agent_session_id));
    if exact_path.is_file() {
        return Some(exact_path);
    }

    // 精确匹配失败则扫描所有项目目录（兼容路径变化）
    if let Ok(entries) = std::fs::read_dir(&projects_root) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let jsonl = entry.path().join(format!("{}.jsonl", agent_session_id));
            if jsonl.is_file() {
                return Some(jsonl);
            }
        }
    }
    None
}

/// 从 JSONL 文件中读取用户消息（移植自 rename 的 claude_code adapter）
fn read_claude_transcript(jsonl_path: &std::path::Path) -> Vec<(String, String)> {
    let file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(file);
    let mut msgs: Vec<(String, String)> = Vec::new(); // (role, text)
    let mut last_user = String::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        // 快速跳过不相关的行
        if !line.contains("\"user\"") && !line.contains("\"assistant\"") && !line.contains("\"last-prompt\"") {
            continue;
        }
        let obj: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if typ == "last-prompt" {
            let prompt = obj.get("lastPrompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !prompt.is_empty() && prompt != last_user {
                msgs.push(("user".into(), prompt.clone()));
                last_user = prompt;
            }
        } else if typ == "user" {
            // Claude Code JSONL 格式: {"type":"user","message":{"role":"user","content":"..."},...}
            let text = extract_message_content(&obj);
            if !text.trim().is_empty() && text != last_user {
                msgs.push(("user".into(), text.clone()));
                last_user = text;
            }
        } else if typ == "assistant" {
            let text = extract_assistant_text(&obj);
            if !text.trim().is_empty() {
                msgs.push(("assistant".into(), text));
            }
        }
    }
    msgs
}

/// 从 user 消息 JSON 中提取 content
fn extract_message_content(obj: &serde_json::Value) -> String {
    let message = match obj.get("message") {
        Some(m) => m,
        None => return String::new(),
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr.iter()
            .filter_map(|block| {
                if block.get("type")?.as_str()? == "text" {
                    Some(block.get("text")?.as_str()?.to_string())
                } else {
                    None
                }
            })
            .collect();
        return parts.join("\n");
    }
    String::new()
}

/// 从 assistant 消息 JSON 中提取纯文本
fn extract_assistant_text(obj: &serde_json::Value) -> String {
    let message = match obj.get("message") {
        Some(m) => m,
        None => return String::new(),
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr.iter()
            .filter_map(|block| {
                if block.get("type")?.as_str()? == "text" {
                    Some(block.get("text")?.as_str()?.to_string())
                } else {
                    None
                }
            })
            .collect();
        return parts.join("\n");
    }
    String::new()
}

// --- 启发式标题生成 (移植自 rename 的 heuristic namer) ---

const TRIVIAL_WORDS: &[&str] = &[
    "ok", "okay", "k", "yes", "no", "y", "n", "yep", "yeah", "sure", "thanks",
    "thank you", "go", "go on", "continue", "next", "done", "good", "great",
    "nice", "cool", "stop", "wait",
    "好", "好的", "可以", "行", "继续", "嗯", "对", "是", "不", "没问题", "没事",
    "谢谢", "好吧", "ok的", "嗯嗯", "对的", "是的", "停", "等等", "下一步",
];

const LEAD_FILLER: &[&str] = &[
    "please", "pls", "can you", "could you", "help me",
    "i want to", "i need to", "let's", "lets",
    "now", "ok", "okay", "so", "then", "next",
    "帮我", "请", "麻烦", "我想", "我要", "然后", "现在", "帮忙", "给我",
];

const TRAIL_STOP: &[&str] = &[
    "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "with",
    "at", "by", "is", "are", "be", "was", "were", "this", "that", "these",
    "those", "my", "your", "our", "please", "just", "so", "then", "now", "it",
];

const CJK_TRAIL: &str = "的了吗呢吧啊呀嘛哦着呗咯";

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| c >= '\u{4e00}' && c <= '\u{9fff}')
}

fn is_trivial(text: &str) -> bool {
    let t = text.trim().trim_matches(|c| " .!?。！？,，".contains(c));
    if t.is_empty() || t.len() <= 1 {
        return true;
    }
    let low = t.to_lowercase();
    if TRIVIAL_WORDS.contains(&low.as_str()) {
        return true;
    }
    if t.starts_with('/') && !t.contains(' ') {
        return true;
    }
    false
}

/// 清洗文本：去掉代码块、标签、URL、路径等噪音
fn clean_text(text: &str) -> String {
    let mut t = text.to_string();

    // 去掉 XML/HTML 标签
    let tag_re = regex_lite::Regex::new(r"</?[a-z][a-z0-9-]*(?:\s[^>]*)?>").unwrap();
    t = tag_re.replace_all(&t, " ").to_string();

    // 去掉代码块
    let code_re = regex_lite::Regex::new(r"(?s)```.*?```").unwrap();
    t = code_re.replace_all(&t, " ").to_string();

    // 去掉行内代码
    let inline_re = regex_lite::Regex::new(r"`[^`]*`").unwrap();
    t = inline_re.replace_all(&t, " ").to_string();

    // 去掉 URL
    let url_re = regex_lite::Regex::new(r"https?://\S+").unwrap();
    t = url_re.replace_all(&t, " ").to_string();

    // 去掉绝对路径
    let path_re = regex_lite::Regex::new(r"(?:/[^\s/]+){2,}/?").unwrap();
    t = path_re.replace_all(&t, " ").to_string();

    // 合并空白
    let ws_re = regex_lite::Regex::new(r"\s+").unwrap();
    t = ws_re.replace_all(&t, " ").trim().to_string();

    t
}

/// 将一条消息压缩成标题级别的短语
fn condense(text: &str) -> String {
    // 去掉前导斜杠命令
    let slash_re = regex_lite::Regex::new(r"^/[a-zA-Z][\w-]*\s+").unwrap();
    let mut first = slash_re.replace(text, "").trim().to_string();

    // 按句号/问号/换行截断，取第一句
    let clause_re = regex_lite::Regex::new(r"[。.!?！？\n;；:：]").unwrap();
    if let Some(m) = clause_re.find(&first) {
        first = first[..m.start()].trim().to_string();
    }
    if first.is_empty() {
        first = text.trim().to_string();
    }

    // 去掉前导废话
    for filler in LEAD_FILLER {
        let prefix = format!("{} ", filler);
        if first.to_lowercase().starts_with(&prefix.to_lowercase()) {
            first = first[prefix.len()..].trim().to_string();
            break;
        }
    }

    // CJK 截断
    if has_cjk(&first) {
        let mut s: String = first.chars().take(20).collect();
        while s.ends_with(|c: char| CJK_TRAIL.contains(c)) {
            s.pop();
        }
        return s;
    }

    // 英文截断到 9 个词
    let mut words: Vec<&str> = first.split_whitespace().collect();
    if words.len() > 9 {
        words.truncate(9);
    }
    // 去掉尾部停用词
    while words.len() > 2 {
        let last = words.last().unwrap().trim_matches(|c| ",.;:'\"".contains(c));
        if TRAIL_STOP.contains(&last.to_lowercase().as_str()) {
            words.pop();
        } else {
            break;
        }
    }
    words.join(" ")
}

/// 启发式标题生成：从最后一条有实质内容的用户消息中提取标题
fn heuristic_title(messages: &[(String, String)]) -> Option<String> {
    // 过滤出非 trivial 的用户消息
    let users: Vec<&str> = messages.iter()
        .filter(|(role, text)| role == "user" && !is_trivial(text))
        .map(|(_, text)| text.as_str())
        .collect();

    if users.is_empty() {
        return None;
    }

    // 优先选最后一条 >= 12 字符的消息
    let chosen = users.iter().rev()
        .find(|t| clean_text(t).len() >= 12)
        .or_else(|| users.last())?;

    let cleaned = clean_text(chosen);
    let condensed = condense(&cleaned);

    if condensed.is_empty() || condensed.len() < 2 {
        return None;
    }

    // 形状化：截断 + 首字母大写
    let max_len = 60usize;
    let mut title = if condensed.len() > max_len {
        if has_cjk(&condensed) {
            let mut s: String = condensed.chars().take(max_len - 1).collect();
            s.push('…');
            s
        } else {
            let cut = &condensed[..max_len];
            let trimmed = cut.rsplit(' ').next().unwrap_or(cut);
            format!("{}…", trimmed.trim_end())
        }
    } else {
        condensed
    };

    // 首字母大写（非 CJK）
    if !title.is_empty() {
        let first_char = title.chars().next().unwrap();
        if first_char.is_ascii_alphabetic() && !has_cjk(&title[..first_char.len_utf8()]) {
            let upper = first_char.to_uppercase().to_string();
            title = format!("{}{}", upper, &title[first_char.len_utf8()..]);
        }
    }

    Some(title)
}

/// 单个会话的修正结果
#[derive(Clone, serde::Serialize)]
struct RenameResult {
    session_id: String,
    old_name: String,
    new_name: String,
    changed: bool,
}

/// 批量自动修正会话名称（后台线程执行，不阻塞 UI）
#[tauri::command]
async fn auto_rename_sessions(
    skip_favorites: bool,
    project_filter: Option<String>,
) -> Result<Vec<RenameResult>, String> {
    // 在后台线程执行所有 IO 操作
    tokio::task::spawn_blocking(move || {
        let db_path = get_db_path();
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

        let mut query = String::from(
            "SELECT id, name, project, path, type, agent_session_id, favorite \
             FROM sessions WHERE deleted = 0"
        );
        if skip_favorites {
            query.push_str(" AND favorite = 0");
        }
        if let Some(ref proj) = project_filter {
            query.push_str(&format!(" AND project = '{}'", proj.replace('\'', "''")));
        }

        let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let sessions: Vec<Session> = stmt.query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                name: row.get(1)?,
                project: row.get(2)?,
                path: row.get(3)?,
                session_type: row.get(4)?,
                agent_session_id: row.get(5)?,
                created_at: None,
                last_user_message_at: None,
                favorite: row.get(6)?,
                deleted: 0,
                deleted_at: None,
            })
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        let mut results = Vec::new();
        let home = dirs::home_dir().map(|p| p.display().to_string()).unwrap_or_else(|| "NONE".into());
        log_to_file(&format!("auto_rename: home_dir={}, found {} total sessions", home, sessions.len()));

        for session in &sessions {
            // 只处理 Claude 类型的会话
            if session.session_type != "claude" {
                continue;
            }

            let jsonl_path = match find_claude_jsonl(&session.agent_session_id, &session.path) {
                Some(p) => p,
                None => {
                    results.push(RenameResult {
                        session_id: session.id.clone(),
                        old_name: session.name.clone(),
                        new_name: session.name.clone(),
                        changed: false,
                    });
                    continue;
                }
            };

            let transcript = read_claude_transcript(&jsonl_path);
            if transcript.is_empty() {
                results.push(RenameResult {
                    session_id: session.id.clone(),
                    old_name: session.name.clone(),
                    new_name: session.name.clone(),
                    changed: false,
                });
                continue;
            }

            let new_title = match heuristic_title(&transcript) {
                Some(t) => t,
                None => {
                    results.push(RenameResult {
                        session_id: session.id.clone(),
                        old_name: session.name.clone(),
                        new_name: session.name.clone(),
                        changed: false,
                    });
                    continue;
                }
            };

            // 标题没变就不更新
            if new_title == session.name {
                results.push(RenameResult {
                    session_id: session.id.clone(),
                    old_name: session.name.clone(),
                    new_name: new_title,
                    changed: false,
                });
                continue;
            }

            // 写入数据库
            if let Err(e) = conn.execute(
                "UPDATE sessions SET name = ?1 WHERE id = ?2",
                rusqlite::params![new_title, session.id],
            ) {
                log_to_file(&format!("auto_rename error for {}: {}", session.id, e));
                continue;
            }

            results.push(RenameResult {
                session_id: session.id.clone(),
                old_name: session.name.clone(),
                new_name: new_title.clone(),
                changed: true,
            });
        }

        let changed_count = results.iter().filter(|r| r.changed).count();
        log_to_file(&format!("auto_rename_sessions completed: {} sessions updated out of {} total", changed_count, results.len()));

        Ok(results)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

/// LLM 批量标题生成：一次请求生成所有会话标题
/// last_rename_times: JSON 字符串 {"session_id": last_rename_epoch_seconds, ...}
/// 只处理 JSONL 文件 mtime > 上次修正时间的会话，避免无新内容时浪费 API 调用
#[tauri::command]
async fn llm_rename_sessions(
    api_url: String,
    api_key: String,
    model: String,
    skip_favorites: bool,
    project_filter: Option<String>,
    last_rename_times: Option<String>,
) -> Result<Vec<RenameResult>, String> {
    if api_key.is_empty() {
        return Err("API Key 未配置".into());
    }

    tokio::task::spawn_blocking(move || -> Result<Vec<RenameResult>, String> {
        let db_path = get_db_path();
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

        // 1. 查询所有活跃 Claude 会话
        let mut query = String::from(
            "SELECT id, name, project, path, type, agent_session_id, favorite \
             FROM sessions WHERE deleted = 0 AND type = 'claude'"
        );
        if skip_favorites {
            query.push_str(" AND favorite = 0");
        }
        if let Some(ref proj) = project_filter {
            query.push_str(&format!(" AND project = '{}'", proj.replace('\'', "''")));
        }

        let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let sessions: Vec<Session> = stmt.query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                name: row.get(1)?,
                project: row.get(2)?,
                path: row.get(3)?,
                session_type: row.get(4)?,
                agent_session_id: row.get(5)?,
                created_at: None,
                last_user_message_at: None,
                favorite: row.get(6)?,
                deleted: 0,
                deleted_at: None,
            })
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        log_to_file(&format!("llm_rename: found {} claude sessions", sessions.len()));

        // 解析上次修正时间表
        let rename_times: std::collections::HashMap<String, f64> = last_rename_times
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        // 2. 为每个会话准备摘要（只处理有新内容的会话）
        let mut session_summaries: Vec<(String, String, String)> = Vec::new(); // (id, name, summary)
        let mut skipped_no_change = 0usize;
        let mut all_results: Vec<RenameResult> = Vec::new(); // 包含跳过的会话
        for session in &sessions {
            let jsonl_path = match find_claude_jsonl(&session.agent_session_id, &session.path) {
                Some(p) => p,
                None => continue,
            };

            // 检查 JSONL 文件是否有新内容（mtime > 上次修正时间）
            if let Some(&last_time) = rename_times.get(&session.id) {
                if let Ok(meta) = std::fs::metadata(&jsonl_path) {
                    if let Ok(modified) = meta.modified() {
                        let mtime = modified.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs_f64();
                        if mtime <= last_time {
                            skipped_no_change += 1;
                            all_results.push(RenameResult {
                                session_id: session.id.clone(),
                                old_name: session.name.clone(),
                                new_name: session.name.clone(),
                                changed: false,
                            });
                            continue;
                        }
                    }
                }
            }

            let transcript = read_claude_transcript(&jsonl_path);
            if transcript.is_empty() {
                continue;
            }

            // 取最后几条消息，压缩到 ~500 字符
            let mut summary_parts: Vec<String> = Vec::new();
            let mut char_count = 0usize;
            for (role, text) in transcript.iter().rev() {
                let cleaned = clean_text(text);
                if cleaned.is_empty() {
                    continue;
                }
                let truncated = if cleaned.chars().count() > 200 {
                    let s: String = cleaned.chars().take(200).collect();
                    format!("{}...", s)
                } else {
                    cleaned
                };
                let line = format!("{}: {}", role, truncated);
                let line_len = line.len();
                if char_count + line_len > 500 {
                    break;
                }
                summary_parts.push(line);
                char_count += line_len;
            }
            summary_parts.reverse();

            if !summary_parts.is_empty() {
                session_summaries.push((
                    session.id.clone(),
                    session.name.clone(),
                    summary_parts.join("\n"),
                ));
            }
        }

        if session_summaries.is_empty() {
            log_to_file(&format!("llm_rename: no sessions with new content ({} skipped, {} total)", skipped_no_change, all_results.len()));
            return Ok(all_results);
        }

        log_to_file(&format!("llm_rename: prepared {} session summaries (skipped {} with no new content), calling LLM...",
            session_summaries.len(), skipped_no_change));

        // 3. 构造批量 prompt
        let mut prompt_parts: Vec<String> = Vec::new();
        prompt_parts.push("你是一个会话标题生成器。根据以下每个会话的对话摘要，为每个会话生成一个简短的中文标题（不超过20个字）。\n".into());
        prompt_parts.push("标题应该概括对话的核心内容，而不是截取开头文字。\n\n".into());

        for (i, (_id, name, summary)) in session_summaries.iter().enumerate() {
            prompt_parts.push(format!(
                "会话 {} (当前标题: \"{}\"):\n{}\n\n",
                i + 1,
                name,
                summary
            ));
        }

        prompt_parts.push(format!(
            "请严格按以下 JSON 格式返回，不要添加任何其他文字：\n\
             {{\"titles\": [{{\"index\": 1, \"title\": \"生成的标题\"}}, ...]}}\n\n\
             共 {} 个会话，必须全部返回。",
            session_summaries.len()
        ));

        let prompt = prompt_parts.join("");

        // 4. 调用 LLM API（同步阻塞，在 spawn_blocking 线程中）
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

        let api_url_trimmed = api_url.trim_end_matches('/');
        let url = format!("{}/v1/chat/completions", api_url_trimmed);

        let body = serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": "你是会话标题生成器，只输出JSON。"},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.3,
            "max_tokens": 2048
        });

        log_to_file(&format!("llm_rename: calling {} with model {}", url, model));

        let resp = client.post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .map_err(|e| format!("LLM 请求失败: {}", e))?;

        let status = resp.status();
        let resp_text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;

        if !status.is_success() {
            log_to_file(&format!("llm_rename: API error {} - {}", status, resp_text));
            let err_preview: String = resp_text.chars().take(200).collect();
            return Err(format!("LLM API 返回错误 {}: {}", status, err_preview));
        }

        log_to_file(&format!("llm_rename: got response ({} chars)", resp_text.len()));

        // 5. 解析响应
        let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
            .map_err(|e| format!("解析 LLM 响应失败: {}", e))?;

        let content = resp_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or("LLM 响应格式异常：缺少 choices[0].message.content")?;

        log_to_file(&format!("llm_rename: content = {}", &content[..content.len().min(500)]));

        // 提取 JSON（可能被 markdown 代码块包裹）
        let json_str = if let Some(start) = content.find('{') {
            if let Some(end) = content.rfind('}') {
                &content[start..=end]
            } else {
                content
            }
        } else {
            content
        };

        let titles_json: serde_json::Value = serde_json::from_str(json_str)
            .map_err(|e| {
                let raw_preview: String = json_str.chars().take(200).collect();
                format!("解析标题 JSON 失败: {} (raw: {})", e, raw_preview)
            })?;

        let titles_arr = titles_json.get("titles")
            .and_then(|t| t.as_array())
            .ok_or("JSON 缺少 titles 数组")?;

        // 6. 更新数据库
        let mut results = Vec::new();
        for (i, (session_id, old_name, _)) in session_summaries.iter().enumerate() {
            let new_title = titles_arr.iter()
                .find(|t| t.get("index").and_then(|v| v.as_u64()).unwrap_or(0) == (i as u64 + 1))
                .and_then(|t| t.get("title"))
                .and_then(|t| t.as_str())
                .unwrap_or("");

            if new_title.is_empty() || new_title == old_name.as_str() {
                results.push(RenameResult {
                    session_id: session_id.clone(),
                    old_name: old_name.clone(),
                    new_name: new_title.to_string(),
                    changed: false,
                });
                continue;
            }

            if let Err(e) = conn.execute(
                "UPDATE sessions SET name = ?1 WHERE id = ?2",
                rusqlite::params![new_title, session_id],
            ) {
                log_to_file(&format!("llm_rename: DB update error for {}: {}", session_id, e));
                continue;
            }

            log_to_file(&format!("llm_rename: '{}' -> '{}'", old_name, new_title));
            results.push(RenameResult {
                session_id: session_id.clone(),
                old_name: old_name.clone(),
                new_name: new_title.to_string(),
                changed: true,
            });
        }

        // 合并跳过的会话和实际修正的会话
        all_results.extend(results);
        let changed_count = all_results.iter().filter(|r| r.changed).count();
        log_to_file(&format!("llm_rename: completed, {} titles updated out of {} total ({} skipped)", changed_count, all_results.len(), skipped_no_change));

        Ok(all_results)
    }).await.map_err(|e| format!("Task join error: {}", e))?
}

// ==================== 归档项目 Tauri Commands ====================

// 归档项目
#[tauri::command]
fn archive_project(project_name: String, project_path: String, sessions_json: String) -> Result<(), String> {
    log_to_file(&format!("archive_project called: name={}, path={}", project_name, project_path));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    // 获取当前月份作为归档分类
    let archive_month = chrono::Local::now().format("%Y-%m").to_string();
    
    conn.execute(
        "INSERT INTO archived_projects (project_name, project_path, archive_month, sessions_data) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![project_name, project_path, archive_month, sessions_json],
    ).map_err(|e| e.to_string())?;
    
    log_to_file(&format!("Project archived successfully: {} (month: {})", project_name, archive_month));
    Ok(())
}

// 获取所有归档项目
#[tauri::command]
fn get_archived_projects() -> Result<Vec<ArchivedProject>, String> {
    log_to_file("get_archived_projects called.");
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare(
        "SELECT id, project_name, project_path, archived_at, archive_month, sessions_data FROM archived_projects ORDER BY archived_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(ArchivedProject {
            id: row.get(0)?,
            project_name: row.get(1)?,
            project_path: row.get(2)?,
            archived_at: row.get(3)?,
            archive_month: row.get(4)?,
            sessions_data: row.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[]".to_string()),
        })
    }).map_err(|e| e.to_string())?;
    
    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }
    
    log_to_file(&format!("Found {} archived projects.", projects.len()));
    Ok(projects)
}

// 还原归档项目
#[tauri::command]
fn restore_archived_project(id: i32) -> Result<String, String> {
    log_to_file(&format!("restore_archived_project called: id={}", id));
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    
    // 先获取 sessions_data，再删除归档记录
    let sessions_data: String = conn.query_row(
        "SELECT COALESCE(sessions_data, '[]') FROM archived_projects WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "DELETE FROM archived_projects WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| e.to_string())?;
    
    log_to_file(&format!("Archived project restored (deleted) successfully: id={}", id));
    Ok(sessions_data)
}


#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ProjectFileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn read_project_files(project_path: String) -> Result<Vec<ProjectFileEntry>, String> {
    log_to_file(&format!("read_project_files called: project_path={}", project_path));
    let root = std::path::Path::new(&project_path);
    if !root.exists() {
        return Err("Project path does not exist".to_string());
    }

    let mut files = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];
    let mut count = 0;

    while let Some(dir) = dirs_to_visit.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");

                    if file_name.starts_with('.') && file_name != ".gitignore" && file_name != ".env" {
                        continue;
                    }
                    if file_name == "node_modules"
                        || file_name == "venv"
                        || file_name == "env"
                        || file_name == "dist"
                        || file_name == "build"
                        || file_name == "target"
                        || file_name == "out"
                    {
                        continue;
                    }

                    let is_dir = path.is_dir();
                    let size = if is_dir { 0 } else { path.metadata().map(|m| m.len()).unwrap_or(0) };

                    let relative_path = match path.strip_prefix(root) {
                        Ok(p) => p.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };

                    files.push(ProjectFileEntry {
                        name: file_name.to_string(),
                        path: relative_path,
                        is_dir,
                        size,
                    });

                    if is_dir {
                        dirs_to_visit.push(path);
                    }

                    count += 1;
                    if count > 5000 {
                        break;
                    }
                }
            }
        }
        if count > 5000 {
            break;
        }
    }

    // Sort: directories first, then files, alphabetically
    files.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.path.cmp(&b.path)
        }
    });

    Ok(files)
}

#[tauri::command]
fn read_project_directory(project_path: String, relative_path: String) -> Result<Vec<ProjectFileEntry>, String> {
    log_to_file(&format!("read_project_directory called: project_path={}, relative_path={}", project_path, relative_path));
    let root = std::path::Path::new(&project_path);
    let dir_path = if relative_path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&relative_path)
    };

    let root_canonical = root.canonicalize().map_err(|e| format!("Failed to canonicalize project root: {}", e))?;
    let dir_canonical = match dir_path.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("Directory not found or inaccessible: {}", e)),
    };

    if !dir_canonical.starts_with(&root_canonical) {
        return Err("Access denied: Path outside project root".to_string());
    }

    if !dir_canonical.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir_canonical) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");

                if file_name.starts_with('.') && file_name != ".gitignore" && file_name != ".env" {
                    continue;
                }
                if file_name == "node_modules"
                    || file_name == "venv"
                    || file_name == "env"
                    || file_name == "dist"
                    || file_name == "build"
                    || file_name == "target"
                    || file_name == "out"
                    || file_name == ".git"
                {
                    continue;
                }

                let is_dir = path.is_dir();
                let size = if is_dir { 0 } else { path.metadata().map(|m| m.len()).unwrap_or(0) };

                let rel_path = match path.strip_prefix(&root_canonical) {
                    Ok(p) => p.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };

                files.push(ProjectFileEntry {
                    name: file_name.to_string(),
                    path: rel_path,
                    is_dir,
                    size,
                });
            }
        }
    }

    // Sort: directories first, then files, alphabetically
    files.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.path.cmp(&b.path)
        }
    });

    Ok(files)
}

#[tauri::command]
fn search_project_files(project_path: String, query: String) -> Result<Vec<ProjectFileEntry>, String> {
    log_to_file(&format!("search_project_files called: project_path={}, query={}", project_path, query));
    let root = std::path::Path::new(&project_path);
    if !root.exists() {
        return Err("Project path does not exist".to_string());
    }

    let query_lower = query.to_lowercase();
    let mut files = Vec::new();
    let mut dirs_to_visit = vec![root.to_path_buf()];
    let mut count = 0;

    while let Some(dir) = dirs_to_visit.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");

                    if file_name.starts_with('.') && file_name != ".gitignore" && file_name != ".env" {
                        continue;
                    }
                    if file_name == "node_modules"
                        || file_name == "venv"
                        || file_name == "env"
                        || file_name == "dist"
                        || file_name == "build"
                        || file_name == "target"
                        || file_name == "out"
                        || file_name == ".git"
                    {
                        continue;
                    }

                    let is_dir = path.is_dir();
                    let matches_query = file_name.to_lowercase().contains(&query_lower);

                    let rel_path = match path.strip_prefix(root) {
                        Ok(p) => p.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };

                    if matches_query && !is_dir {
                        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                        files.push(ProjectFileEntry {
                            name: file_name.to_string(),
                            path: rel_path,
                            is_dir,
                            size,
                        });
                        count += 1;
                        if count >= 300 {
                            break;
                        }
                    }

                    if is_dir {
                        dirs_to_visit.push(path);
                    }
                }
            }
        }
        if count >= 300 {
            break;
        }
    }

    // Sort: directories first, then files, alphabetically
    files.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.path.cmp(&b.path)
        }
    });

    Ok(files)
}


#[tauri::command]
fn read_project_file_content(project_path: String, relative_path: String) -> Result<String, String> {
    log_to_file(&format!("read_project_file_content called: project_path={}, relative_path={}", project_path, relative_path));
    let root = std::path::Path::new(&project_path);
    let full_path = root.join(&relative_path);

    let root_canonical = root.canonicalize().map_err(|e| format!("Failed to canonicalize project root: {}", e))?;
    let full_path_canonical = match full_path.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("File not found or inaccessible: {}", e)),
    };

    if !full_path_canonical.starts_with(&root_canonical) {
        return Err("Access denied: File outside project root".to_string());
    }

    if !full_path_canonical.is_file() {
        return Err("Not a file".to_string());
    }

    let mut file = std::fs::File::open(&full_path_canonical).map_err(|e| e.to_string())?;
    use std::io::Read;
    let mut buffer = vec![0; 1024 * 1024]; // 1MB limit
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(bytes_read);

    match String::from_utf8(buffer) {
        Ok(content) => Ok(content),
        Err(_) => Err("Binary file or invalid UTF-8 encoding. Preview is disabled.".to_string()),
    }
}

#[tauri::command]
fn open_file_in_system(path: String) -> Result<(), String> {
    log_to_file(&format!("open_file_in_system called: path={}", path));
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let cmd = "open";
        #[cfg(target_os = "linux")]
        let cmd = "xdg-open";
        
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    log_to_file(&format!("open_in_file_manager called: path={}", path));
    
    #[cfg(target_os = "windows")]
    {
        let win_path = path.replace('/', "\\");
        let p = std::path::Path::new(&win_path);
        if !p.exists() {
            return Err(format!("指定路径不存在: {}", win_path));
        }
        if p.is_file() {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer")
                .raw_arg(format!(r#"/select,"{}""#, win_path))
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(&win_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err("指定路径不存在".to_string());
        }
        #[cfg(target_os = "macos")]
        {
            if p.is_file() {
                std::process::Command::new("open")
                    .args(["-R", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            } else {
                std::process::Command::new("open")
                    .arg(&path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let dir = if p.is_file() {
                p.parent().unwrap_or(p)
            } else {
                p
            };
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}


// ==================== 远程访问 Tauri Commands ====================

#[derive(serde::Serialize)]
struct RemoteConfigDTO {
    enabled: bool,
    port: u16,
    listen_mode: String,
    public_url: String,
    frp_server_addr: String,
    frp_server_port: u16,
    frp_token: String,
    frp_use_tls: bool,
}

/// 获取远程访问配置
#[tauri::command]
fn get_remote_config() -> Result<RemoteConfigDTO, String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;

    let get_val = |key: &str, default: &str| -> String {
        conn.query_row(
            "SELECT value FROM remote_config WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| default.to_string())
    };

    Ok(RemoteConfigDTO {
        enabled: get_val("enabled", "false") == "true",
        port: get_val("port", "9527").parse().unwrap_or(9527),
        listen_mode: get_val("listen_mode", "localhost"),
        public_url: get_val("public_url", ""),
        frp_server_addr: get_val("frp_server_addr", ""),
        frp_server_port: get_val("frp_server_port", "7000").parse().unwrap_or(7000),
        frp_token: get_val("frp_token", ""),
        frp_use_tls: get_val("frp_use_tls", "false") == "true",
    })
}

/// 设置远程访问启用状态
#[tauri::command]
fn set_remote_enabled(enabled: bool) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('enabled', ?1)",
        [if enabled { "true" } else { "false" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置监听端口
#[tauri::command]
fn set_remote_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err("端口号不能小于 1024".to_string());
    }
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('port', ?1)",
        [port.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置监听模式：localhost 或 0.0.0.0
#[tauri::command]
fn set_listen_mode(mode: String) -> Result<(), String> {
    if mode != "localhost" && mode != "all" {
        return Err("监听模式必须是 localhost 或 all".to_string());
    }
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('listen_mode', ?1)",
        [&mode],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置公网访问地址（用于移动端连接）
#[tauri::command]
fn set_public_url(url: String) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('public_url', ?1)",
        [&url],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 测试公网地址连通性
#[tauri::command]
async fn test_public_url(url: String) -> Result<bool, String> {
    let url = url.trim_end_matches('/');
    // 自动补全协议前缀
    let url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("http://{}", url)
    };
    let test_url = format!("{}/api/status", url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&test_url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// 生成配对 PIN
#[tauri::command]
async fn generate_pairing_pin(
    _state: State<'_, PtyManager>,
) -> Result<String, String> {
    let pin = remote::auth::generate_pin();
    let expiry = remote::auth::pin_expiry();
    let expiry_millis = expiry
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();

    let db_path = get_db_path();
    let pin_clone = pin.clone();
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('pairing_pin', ?1)",
            [&pin_clone],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('pin_expires_at', ?1)",
            [&expiry_millis],
        )
        .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(pin)
}

/// 获取已配对设备列表
#[tauri::command]
fn get_paired_devices() -> Result<Vec<remote::handlers::DeviceDTO>, String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT device_id, device_name, paired_at, last_seen FROM paired_devices ORDER BY paired_at DESC")
        .map_err(|e| e.to_string())?;

    let devices = stmt
        .query_map([], |row| {
            Ok(remote::handlers::DeviceDTO {
                device_id: row.get(0)?,
                device_name: row.get(1)?,
                paired_at: row.get(2)?,
                last_seen: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(devices)
}

/// 吊销设备
#[tauri::command]
fn revoke_device(device_id: String) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM paired_devices WHERE device_id = ?1",
        [&device_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取服务器状态
#[tauri::command]
fn get_server_status() -> Result<remote::handlers::ServerStatusDTO, String> {
    // 简化版本：从数据库读取配置
    let config = get_remote_config()?;
    Ok(remote::handlers::ServerStatusDTO {
        running: config.enabled,
        port: config.port,
        active_sessions: 0, // 需要从远程状态获取
        paired_devices: 0,
    })
}

/// 设置 frp 服务器地址
#[tauri::command]
fn set_frp_server_addr(addr: String) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('frp_server_addr', ?1)",
        [&addr],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置 frp 服务器端口
#[tauri::command]
fn set_frp_server_port(port: u16) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('frp_server_port', ?1)",
        [port.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置 frp token
#[tauri::command]
fn set_frp_token(token: String) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('frp_token', ?1)",
        [&token],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置 frp TLS 开关
#[tauri::command]
fn set_frp_use_tls(use_tls: bool) -> Result<(), String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO remote_config (key, value) VALUES ('frp_use_tls', ?1)",
        [if use_tls { "true" } else { "false" }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取本地局域网 IP 地址
#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    let addr = socket.local_addr().map_err(|e| e.to_string())?;
    Ok(addr.ip().to_string())
}

/// 启动 frp 客户端
#[tauri::command]
fn start_frp(
    server_addr: String,
    server_port: u16,
    token: String,
    local_port: u16,
    use_tls: bool,
    state: State<'_, remote::frp::FrpManager>,
) -> Result<(), String> {
    state.start(&server_addr, server_port, &token, local_port, use_tls)
}

/// 停止 frp 客户端
#[tauri::command]
fn stop_frp(
    state: State<'_, remote::frp::FrpManager>,
) -> Result<(), String> {
    state.stop()
}

/// 获取 frp 运行状态
#[tauri::command]
fn get_frp_status(
    state: State<'_, remote::frp::FrpManager>,
) -> Result<remote::frp::FrpStatusDTO, String> {
    Ok(state.get_status())
}

pub fn run() {
    // 启动时初始化数据库表
    initialize_database().expect("Failed to initialize SQLite database");

    // 初始化远程访问状态
    let session_registry = Arc::new(remote::state::SessionRegistry::new());
    let db_path = get_db_path();

    // 从数据库加载配对设备到内存缓存
    let paired_devices = {
        let devices = dashmap::DashMap::new();
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT device_id, device_name, token, paired_at, last_seen FROM paired_devices",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    let token: String = row.get(2)?;
                    Ok((token, remote::state::DeviceInfo {
                        device_id: row.get(0)?,
                        device_name: row.get(1)?,
                        paired_at: row.get(3)?,
                        last_seen: row.get(4)?,
                    }))
                }) {
                    for row in rows.flatten() {
                        devices.insert(row.0, row.1);
                    }
                }
            }
        }
        devices
    };

    // 从数据库加载远程配置
    let remote_config = {
        let get_val = |key: &str, default: &str| -> String {
            rusqlite::Connection::open(&db_path)
                .ok()
                .and_then(|conn| {
                    conn.query_row(
                        "SELECT value FROM remote_config WHERE key = ?1",
                        [key],
                        |row| row.get(0),
                    )
                    .ok()
                })
                .unwrap_or_else(|| default.to_string())
        };

        remote::state::RemoteConfig {
            enabled: get_val("enabled", "false") == "true",
            port: get_val("port", "9527").parse().unwrap_or(9527),
            listen_mode: get_val("listen_mode", "localhost"),
            pairing_pin: None,
            pin_expires_at: None,
        }
    };

    let remote_state = Arc::new(remote::state::RemoteServerState {
        session_registry: session_registry.clone(),
        config: Arc::new(tokio::sync::Mutex::new(remote_config)),
        paired_devices: Arc::new(paired_devices),
        db_path: db_path.clone(),
        spawn_requests: Arc::new(tokio::sync::Mutex::new(Vec::new())),
    });

    // 启动远程访问服务器（在独立线程中）
    let remote_state_for_server = remote_state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = rt.block_on(remote::server::start_remote_server(remote_state_for_server));
    });

    // 创建 PtyManager 并注入 session_registry
    let mut pty_manager = PtyManager::default();
    pty_manager.session_registry = Some(session_registry.clone());

    tauri::Builder::default()
        .manage(pty_manager)
        .manage(remote::frp::FrpManager::new())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            use tauri::Manager;
            
            // 1. 获取默认窗口图标
            let icon = app.default_window_icon().cloned();
            
            // 2. 创建系统托盘右键菜单项
            let show_item = tauri::menu::MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "退出 KKCoder", true, None::<&str>)?;
            
            let menu = tauri::menu::MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // 3. 构建托盘并绑定事件
            if let Some(i) = icon {
                let _tray = tauri::tray::TrayIconBuilder::new()
                    .icon(i)
                    .tooltip("KKCoder 极简 AI 终端管理器")
                    .menu(&menu)
                    .show_menu_on_left_click(false) // 左键单击/双击用于显示窗口，右键才打开菜单
                    .on_menu_event(|app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // 左键单击时直接显示并聚焦窗口
                        if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // 启动远程 spawn 请求轮询任务
            let remote_state_poll = remote_state.clone();
            let pty_mgr_ref = app.state::<PtyManager>();
            let pty_sessions_for_spawn = pty_mgr_ref.sessions.clone();
            let _registry_for_spawn = pty_mgr_ref.session_registry.clone();
            let app_handle_for_spawn = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let mut requests = remote_state_poll.spawn_requests.lock().await;
                        if requests.is_empty() {
                            continue;
                        }
                        let pending: Vec<_> = requests.drain(..).collect();
                        drop(requests);

                        for req in pending {
                            // 检查是否已在运行
                            let already_running = pty_sessions_for_spawn
                                .lock()
                                .unwrap()
                                .contains_key(&req.session_id);
                            if already_running {
                                continue;
                            }

                            // 调用 spawn_terminal 逻辑
                            // 由于 spawn_terminal 是 Tauri command，这里直接执行 PTY 逻辑
                            log_to_file(&format!(
                                "Remote spawn request: session={}, dir={}, type={}",
                                req.session_id, req.directory, req.agent_type
                            ));
                            // 实际启动需要调用 spawn_terminal，但这里无法直接调用
                            // 改为通知前端执行
                            let _ = app_handle_for_spawn.emit(
                                "remote-spawn-request",
                                serde_json::json!({
                                    "session_id": req.session_id,
                                    "directory": req.directory,
                                    "agent_type": req.agent_type,
                                    "agent_session_id": req.agent_session_id,
                                    "is_reopen": req.is_reopen,
                                }),
                            );
                        }
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            add_session,
            delete_session,
            delete_session_permanently,
            restore_session,
            empty_trash,
            cleanup_stale_sessions,
            cleanup_empty_sessions,
            get_recent_projects,
            select_directory,
            list_directory_folders,
            open_project_folder,
            open_terminal_path,
            spawn_terminal,
            write_to_terminal,
            resize_terminal,
            close_terminal,
            rename_session,
            toggle_favorite,
            touch_session_last_user_message,
            check_directory,
            create_directory,
            play_notification_sound,
            save_clipboard_image,
            read_markdown_file,
            write_markdown_file,
            get_claude_version,
            check_if_paths_exist,
            archive_project,
            get_archived_projects,
            restore_archived_project,
            auto_rename_sessions,
            llm_rename_sessions,
            search_session_contents,
            read_project_files,
            read_project_directory,
            search_project_files,
            read_project_file_content,
            open_file_in_system,
            open_in_file_manager,
            select_ccswitch_file,
            launch_ccswitch,
            get_remote_config,
            set_remote_enabled,
            set_remote_port,
            set_listen_mode,
            set_public_url,
            test_public_url,
            generate_pairing_pin,
            get_paired_devices,
            revoke_device,
            get_server_status,
            set_frp_server_addr,
            set_frp_server_port,
            set_frp_token,
            set_frp_use_tls,
            get_local_ip,
            start_frp,
            stop_frp,
            get_frp_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
