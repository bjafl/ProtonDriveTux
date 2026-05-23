use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
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
                    reqwest::header::HeaderValue::from_str(app_version).unwrap(),
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
