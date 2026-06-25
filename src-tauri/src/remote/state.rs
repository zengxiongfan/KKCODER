use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};

/// 远程服务器共享状态
pub struct RemoteServerState {
    /// 会话注册表：session_id -> SessionHandle
    pub session_registry: Arc<SessionRegistry>,
    /// 服务器配置
    pub config: Arc<tokio::sync::Mutex<RemoteConfig>>,
    /// 已配对设备缓存 (token -> DeviceInfo)
    pub paired_devices: Arc<DashMap<String, DeviceInfo>>,
    /// 数据库路径
    pub db_path: PathBuf,
    /// 待桌面端执行的 spawn 请求队列
    pub spawn_requests: Arc<tokio::sync::Mutex<Vec<SpawnRequest>>>,
    /// 对话状态管理（JSONL 监听 + chat 事件推送）
    pub conversation: Option<Arc<super::conversation::ConversationState>>,
}

/// 远程 spawn 请求（手机端发起，桌面端执行）
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SpawnRequest {
    pub session_id: String,
    pub directory: String,
    pub agent_type: String,
    pub agent_session_id: String,
    pub is_reopen: bool,
}

impl Clone for RemoteServerState {
    fn clone(&self) -> Self {
        Self {
            session_registry: self.session_registry.clone(),
            config: self.config.clone(),
            paired_devices: self.paired_devices.clone(),
            db_path: self.db_path.clone(),
            spawn_requests: self.spawn_requests.clone(),
            conversation: self.conversation.clone(),
        }
    }
}


/// 会话注册表
pub struct SessionRegistry {
    sessions: DashMap<String, Arc<SessionHandle>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn insert(&self, session_id: String, handle: Arc<SessionHandle>) {
        self.sessions.insert(session_id, handle);
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.get(session_id).map(|r| r.value().clone())
    }

    pub fn remove(&self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn list_ids(&self) -> Vec<String> {
        self.sessions.iter().map(|r| r.key().clone()).collect()
    }

    pub fn sessions_iter(&self) -> impl Iterator<Item = (String, Arc<SessionHandle>)> + '_ {
        self.sessions.iter().map(|r| (r.key().clone(), r.value().clone()))
    }
}

/// 会话句柄 - 轻量级，可安全跨线程共享
pub struct SessionHandle {
    /// 发送输入到 PTY
    pub input_tx: mpsc::Sender<InputCommand>,
    /// 订阅输出（每会话独立通道）
    pub output_tx: broadcast::Sender<OutputFrame>,
    /// 会话状态
    pub status: Arc<AtomicSessionStatus>,
    /// 断线重连用的 ring buffer
    pub replay: Arc<ReplayBuffer>,
    /// 会话名称
    pub session_name: String,
    /// PTY 写入器的引用（用于远程输入写入）
    pub pty_writer: Option<Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>>,
    /// PTY resize 通道（cols, rows）
    pub resize_tx: Option<mpsc::Sender<(u16, u16)>>,
    /// Claude Code agent session ID（用于 JSONL 会话记录查找）
    pub agent_session_id: String,
    /// 项目路径（用于 JSONL 会话记录查找）
    pub project_path: String,
}

/// 输入命令
pub enum InputCommand {
    Text(String),
    Resize { cols: u16, rows: u16 },
}

/// 输出帧（带序号）
#[derive(Clone, serde::Serialize)]
pub struct OutputFrame {
    pub seq: u64,
    pub session_id: String,
    pub data: String,
    pub timestamp: u64,
}

/// 会话状态
pub struct AtomicSessionStatus {
    inner: AtomicU8,
}

impl AtomicSessionStatus {
    pub fn new(status: SessionStatus) -> Self {
        Self {
            inner: AtomicU8::new(status as u8),
        }
    }

    pub fn get(&self) -> SessionStatus {
        match self.inner.load(Ordering::Relaxed) {
            0 => SessionStatus::Idle,
            1 => SessionStatus::Busy,
            2 => SessionStatus::Disconnected,
            _ => SessionStatus::Idle,
        }
    }

    pub fn set(&self, status: SessionStatus) {
        self.inner.store(status as u8, Ordering::Relaxed);
    }
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum SessionStatus {
    Idle = 0,
    Busy = 1,
    Disconnected = 2,
}

/// 断线重连缓冲区
pub struct ReplayBuffer {
    buffer: std::sync::Mutex<Vec<OutputFrame>>,
    max_size: usize,
}

impl ReplayBuffer {
    pub fn new(max_size: usize) -> Self {
        Self {
            buffer: std::sync::Mutex::new(Vec::new()),
            max_size,
        }
    }

    pub fn push(&self, frame: OutputFrame) {
        let mut buf = self.buffer.lock().unwrap();
        buf.push(frame);
        if buf.len() > self.max_size {
            buf.remove(0);
        }
    }

    pub fn get_since(&self, seq: u64) -> Vec<OutputFrame> {
        let buf = self.buffer.lock().unwrap();
        buf.iter().filter(|f| f.seq > seq).cloned().collect()
    }
}

/// 设备信息（缓存在内存）
#[derive(Clone)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub paired_at: String,
    pub last_seen: String,
}

/// 远程服务器配置
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
    pub listen_mode: String, // "localhost" 或 "all"
    pub pairing_pin: Option<String>,
    pub pin_expires_at: Option<SystemTime>,
}
