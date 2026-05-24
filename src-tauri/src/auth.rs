use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),
}

impl Serialize for AuthError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    pub uid: String,
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub two_factor_enabled: bool,
}

pub struct ProtonAuth {
    client: reqwest::Client,
    base_url: String,
}

impl ProtonAuth {
    pub fn new(base_url: &str, app_version: &str) -> Result<Self, AuthError> {
        let client = reqwest::Client::builder()
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert(
                    "x-pm-appversion",
                    reqwest::header::HeaderValue::from_str(app_version).map_err(|_| {
                        AuthError::InvalidConfig(format!(
                            "PROTON_APP_VERSION contains invalid header characters: {app_version:?}"
                        ))
                    })?,
                );
                h
            })
            .build()?;

        Ok(Self {
            client,
            base_url: base_url.to_string(),
        })
    }

    pub async fn logout(&self, session: &AuthSession) -> Result<(), AuthError> {
        let _ = self
            .client
            .delete(format!("{}/auth/v4", self.base_url))
            .bearer_auth(&session.access_token)
            .header("x-pm-uid", &session.uid)
            .send()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_succeeds_with_valid_app_version() {
        let result = ProtonAuth::new(
            "https://api.proton.me",
            "external-drive-protondrive-linux@0.1.0-alpha",
        );
        assert!(result.is_ok());
    }

    #[test]
    fn new_returns_error_for_app_version_with_newline() {
        let result = ProtonAuth::new("https://api.proton.me", "version\nnewline");
        assert!(result.is_err());
        let msg = result.err().unwrap().to_string();
        assert!(
            msg.contains("invalid header characters"),
            "expected 'invalid header characters' in error, got: {msg}"
        );
    }

    #[test]
    fn new_returns_error_for_app_version_with_null_byte() {
        let result = ProtonAuth::new("https://api.proton.me", "version\0null");
        assert!(result.is_err());
    }
}
