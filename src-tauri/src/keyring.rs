use std::collections::HashMap;
use secret_service::{EncryptionType, SecretService};
use thiserror::Error;

use crate::auth::AuthSession;

const APP_ATTR: &str = "proton-drive-sync";
const LABEL: &str = "Proton Drive Sync — session";

#[derive(Debug, Error)]
pub enum KeyringError {
    #[error("Secret Service error: {0}")]
    SecretService(#[from] secret_service::Error),
    #[error("Serialization error: {0}")]
    Serialize(#[from] serde_json::Error),
}

impl serde::Serialize for KeyringError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub async fn store_session(session: &AuthSession) -> Result<(), KeyringError> {
    let ss = SecretService::connect(EncryptionType::Dh).await?;
    let collection = ss.get_default_collection().await?;
    collection.unlock().await?;

    let secret = serde_json::to_vec(session)?;
    let attrs = session_attrs();

    collection
        .create_item(LABEL, attrs, &secret, true, "application/json")
        .await?;

    Ok(())
}

pub async fn load_session() -> Option<AuthSession> {
    let ss = SecretService::connect(EncryptionType::Dh).await.ok()?;
    let collection = ss.get_default_collection().await.ok()?;
    collection.unlock().await.ok()?;

    let items = collection.search_items(session_attrs()).await.ok()?;
    let item = items.first()?;
    let bytes = item.get_secret().await.ok()?;

    serde_json::from_slice(&bytes).ok()
}

pub async fn clear_session() -> Result<(), KeyringError> {
    let ss = SecretService::connect(EncryptionType::Dh).await?;
    let collection = ss.get_default_collection().await?;
    collection.unlock().await?;

    let items = collection.search_items(session_attrs()).await?;
    for item in items {
        item.delete().await?;
    }

    Ok(())
}

fn session_attrs() -> HashMap<&'static str, &'static str> {
    HashMap::from([("application", APP_ATTR), ("type", "session")])
}

// ── Key password ─────────────────────────────────────────────────────────────

const KEY_PASSWORD_LABEL: &str = "Proton Drive Sync — key password";

fn key_password_attrs() -> HashMap<&'static str, &'static str> {
    HashMap::from([("application", APP_ATTR), ("type", "key_password")])
}

pub async fn store_key_password(key_password: &str) -> Result<(), KeyringError> {
    let ss = SecretService::connect(EncryptionType::Dh).await?;
    let collection = ss.get_default_collection().await?;
    collection.unlock().await?;
    collection
        .create_item(KEY_PASSWORD_LABEL, key_password_attrs(), key_password.as_bytes(), true, "text/plain")
        .await?;
    Ok(())
}

pub async fn load_key_password() -> Option<String> {
    let ss = SecretService::connect(EncryptionType::Dh).await.ok()?;
    let collection = ss.get_default_collection().await.ok()?;
    collection.unlock().await.ok()?;
    let items = collection.search_items(key_password_attrs()).await.ok()?;
    let item = items.first()?;
    let bytes = item.get_secret().await.ok()?;
    String::from_utf8(bytes).ok()
}

pub async fn clear_key_password() -> Result<(), KeyringError> {
    let ss = SecretService::connect(EncryptionType::Dh).await?;
    let collection = ss.get_default_collection().await?;
    collection.unlock().await?;
    let items = collection.search_items(key_password_attrs()).await?;
    for item in items {
        item.delete().await?;
    }
    Ok(())
}
