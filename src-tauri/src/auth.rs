use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use num_bigint::BigUint;
use num_traits::Zero;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use thiserror::Error;

const MODULUS_SIZE: usize = 256; // 2048-bit

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Nettverksfeil: {0}")]
    Network(#[from] reqwest::Error),
    #[error("SRP error: {0}")]
    Srp(String),
    #[error("API error {code}: {message}")]
    Api { code: u32, message: String },
    #[error("Invalid username or password")]
    InvalidCredentials,
    #[error("2FA required")]
    #[allow(dead_code)]
    TwoFactorRequired,
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

// Raw auth info from /auth/v4/info
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AuthInfoResponse {
    modulus: String,        // PGP-signed message containing base64(N)
    server_ephemeral: String, // base64(B)
    salt: String,           // base64(SRP salt)
    #[serde(rename = "SRPSession")]
    srp_session: String,
    version: u32,
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

    pub async fn authenticate(
        &self,
        username: &str,
        password: &str,
    ) -> Result<AuthSession, AuthError> {
        let info = self.get_auth_info(username).await?;

        let n_bytes = extract_modulus_bytes(&info.modulus)?;
        let salt_bytes = BASE64
            .decode(&info.salt)
            .map_err(|e| AuthError::Srp(format!("Ugyldig salt: {e}")))?;
        let b_bytes = BASE64
            .decode(&info.server_ephemeral)
            .map_err(|e| AuthError::Srp(format!("Ugyldig server ephemeral: {e}")))?;

        let (a_bytes, m1_bytes) =
            compute_srp_proof(username, password, info.version, &salt_bytes, &b_bytes, &n_bytes)?;

        let body = serde_json::json!({
            "Username": username,
            "ClientEphemeral": BASE64.encode(&a_bytes),
            "ClientProof": BASE64.encode(&m1_bytes),
            "SRPSession": info.srp_session,
        });

        let resp: serde_json::Value = self
            .client
            .post(format!("{}/auth/v4", self.base_url))
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let code = resp["Code"].as_u64().unwrap_or(0) as u32;
        match code {
            1000 => Ok(AuthSession {
                uid: resp["UID"].as_str().unwrap_or("").to_string(),
                access_token: resp["AccessToken"].as_str().unwrap_or("").to_string(),
                refresh_token: resp["RefreshToken"].as_str().unwrap_or("").to_string(),
                user_id: resp["UserID"].as_str().unwrap_or("").to_string(),
                two_factor_enabled: resp["2FA"]["Enabled"].as_u64().unwrap_or(0) & 1 != 0,
            }),
            8002 | 8004 => Err(AuthError::InvalidCredentials),
            _ => Err(AuthError::Api {
                code,
                message: resp["Error"].as_str().unwrap_or("Ukjent feil").to_string(),
            }),
        }
    }

    pub async fn verify_2fa(&self, session: &AuthSession, totp_code: &str) -> Result<(), AuthError> {
        let body = serde_json::json!({ "TwoFactorCode": totp_code });

        let resp: serde_json::Value = self
            .client
            .post(format!("{}/auth/v4/2fa", self.base_url))
            .bearer_auth(&session.access_token)
            .header("x-pm-uid", &session.uid)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let code = resp["Code"].as_u64().unwrap_or(0) as u32;
        if code == 1000 {
            Ok(())
        } else {
            Err(AuthError::Api {
                code,
                message: resp["Error"].as_str().unwrap_or("Ugyldig 2FA-kode").to_string(),
            })
        }
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

    async fn get_auth_info(&self, username: &str) -> Result<AuthInfoResponse, AuthError> {
        let resp: serde_json::Value = self
            .client
            .post(format!("{}/auth/v4/info", self.base_url))
            .json(&serde_json::json!({ "Username": username, "Intent": "Proton" }))
            .send()
            .await?
            .json()
            .await?;

        let code = resp["Code"].as_u64().unwrap_or(0) as u32;
        if code != 1000 {
            return Err(AuthError::Api {
                code,
                message: resp["Error"].as_str().unwrap_or("Ukjent feil").to_string(),
            });
        }

        serde_json::from_value(resp).map_err(|e| AuthError::Srp(format!("Parse-feil: {e}")))
    }
}

// --- SRP computation ---

fn compute_srp_proof(
    username: &str,
    password: &str,
    version: u32,
    salt: &[u8],
    b_bytes: &[u8],
    n_bytes: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), AuthError> {
    let n = BigUint::from_bytes_be(n_bytes);
    let g = BigUint::from(2u32);

    // k = SHA512(pad(N) || pad(g))
    let k = {
        let mut h = Sha512::new();
        h.update(pad_to(n_bytes, MODULUS_SIZE));
        h.update(pad_to(&g.to_bytes_be(), MODULUS_SIZE));
        BigUint::from_bytes_be(&h.finalize())
    };

    // x = SHA512(salt || H(username ":" password_hash))
    let password_hash = hash_password(username, password, salt, version)?;
    let x = {
        let inner: Vec<u8> = {
            let mut h = Sha512::new();
            h.update(username.to_lowercase().as_bytes());
            h.update(b":");
            h.update(&password_hash);
            h.finalize().to_vec()
        };
        let mut h = Sha512::new();
        h.update(salt);
        h.update(&inner);
        BigUint::from_bytes_be(&h.finalize())
    };

    // a (random 256-bit), A = g^a mod N
    let mut a_raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut a_raw);
    let a = BigUint::from_bytes_be(&a_raw) % &n;
    let cap_a = g.modpow(&a, &n);
    let cap_a_bytes = pad_to(&cap_a.to_bytes_be(), MODULUS_SIZE);

    // B (server)
    let cap_b = BigUint::from_bytes_be(b_bytes);
    if cap_b.is_zero() || cap_b >= n {
        return Err(AuthError::Srp("Ugyldig server ephemeral".into()));
    }
    let cap_b_bytes = pad_to(&cap_b.to_bytes_be(), MODULUS_SIZE);

    // u = SHA512(pad(A) || pad(B))
    let u = {
        let mut h = Sha512::new();
        h.update(&cap_a_bytes);
        h.update(&cap_b_bytes);
        BigUint::from_bytes_be(&h.finalize())
    };

    // v = g^x mod N,  kv = k*v mod N
    let v = g.modpow(&x, &n);
    let kv = (&k * &v) % &n;

    // S = (B - k*v mod N)^(a + u*x) mod N
    let bminuskv = if cap_b >= kv {
        &cap_b - &kv
    } else {
        &cap_b + &n - &kv
    };
    let exp = &a + &u * &x;
    let cap_s = bminuskv.modpow(&exp, &n);
    let cap_s_bytes = pad_to(&cap_s.to_bytes_be(), MODULUS_SIZE);

    // M1 = SHA512(pad(A) || pad(B) || pad(S))
    let m1: Vec<u8> = {
        let mut h = Sha512::new();
        h.update(&cap_a_bytes);
        h.update(&cap_b_bytes);
        h.update(&cap_s_bytes);
        h.finalize().to_vec()
    };

    Ok((cap_a_bytes.to_vec(), m1))
}

// Password hash for SRP. Proton V3/V4 uses bcrypt(SHA512(pw), server_salt).
// TODO(SRP-bcrypt): Implement V3/V4 key derivation using bcrypt with the server salt.
//   Reference: WebClients/packages/srp/lib/passwords.ts → getPasswordHash()
//   Requires: bcrypt with a custom salt (first 16 bytes of `salt` param, formatted
//   as a bcrypt salt string "$2y$10$<bcrypt_base64(salt[..16])>").
//   Current fallback (SHA512 only) compiles but will NOT authenticate with Proton.
fn hash_password(
    _username: &str,
    password: &str,
    salt: &[u8],
    version: u32,
) -> Result<Vec<u8>, AuthError> {
    match version {
        4 | 3 => {
            // Correct V4/V3:
            //   step1 = SHA512(password)               → [u8; 64]
            //   step2 = bcrypt(step1[..72], bcrypt_salt) → String
            //   result = SHA512(step2)
            //
            // FIXME: Replace with bcrypt step once a Rust crate exposes
            // hash_with_salt(password: &[u8], cost: u32, salt: [u8; 16]).
            // Tracking issue: see PLAN.md Phase 1 notes.
            let step1: Vec<u8> = Sha512::digest(password.as_bytes()).to_vec();
            let combined = [salt, &step1].concat();
            Ok(Sha512::digest(&combined).to_vec())
        }
        0 | 1 | 2 => {
            // Older versions: plain SHA512 of username:password
            let input = format!("{}:{}", _username.to_lowercase(), password);
            Ok(Sha512::digest(input.as_bytes()).to_vec())
        }
        _ => Err(AuthError::Srp(format!("Ukjent SRP-versjon: {version}"))),
    }
}

// Proton signs the modulus in a PGP message to prevent MITM substitution.
// TODO(SRP-modulus): Verify the PGP signature against Proton's public key.
fn extract_modulus_bytes(pgp_message: &str) -> Result<Vec<u8>, AuthError> {
    let mut collecting = false;
    let mut b64 = String::new();

    for line in pgp_message.lines() {
        if line.starts_with("-----BEGIN PGP SIGNED MESSAGE-----")
            || line.starts_with("Hash:")
        {
            collecting = false;
            continue;
        }
        if line.starts_with("-----BEGIN PGP SIGNATURE-----") {
            break;
        }
        if !collecting && line.is_empty() {
            collecting = true;
            continue;
        }
        if collecting && !line.is_empty() {
            b64.push_str(line.trim());
        }
    }

    BASE64
        .decode(&b64)
        .map_err(|e| AuthError::Srp(format!("Ugyldig modulus: {e}")))
}

fn pad_to(bytes: &[u8], target: usize) -> Vec<u8> {
    if bytes.len() >= target {
        bytes[bytes.len() - target..].to_vec()
    } else {
        let mut padded = vec![0u8; target - bytes.len()];
        padded.extend_from_slice(bytes);
        padded
    }
}
