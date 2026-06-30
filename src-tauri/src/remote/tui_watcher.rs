//! TUI 交互监听任务
//!
//! 订阅所有活跃会话的 PTY 输出，通过 TuiPromptDetector 检测交互元素，
//! 检测到后将格式化的消息卡片通过 ConversationState 广播给手机端。

use std::collections::HashMap;
use std::sync::Arc;

use super::conversation::ConversationState;
use super::state::SessionRegistry;
use super::tui_detector::TuiPromptDetector;

/// 运行 TUI 交互监听任务
pub async fn run_tui_watcher(
    conversation: Arc<ConversationState>,
    session_registry: Arc<SessionRegistry>,
) {
    log_to_file("[TUI Watcher] Started");

    let mut detectors: HashMap<String, TuiPromptDetector> = HashMap::new();
    let mut subscribers: HashMap<String, tokio::sync::broadcast::Receiver<super::state::OutputFrame>> = HashMap::new();

    loop {
        // 检查新注册的会话
        for (sid, handle) in session_registry.sessions_iter() {
            if !subscribers.contains_key(&sid) {
                log_to_file(&format!("[TUI Watcher] Subscribing to session {}", sid));
                let rx = handle.output_tx.subscribe();
                subscribers.insert(sid.clone(), rx);
                detectors.insert(sid.clone(), TuiPromptDetector::new(30));
            }
        }

        // 移除已不存在的会话
        let active_ids: std::collections::HashSet<String> =
            session_registry.sessions_iter().map(|(sid, _)| sid).collect();
        subscribers.retain(|sid, _| active_ids.contains(sid));
        detectors.retain(|sid, _| active_ids.contains(sid));

        // 检查所有 subscriber 的输出
        for (sid, rx) in subscribers.iter_mut() {
            while let Ok(frame) = rx.try_recv() {
                if let Some(detector) = detectors.get_mut(sid) {
                    if let Some(card_text) = detector.feed(&frame.data) {
                        log_to_file(&format!(
                            "[TUI Watcher] Detected menu for session {}, sending choice card",
                            sid
                        ));
                        // 作为 choice_card 消息广播
                        if let Some(tx) = conversation.event_txs.get(sid) {
                            let event = serde_json::json!({
                                "type": "choice_card",
                                "text": card_text,
                                "created_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
                            });
                            let _ = tx.send(event.to_string());
                        }
                    }
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        let since = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let _ = writeln!(file, "[Timestamp: {}ms] {}", since.as_millis(), message);
    }
}
