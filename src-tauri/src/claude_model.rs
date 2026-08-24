//! Claude 模型/供应商选择（KKCODER 内生效，**不碰任何持久配置**）：
//! - 供应商列表：只读 cc-switch.db（配置由 CC Switch 管理，KKCODER 绝不写它）
//! - 切换供应商：只记录选择（内存 + 前端 localStorage），不写 settings.json / cc-switch.db；
//!   生效方式 = 启动 claude 时生成临时 settings 文件（`--settings`，直连该供应商真实 env）
//!   ——原实现直接改写 ~/.claude/settings.json，会被 CC Switch 的"Live 配置同步回写 db"机制
//!   污染 CC Switch 的供应商配置（如 OpenCode Go 被覆盖成 longcat），故废弃
//! - 仅路由供应商（apiFormat 非 anthropic，如 OpenCode Go）：claude 无法直连，
//!   选择仅用于查看其模型映射，实际请求跟随 CC Switch 现状
//! - 模型清单：从所选供应商 db env 收集（未选时只读展示 settings.json 现状）；
//!   手动选模型 = 启动时加 --model

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::State;

/// CC Switch 路由代理的占位 token（claude 走代理时 settings.json env 里的值）
const PROXY_PLACEHOLDER_TOKEN: &str = "PROXY_MANAGED";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProviderInfo {
    pub id: String,
    pub name: String,
    /// 供应商直连地址（settings_config env 的 ANTHROPIC_BASE_URL）
    pub base_url: String,
    /// 仅支持路由：apiFormat 非 anthropic（openai_chat/openai_responses 等），Claude 无法直连
    pub route_only: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelInfo {
    /// 去重后的第三方模型名（已去掉 [1m]/[1M] 后缀）
    pub models: Vec<String>,
    /// 当前配置映射下实际生效的模型（未显式选择时用于展示）
    pub default_model: Option<String>,
    /// 当前生效供应商名
    pub provider_name: Option<String>,
    /// 是否本地路由模式（route_mode 判断：开关开 或 base_url 指向回环）
    pub route_mode: bool,
    /// CC Switch 路由开关是否开启（明确的开关状态）
    pub route_enabled: bool,
    /// 当前直连的供应商已不在 CC Switch 列表（被删除/改名）
    pub provider_removed: bool,
    /// 可选 claude 供应商列表（来自 cc-switch.db，只读）
    pub providers: Vec<ClaudeProviderInfo>,
}

const TIERS: [&str; 3] = ["opus", "sonnet", "haiku"];
const EXTRA_MODEL_KEYS: [&str; 3] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

/// KKCODER 全局状态（仅内存，不持久化到任何配置文件）：
/// model = 手动指定模型（None = 不传 --model，用配置现状）；
/// provider_id = 用户选择的供应商（启动 claude 时用其 env 生成临时 settings 文件）
#[derive(Default)]
pub struct ClaudeModelState {
    pub model: Mutex<Option<String>>,
    pub provider_id: Mutex<Option<String>>,
}

fn settings_path() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("settings.json"))
}

fn read_settings_json() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(settings_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// 打开 cc-switch.db（默认只读；写入用 try_write）
fn open_cc_switch_db(writable: bool) -> Option<Connection> {
    let path = dirs::home_dir()?.join(".cc-switch").join("cc-switch.db");
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    Connection::open_with_flags(&path, flags).ok()
}

/// meta JSON 里的 apiFormat 是否非 anthropic（openai_chat 等 → 仅路由）
fn meta_route_only(meta_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(meta_json)
        .ok()
        .and_then(|meta| meta.get("apiFormat").and_then(|v| v.as_str()).map(str::to_string))
        .is_some_and(|format| !format.trim().eq_ignore_ascii_case("anthropic"))
}

/// 读全部 claude 供应商（只读）
fn read_claude_providers(conn: &Connection) -> Vec<ClaudeProviderInfo> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, settings_config, meta FROM providers WHERE app_type = 'claude'",
    ) else {
        return Vec::new();
    };
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .ok();
    let mut providers = Vec::new();
    for row in rows.into_iter().flatten().flatten() {
        let (id, name, config, meta) = row;
        let base_url = serde_json::from_str::<serde_json::Value>(&config)
            .ok()
            .and_then(|config| {
                config
                    .get("env")
                    .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let route_only = meta.as_deref().map(meta_route_only).unwrap_or(false);
        providers.push(ClaudeProviderInfo {
            id,
            name,
            base_url,
            route_only,
        });
    }
    providers
}

/// 读取所选供应商的 env（settings_config JSON 里的 env 对象）
fn read_provider_env(conn: &Connection, provider_id: &str) -> Option<serde_json::Value> {
    let raw: String = conn
        .query_row(
            "SELECT settings_config FROM providers WHERE app_type = 'claude' AND id = ?1",
            [provider_id],
            |row| row.get(0),
        )
        .ok()?;
    let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
    config.get("env").cloned()
}

/// 读取某供应商是否"仅路由"（meta.apiFormat 非 anthropic）
fn read_provider_route_only(conn: &Connection, provider_id: &str) -> bool {
    let meta: Option<String> = conn
        .query_row(
            "SELECT COALESCE(meta, '') FROM providers WHERE id = ?1",
            [provider_id],
            |row| row.get(0),
        )
        .ok();
    meta.as_deref().map(meta_route_only).unwrap_or(false)
}

/// 路由开关是否开启（proxy_config.claude.enabled）——开启时 claude 全走本地代理
fn proxy_route_enabled(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT enabled FROM proxy_config WHERE app_type = 'claude'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .is_some_and(|value| value != 0)
}

/// 按 apikey 反推供应商 (名字, 是否仅路由)：key 每家唯一，能区分同 base_url 不同 key
fn resolve_provider_by_token(conn: &Connection, token: &str) -> Option<(String, bool)> {
    let token = token.trim();
    if token.is_empty() || token.eq_ignore_ascii_case(PROXY_PLACEHOLDER_TOKEN) {
        return None;
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, settings_config, COALESCE(meta, '') FROM providers WHERE app_type = 'claude'",
    ) else {
        return None;
    };
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .ok()?;
    for row in rows.flatten() {
        let (name, config, meta) = row;
        let Ok(config) = serde_json::from_str::<serde_json::Value>(&config) else {
            continue;
        };
        let Some(env_token) = config
            .get("env")
            .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if env_token.trim() == token {
            return Some((name, meta_route_only(&meta)));
        }
    }
    None
}

/// 从 settings.json 的 base_url 反推供应商 (名字, 是否仅路由)
fn resolve_provider_by_base_url(conn: &Connection, base_url: &str) -> Option<(String, bool)> {
    let normalized = base_url.trim().trim_end_matches('/');
    let by_endpoint: Option<(String, bool)> = conn
        .query_row(
            "SELECT p.name, COALESCE(p.meta, '') FROM provider_endpoints e
             JOIN providers p ON p.id = e.provider_id
             WHERE e.app_type = 'claude' AND rtrim(e.url, '/') = ?1 LIMIT 1",
            [normalized],
            |row| {
                let name: String = row.get(0)?;
                let meta: String = row.get(1)?;
                Ok((name, meta_route_only(&meta)))
            },
        )
        .ok();
    if let Some(found) = by_endpoint {
        return Some(found);
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, settings_config, COALESCE(meta, '') FROM providers WHERE app_type = 'claude'",
    ) else {
        return None;
    };
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .ok()?;
    for row in rows.flatten() {
        let (name, config, meta) = row;
        let Ok(config) = serde_json::from_str::<serde_json::Value>(&config) else {
            continue;
        };
        let Some(url) = config
            .get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if url.trim().trim_end_matches('/') == normalized {
            return Some((name, meta_route_only(&meta)));
        }
    }
    None
}

/// 去掉 [1m]/[1M] 上下文窗口后缀（仅用于展示；--model 传干净名）
fn strip_context_suffix(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() > 4 {
        let (head, tail) = trimmed.split_at(trimmed.len() - 4);
        if tail.eq_ignore_ascii_case("[1m]") {
            return head.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn is_claude_alias(value: &str) -> bool {
    value.trim().to_ascii_lowercase().starts_with("claude-")
}

/// 某 tier 对应的上游真实模型名：优先 *_MODEL_NAME，再取非别名的 *_MODEL
fn tier_model_name(env: Option<&serde_json::Value>, tier: &str) -> Option<String> {
    let env = env?;
    let upper = tier.to_ascii_uppercase();
    if let Some(name) = env
        .get(format!("ANTHROPIC_DEFAULT_{upper}_MODEL_NAME"))
        .and_then(|value| value.as_str())
    {
        let stripped = strip_context_suffix(name);
        if !stripped.is_empty() {
            return Some(stripped);
        }
    }
    if let Some(model) = env
        .get(format!("ANTHROPIC_DEFAULT_{upper}_MODEL"))
        .and_then(|value| value.as_str())
    {
        if !is_claude_alias(model) {
            let stripped = strip_context_suffix(model);
            if !stripped.is_empty() {
                return Some(stripped);
            }
        }
    }
    None
}

/// 从 env 收集去重后的模型清单 + 默认模型。
/// `tier_hint`：settings.json 顶层 model 字段（用户选中的 tier）；供应商模式无此信息时用 opus 兜底。
fn collect_models_from_env(
    env: Option<&serde_json::Value>,
    tier_hint: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let mut models: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push_model = |name: String| {
        let key = name.to_ascii_lowercase();
        if seen.insert(key) {
            models.push(name);
        }
    };
    for tier in TIERS {
        if let Some(name) = tier_model_name(env, tier) {
            push_model(name);
        }
    }
    if let Some(env) = env {
        for key in EXTRA_MODEL_KEYS {
            if let Some(value) = env.get(key).and_then(|value| value.as_str()) {
                if !is_claude_alias(value) {
                    let name = strip_context_suffix(value);
                    if !name.is_empty() {
                        push_model(name);
                    }
                }
            }
        }
    }
    let default_model = tier_hint
        .and_then(|tier| tier_model_name(env, tier))
        .or_else(|| tier_model_name(env, "opus"));
    (models, default_model)
}

#[tauri::command]
pub fn claude_model_info(state: State<'_, ClaudeModelState>) -> ClaudeModelInfo {
    let conn = open_cc_switch_db(false);
    let providers = conn
        .as_ref()
        .map(read_claude_providers)
        .unwrap_or_default();
    let route_enabled = conn.as_ref().map(proxy_route_enabled).unwrap_or(false);

    // KKCODER 内选择过供应商 → 模型清单/当前供应商从该供应商的 db 配置收集（只读，不改任何配置）
    let recorded_provider_id = state
        .provider_id
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let recorded = recorded_provider_id.as_deref().and_then(|pid| {
        conn.as_ref().and_then(|conn| {
            read_provider_env(conn, pid).map(|env| (pid.to_string(), env))
        })
    });
    if let Some((pid, env)) = recorded {
        let (models, default_model) = collect_models_from_env(Some(&env), None);
        let provider_name = conn.as_ref().and_then(|conn| {
            conn.query_row(
                "SELECT name FROM providers WHERE id = ?1",
                [&pid],
                |row| row.get::<_, String>(0),
            )
            .ok()
        });
        let route_only = conn
            .as_ref()
            .is_some_and(|conn| read_provider_route_only(conn, &pid));
        let provider_removed = provider_name.is_none();
        return ClaudeModelInfo {
            models,
            default_model,
            provider_name,
            route_mode: route_only || route_enabled,
            route_enabled,
            provider_removed,
            providers,
        };
    }

    // 未选择：只读展示 CC Switch 当前配置（settings.json 现状）
    let Some(json) = read_settings_json() else {
        return ClaudeModelInfo {
            models: Vec::new(),
            default_model: None,
            provider_name: None,
            route_mode: route_enabled,
            route_enabled,
            provider_removed: false,
            providers,
        };
    };

    let env = json.get("env");
    let base_url = env
        .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    // 路由开关开启 → 一律路由模式（claude 走本地代理）；否则按 base_url 兜底判断
    let mut route_mode =
        route_enabled || base_url.contains("127.0.0.1") || base_url.contains("localhost");
    let auth_token = env
        .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let tier = json.get("model").and_then(|value| value.as_str());
    let (models, default_model) = collect_models_from_env(env, tier);

    // 当前生效供应商名（只读展示 CC Switch 现状）：
    // 1) 路由开关开启 → cc-switch is_current
    // 2) 直连模式 → 按 apikey 反推，再 base_url 兜底
    let (provider_name, provider_removed) = if route_enabled {
        // 路由开关开启：供应商由 cc-switch 当前 is_current 决定
        let name = conn.as_ref().and_then(|conn| {
            conn.query_row(
                "SELECT name FROM providers WHERE app_type = 'claude' AND is_current = 1 LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        });
        (name, false)
    } else if !base_url.is_empty() {
        let resolved = conn
            .as_ref()
            .and_then(|conn| resolve_provider_by_token(conn, auth_token))
            .or_else(|| {
                conn.as_ref()
                    .and_then(|conn| resolve_provider_by_base_url(conn, base_url))
            });
        match resolved {
            Some((name, route_only)) => {
                if route_only {
                    route_mode = true;
                }
                (Some(name), false)
            }
            None => (None, true),
        }
    } else {
        (None, false)
    };

    ClaudeModelInfo {
        models,
        default_model,
        provider_name,
        route_mode,
        route_enabled,
        provider_removed,
        providers,
    }
}

/// 设置全局模型覆盖（None = 不传 --model，用配置现状）
#[tauri::command]
pub fn set_claude_model(state: State<'_, ClaudeModelState>, model: Option<String>) {
    let trimmed = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    crate::log_to_file(&format!("[claude_model] set model override: {:?}", trimmed));
    let mut guard = state.model.lock().unwrap_or_else(|error| error.into_inner());
    *guard = trimmed;
}

/// 切换供应商（KKCODER 内生效）：只记录选择，**不改写任何持久配置**。
/// - 不写 ~/.claude/settings.json、不改 cc-switch.db（配置是 CC Switch 的地盘，避免互相污染）
/// - 生效方式：启动 claude 时生成临时 settings 文件（`--settings`）直连该供应商，
///   或（仅路由供应商）跟随 CC Switch 现状
/// 返回切换后的最新模型信息，供前端刷新。
#[tauri::command]
pub fn set_claude_provider(
    state: State<'_, ClaudeModelState>,
    provider_id: String,
) -> Result<ClaudeModelInfo, String> {
    let conn = open_cc_switch_db(false).ok_or_else(|| "无法读取 CC Switch 数据库".to_string())?;
    let exists = conn
        .query_row(
            "SELECT 1 FROM providers WHERE app_type = 'claude' AND id = ?1",
            [&provider_id],
            |_| Ok(()),
        )
        .is_ok();
    if !exists {
        return Err("供应商不存在或已被删除".to_string());
    }
    crate::log_to_file(&format!(
        "[claude_model] select provider (仅 KKCODER 内生效，不写配置): {}",
        provider_id
    ));
    {
        let mut guard = state
            .provider_id
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *guard = Some(provider_id);
    }
    Ok(claude_model_info(state))
}

/// 生成 claude `--settings` 用的临时 settings 文件（仅对本次 claude 进程生效，不碰任何持久配置）：
/// - 已选供应商且可直连（apiFormat=anthropic）→ 原 settings.json 内容 + env 替换为该供应商 env
/// - 已选供应商仅路由 / 未选 → None（claude 跟随 CC Switch 现状）
pub fn build_settings_override_file(
    state: &ClaudeModelState,
    session_id: &str,
) -> Option<PathBuf> {
    let provider_id = state
        .provider_id
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()?;
    if provider_id.trim().is_empty() {
        return None;
    }
    let conn = open_cc_switch_db(false)?;
    if read_provider_route_only(&conn, &provider_id) {
        crate::log_to_file(&format!(
            "[claude_model] provider {provider_id} 仅路由，claude 跟随 CC Switch 现状（不改写任何配置）"
        ));
        return None;
    }
    let env = read_provider_env(&conn, &provider_id)?;
    let mut settings = read_settings_json().unwrap_or_else(|| serde_json::json!({}));
    settings["env"] = env;
    let dir = std::env::temp_dir().join("kkcoder-claude-settings");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{session_id}.json"));
    let text = serde_json::to_string_pretty(&settings).ok()?;
    std::fs::write(&path, text).ok()?;
    crate::log_to_file(&format!(
        "[claude_model] 已生成临时 settings（仅本次进程生效）: {}",
        path.display()
    ));
    Some(path)
}

/// 删除某会话的临时 settings 文件（turn 收尾时调用，尽力而为）
pub fn remove_settings_override_file(session_id: &str) {
    let path = std::env::temp_dir()
        .join("kkcoder-claude-settings")
        .join(format!("{session_id}.json"));
    let _ = std::fs::remove_file(&path);
}

/// 清理 24 小时前的临时 settings 文件（应用启动时调用，防残留堆积）
pub fn cleanup_stale_settings_override_files() {
    let dir = std::env::temp_dir().join("kkcoder-claude-settings");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(24 * 3600));
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .is_some_and(|modified| cutoff.is_none_or(|cutoff| modified < cutoff));
        if path.extension().is_some_and(|ext| ext == "json") && stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_1m_context_suffix() {
        assert_eq!(strip_context_suffix("deepseek-v4-pro[1m]"), "deepseek-v4-pro");
        assert_eq!(strip_context_suffix("deepseek-v4-pro[1M]"), "deepseek-v4-pro");
        assert_eq!(strip_context_suffix("deepseek-v4-flash"), "deepseek-v4-flash");
    }

    #[test]
    fn recognizes_claude_alias_but_not_third_party() {
        assert!(is_claude_alias("claude-opus-4-8[1M]"));
        assert!(!is_claude_alias("deepseek-v4-pro"));
    }

    #[test]
    fn tier_model_prefers_name_var_then_non_alias_model() {
        let route_env = serde_json::json!({
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8[1M]",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "deepseek-v4-pro"
        });
        assert_eq!(
            tier_model_name(Some(&route_env), "opus").as_deref(),
            Some("deepseek-v4-pro")
        );
        let direct_env = serde_json::json!({
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro"
        });
        assert_eq!(
            tier_model_name(Some(&direct_env), "opus").as_deref(),
            Some("deepseek-v4-pro")
        );
        let alias_only = serde_json::json!({
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6"
        });
        assert_eq!(tier_model_name(Some(&alias_only), "sonnet"), None);
    }

    #[test]
    fn model_info_collects_deduped_models() {
        let env = serde_json::json!({
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "deepseek-v4-pro",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "deepseek-v4-pro",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "deepseek-v4-flash",
            "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash"
        });
        let mut models: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut push = |name: String| {
            if seen.insert(name.to_ascii_lowercase()) {
                models.push(name);
            }
        };
        for tier in TIERS {
            if let Some(name) = tier_model_name(Some(&env), tier) {
                push(name);
            }
        }
        for key in EXTRA_MODEL_KEYS {
            if let Some(value) = env.get(key).and_then(|v| v.as_str()) {
                if !is_claude_alias(value) {
                    push(strip_context_suffix(value));
                }
            }
        }
        models.sort();
        assert_eq!(models, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
    }
}
