use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::extract::FromRef;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;

use super::state::RemoteServerState;

/// 生成 6 位 PIN
pub fn generate_pin() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen_range(0..1000000))
}

/// 验证 PIN 是否匹配且未过期
pub fn verify_pin(input_pin: &str, config_pin: &str, expires_at: Option<SystemTime>) -> bool {
    if input_pin != config_pin {
        return false;
    }
    match expires_at {
        Some(exp) => SystemTime::now() < exp,
        None => false,
    }
}

/// 生成 UUID v4 token
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// PIN 过期时间：5 分钟
pub fn pin_expiry() -> SystemTime {
    SystemTime::now() + Duration::from_secs(300)
}

/// Token 验证提取器
/// 从请求头 Authorization: Bearer <token> 中提取并验证 token
pub struct AuthToken(pub String);

impl<S> FromRequestParts<S> for AuthToken
where
    Arc<RemoteServerState>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = (StatusCode, String);

    fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let remote_state = Arc::<RemoteServerState>::from_ref(state);

        let auth_header = parts
            .headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.to_string());

        async move {
            let token = auth_header
                .ok_or((StatusCode::UNAUTHORIZED, "Missing token".to_string()))?;

            // 从内存缓存验证 token（不查 SQLite）
            if remote_state.paired_devices.contains_key(&token) {
                Ok(AuthToken(token))
            } else {
                Err((StatusCode::UNAUTHORIZED, "Invalid token".to_string()))
            }
        }
    }
}
