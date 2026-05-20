use std::collections::HashMap;
use secret_service::{EncryptionType, SecretService};
use thiserror::Error;

use crate::auth::AuthSession;

const APP_ATTR: &str = "proton-drive-sync";
const LABEL: &str = "Proton Drive Sync — session";

#[derive(Debug, Error)]
pub enum KeyringError {
    #[error("Secret Service-feil: {0}")]
    SecretService(#[from] secret_service::Error),
    #[error("Serialiseringsfeil: {0}")]
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
