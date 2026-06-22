use std::process::{Child, Command};
use std::sync::Mutex;

/// frp 客户端管理器
pub struct FrpManager {
    child: Mutex<Option<Child>>,
}

impl FrpManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    /// 启动 frp 客户端
    pub fn start(
        &self,
        server_addr: &str,
        server_port: u16,
        token: &str,
        local_port: u16,
        use_tls: bool,
    ) -> Result<(), String> {
        let mut child = self.child.lock().map_err(|e| e.to_string())?;

        if child.is_some() {
            return Err("frp client is already running".to_string());
        }

        // 生成 frpc.toml 配置文件
        let config_dir = std::env::temp_dir().join("kkcoder_frp");
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create frp config dir: {}", e))?;

        let config_path = config_dir.join("frpc.toml");
        let tls_section = if use_tls {
            "\ntransport.tls.enable = true\n"
        } else {
            ""
        };
        let config_content = format!(
            r#"serverAddr = "{}"
serverPort = {}
auth.token = "{}"{}

[[proxies]]
name = "kkcoder-remote"
type = "tcp"
localIP = "127.0.0.1"
localPort = {}
remotePort = {}
"#,
            server_addr, server_port, token, tls_section, local_port, local_port
        );

        std::fs::write(&config_path, config_content)
            .map_err(|e| format!("Failed to write frp config: {}", e))?;

        // 查找 frpc 可执行文件
        let frpc_path = find_frpc_binary()?;
        log_to_file(&format!(
            "Starting frp client: {} -c {}",
            frpc_path.display(),
            config_path.display()
        ));

        let process = Command::new(&frpc_path)
            .args(["-c", config_path.to_str().unwrap_or("")])
            .spawn()
            .map_err(|e| format!("Failed to start frp client: {}", e))?;

        *child = Some(process);
        log_to_file("frp client started");
        Ok(())
    }

    /// 停止 frp 客户端
    pub fn stop(&self) -> Result<(), String> {
        let mut child = self.child.lock().map_err(|e| e.to_string())?;

        if let Some(ref mut proc) = *child {
            proc.kill().map_err(|e| format!("Failed to kill frp: {}", e))?;
            log_to_file("frp client stopped");
        }

        *child = None;
        Ok(())
    }

    /// 检查 frp 是否运行中
    pub fn is_running(&self) -> bool {
        self.child
            .lock()
            .map(|c| c.is_some())
            .unwrap_or(false)
    }

    /// 获取 frp 状态
    pub fn get_status(&self) -> FrpStatusDTO {
        FrpStatusDTO {
            running: self.is_running(),
        }
    }
}

#[derive(serde::Serialize)]
pub struct FrpStatusDTO {
    pub running: bool,
}

/// 查找 frpc 二进制文件
/// 优先检查应用资源目录，然后检查 PATH
fn find_frpc_binary() -> Result<std::path::PathBuf, String> {
    // 1. 检查应用同目录
    let app_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    let candidates = if cfg!(target_os = "windows") {
        vec![
            app_dir.join("frpc.exe"),
            app_dir.join("resources").join("frpc.exe"),
        ]
    } else {
        vec![
            app_dir.join("frpc"),
            app_dir.join("resources").join("frpc"),
        ]
    };

    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }

    // 2. 检查 PATH
    let frpc_name = if cfg!(target_os = "windows") {
        "frpc.exe"
    } else {
        "frpc"
    };

    if let Ok(output) = Command::new(if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    })
    .arg(frpc_name)
    .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let path = path_str.trim().lines().next().unwrap_or("");
            if !path.is_empty() {
                return Ok(std::path::PathBuf::from(path));
            }
        }
    }

    Err("frpc binary not found. Please place frpc.exe in the application directory or add it to PATH.".to_string())
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
