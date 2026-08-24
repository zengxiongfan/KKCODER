//! Local MCP bridge for structured AskUserQuestion cards in GUI chat mode.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::{emit_question_requested, log_to_file};

const MCP_SERVER_NAME: &str = "kkcoder";
const ASK_TOOL_NAME: &str = "AskUserQuestion";
const QUESTION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub(super) struct PendingQuestion {
    pub session_id: String,
    pub sender: oneshot::Sender<Result<String, String>>,
}

pub(super) type PendingQuestions = Arc<Mutex<HashMap<String, PendingQuestion>>>;

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    pending: PendingQuestions,
    token: Arc<str>,
}

#[derive(Clone)]
pub(super) struct AskUserMcpServer {
    port: u16,
    token: Arc<str>,
}

impl AskUserMcpServer {
    pub fn config_json(&self, session_id: &str) -> String {
        json!({
            "mcpServers": {
                MCP_SERVER_NAME: {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp/{}", self.port, session_id),
                    "headers": { "Authorization": format!("Bearer {}", self.token) },
                }
            }
        })
        .to_string()
    }

    pub fn allowed_tool_name() -> String {
        format!("mcp__{MCP_SERVER_NAME}__{ASK_TOOL_NAME}")
    }
}

pub(super) fn ensure_started(
    slot: &OnceLock<AskUserMcpServer>,
    app: AppHandle,
    pending: PendingQuestions,
) -> Result<AskUserMcpServer, String> {
    if let Some(server) = slot.get() {
        return Ok(server.clone());
    }

    let listener = std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .map_err(|error| format!("AskUserQuestion MCP 端口绑定失败: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("AskUserQuestion MCP 监听器配置失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("AskUserQuestion MCP 地址读取失败: {error}"))?
        .port();
    let token: Arc<str> = Arc::from(uuid::Uuid::new_v4().simple().to_string());
    let server = AskUserMcpServer {
        port,
        token: Arc::clone(&token),
    };
    let state = ServerState {
        app,
        pending,
        token,
    };

    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                log_to_file(&format!("[claude_chat] MCP runtime 启动失败: {error}"));
                return;
            }
        };
        runtime.block_on(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log_to_file(&format!("[claude_chat] MCP listener 转换失败: {error}"));
                    return;
                }
            };
            let router = Router::new()
                .route("/mcp/{session_id}", post(handle_mcp))
                .with_state(state);
            if let Err(error) = axum::serve(listener, router).await {
                log_to_file(&format!("[claude_chat] MCP server 停止: {error}"));
            }
        });
    });

    let _ = slot.set(server.clone());
    log_to_file(&format!(
        "[claude_chat] AskUserQuestion MCP listening on 127.0.0.1:{port}"
    ));
    Ok(slot.get().cloned().unwrap_or(server))
}

enum McpResponse {
    Json(Value),
    Accepted,
    Unauthorized,
}

impl IntoResponse for McpResponse {
    fn into_response(self) -> axum::response::Response {
        match self {
            Self::Json(value) => (StatusCode::OK, Json(value)).into_response(),
            Self::Accepted => StatusCode::ACCEPTED.into_response(),
            Self::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
        }
    }
}

async fn handle_mcp(
    Path(session_id): Path<String>,
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(message): Json<Value>,
) -> McpResponse {
    if !authorized(&headers, &state.token) {
        return McpResponse::Unauthorized;
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => McpResponse::Json(rpc_result(
            id,
            json!({
                "protocolVersion": message
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
            }),
        )),
        "notifications/initialized" | "notifications/cancelled" => McpResponse::Accepted,
        "tools/list" => McpResponse::Json(rpc_result(id, json!({ "tools": [tool_definition()] }))),
        "tools/call" => {
            let tool_name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if tool_name != ASK_TOOL_NAME {
                return McpResponse::Json(rpc_error(id, -32602, "unknown tool"));
            }
            let arguments = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let questions = normalize_questions(&arguments);
            if questions.as_array().is_none_or(Vec::is_empty) {
                return McpResponse::Json(rpc_error(id, -32602, "questions are required"));
            }
            let request_id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = oneshot::channel();
            {
                let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
                pending.insert(
                    request_id.clone(),
                    PendingQuestion {
                        session_id: session_id.clone(),
                        sender,
                    },
                );
            }
            emit_question_requested(&state.app, &session_id, &request_id, questions);

            let answer = tokio::time::timeout(QUESTION_TIMEOUT, receiver).await;
            state
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            match answer {
                Ok(Ok(Ok(text))) => McpResponse::Json(rpc_result(
                    id,
                    json!({ "content": [{ "type": "text", "text": text }] }),
                )),
                Ok(Ok(Err(error))) => McpResponse::Json(rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": error }],
                        "isError": true
                    }),
                )),
                _ => McpResponse::Json(rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": "AskUserQuestion timed out" }],
                        "isError": true
                    }),
                )),
            }
        }
        _ => McpResponse::Json(rpc_error(id, -32601, "method not found")),
    }
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == token)
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_definition() -> Value {
    json!({
        "name": ASK_TOOL_NAME,
        "description": "Ask the user one or more structured questions and wait for their selection before continuing. Use 2-4 clear options and put the recommended option first.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string" },
                            "header": { "type": "string" },
                            "multiSelect": { "type": "boolean" },
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": { "type": "string" },
                                        "description": { "type": "string" }
                                    },
                                    "required": ["label"]
                                }
                            }
                        },
                        "required": ["question", "options"]
                    }
                }
            },
            "required": ["questions"]
        }
    })
}

pub(super) fn normalize_questions(arguments: &Value) -> Value {
    let questions = arguments
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Value::Array(
        questions
            .into_iter()
            .enumerate()
            .filter_map(|(index, question)| {
                let text = question.get("question")?.as_str()?.trim();
                if text.is_empty() {
                    return None;
                }
                let options = question
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Some(json!({
                    "id": question.get("id").and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("question-{}", index + 1)),
                    "question": text,
                    "header": question.get("header").and_then(Value::as_str).unwrap_or("选择"),
                    "multiSelect": question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                    "options": options,
                }))
            })
            .collect(),
    )
}

pub(super) fn format_answer(result: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(answers) = result.get("answers").and_then(Value::as_object) {
        for (question_id, answer) in answers {
            let values = answer
                .get("answers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if !values.is_empty() {
                parts.push(format!("{question_id}={}", values.join(", ")));
            }
        }
    }
    if parts.is_empty() {
        "The user skipped this AskUserQuestion without selecting an option. Continue using reasonable assumptions and do not ask the same question again.".to_string()
    } else {
        format!(
            "The user answered the AskUserQuestion: {}. Please continue based on this selection.",
            parts.join("; ")
        )
    }
}

pub(super) fn cancel_session_questions(pending: &PendingQuestions, session_id: &str) {
    let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
    let request_ids = pending
        .iter()
        .filter(|(_, question)| question.session_id == session_id)
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    for request_id in request_ids {
        if let Some(question) = pending.remove(&request_id) {
            let _ = question
                .sender
                .send(Err("AskUserQuestion cancelled".to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_question_ids_and_multi_select() {
        let questions = normalize_questions(&json!({
            "questions": [{
                "question": "Pick one",
                "options": [{ "label": "A" }],
                "multiSelect": true
            }]
        }));
        assert_eq!(questions[0]["id"], "question-1");
        assert_eq!(questions[0]["multiSelect"], true);
    }

    #[test]
    fn formats_structured_answers_for_claude() {
        let answer = format_answer(&json!({
            "answers": { "question-1": { "answers": ["A", "B"] } }
        }));
        assert!(answer.contains("question-1=A, B"));
    }
}
