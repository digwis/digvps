//! Secret storage.
//!
//! - New secrets (`enc2:`): AES-256-GCM with a random key kept in the OS keychain
//!   (service `OpenVPS`, account `secrets-key`).
//! - Legacy secrets (`enc:`): written by the Electron app via `safeStorage.encryptString`.
//!   On macOS that is AES-128-CBC with a PBKDF2-HMAC-SHA1 key derived from a random
//!   password stored in the login keychain as "<AppName> Safe Storage". We implement
//!   the same derivation so existing rows keep decrypting after migration.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::sync::{LazyLock, Mutex};

const ENC_PREFIX: &str = "enc:";
const ENC2_PREFIX: &str = "enc2:v1:";
// Intentionally keeps the legacy "OpenVPS" keychain service so existing enc2:
// secrets remain readable after the DigVPS rename.
const KEYCHAIN_SERVICE: &str = "OpenVPS";
const KEYCHAIN_ACCOUNT: &str = "secrets-key";

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn keyring_entry(service: &str, account: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(service, account).ok()
}

fn read_keychain_password(service: &str, account: &str) -> Option<Vec<u8>> {
    keyring_entry(service, account)
        .and_then(|entry| entry.get_password().ok())
        .map(|s| s.into_bytes())
}

static ENC2_KEY: LazyLock<Option<[u8; 32]>> = LazyLock::new(|| {
    if let Some(raw) = read_keychain_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        if let Ok(hex_str) = std::str::from_utf8(&raw) {
            if let Ok(bytes) = hex::decode(hex_str.trim()) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    return Some(key);
                }
            }
        }
    }
    // Generate a fresh key and persist it.
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let entry = keyring_entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)?;
    entry.set_password(&hex::encode(key)).ok()?;
    Some(key)
});

/// Encrypt with AES-256-GCM; returns `enc2:v1:<base64(nonce|ct+tag)>`.
pub fn encrypt_secret(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let Some(key) = *ENC2_KEY else {
        // Keychain unavailable — store plaintext rather than failing the save.
        return value.to_string();
    };
    let cipher = Aes256Gcm::new_from_slice(&key).expect("valid aes256 key");
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    match cipher.encrypt(nonce, value.as_bytes()) {
        Ok(mut ct) => {
            let mut buf = Vec::with_capacity(12 + ct.len());
            buf.extend_from_slice(&nonce_bytes);
            buf.append(&mut ct);
            format!("{}{}", ENC2_PREFIX, b64().encode(buf))
        }
        Err(_) => value.to_string(),
    }
}

// Chromium OSCrypt on macOS: keychain item "<AppName> Safe Storage" / "<AppName> Key".
// Dev builds used "Electron Safe Storage"; packaged builds use the product name,
// and this app's productName changed over time (digwis-panel/CloudRoost/OpenVPS/DigVPS).
// Ordered most-recent-name-first so the entry that actually wrote the rows wins early.
const SAFE_STORAGE_CANDIDATES: &[(&str, &str)] = &[
    ("OpenVPS Safe Storage", "OpenVPS Key"),
    ("openvps Safe Storage", "openvps Key"),
    ("digwis-panel Safe Storage", "digwis-panel Key"),
    ("CloudRoost Safe Storage", "CloudRoost Key"),
    ("Electron Safe Storage", "Electron"),
    ("Electron Safe Storage", "Electron Key"),
];

/// The Electron key that successfully decrypted a row — cached so later
/// decryptions skip the keychain sweep entirely (each uncached read can cost
/// a keychain ACL prompt on unsigned builds).
static GOOD_ELECTRON_KEY: LazyLock<Mutex<Option<[u8; 16]>>> =
    LazyLock::new(|| Mutex::new(None));

fn decrypt_with_key(key: &[u8; 16], ct: &[u8]) -> Option<String> {
    let iv = [0x20u8; 16]; // sixteen spaces — OSCrypt IV on macOS
    Aes128CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(ct)
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
}

fn decrypt_electron_enc(value: &str) -> Option<String> {
    let raw = b64().decode(value.trim()).ok()?;
    // Chromium may prepend the "v10" version prefix.
    let ct: &[u8] = if raw.starts_with(b"v10") { &raw[3..] } else { &raw[..] };
    if ct.is_empty() || ct.len() % 16 != 0 {
        return None;
    }

    let good_key = *GOOD_ELECTRON_KEY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(key) = good_key {
        if let Some(text) = decrypt_with_key(&key, ct) {
            return Some(text);
        }
    }

    for (service, account) in SAFE_STORAGE_CANDIDATES {
        if let Some(password) = read_keychain_password(service, account) {
            // PBKDF2-HMAC-SHA1(password, salt="saltysalt", iter=1003, dklen=16)
            let mut key = [0u8; 16];
            pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&password, b"saltysalt", 1003, &mut key);
            if let Some(text) = decrypt_with_key(&key, ct) {
                *GOOD_ELECTRON_KEY.lock().unwrap_or_else(|p| p.into_inner()) = Some(key);
                return Some(text);
            }
        }
    }
    None
}

/// Decrypt either legacy `enc:` or new `enc2:v1:` payloads; plaintext passes through.
pub fn decrypt_secret(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix(ENC2_PREFIX) {
        let key = (*ENC2_KEY)?;
        let raw = b64().decode(rest).ok()?;
        if raw.len() < 12 + 16 {
            return None;
        }
        let (nonce_bytes, ct) = raw.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(nonce_bytes), ct).ok()?;
        return String::from_utf8(plain).ok();
    }
    if let Some(rest) = value.strip_prefix(ENC_PREFIX) {
        return decrypt_electron_enc(rest);
    }
    Some(value.to_string())
}

// Tiny hex encoder to avoid pulling in another crate for one call site.
mod hex {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let bytes = bytes.as_ref();
        let mut out = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            out.push(CHARS[(b >> 4) as usize] as char);
            out.push(CHARS[(b & 0x0f) as usize] as char);
        }
        out
    }
    pub fn decode(s: &str) -> Result<Vec<u8>, ()> {
        let s = s.as_bytes();
        if s.len() % 2 != 0 {
            return Err(());
        }
        let mut out = Vec::with_capacity(s.len() / 2);
        for pair in s.chunks_exact(2) {
            let hi = (pair[0] as char).to_digit(16).ok_or(())?;
            let lo = (pair[1] as char).to_digit(16).ok_or(())?;
            out.push(((hi << 4) | lo) as u8);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_legacy_electron_blob() {
        // Real `enc:` blob written by the Electron build (digwis connection).
        let blob = "enc:djEwD5EujOZKvlgX9cUr0+9kh3p5aQ5e240ugXoYhh0AgGBsSocjs9L8RhtZRwIEx/1y";
        let out = decrypt_secret(blob).expect("should decrypt");
        eprintln!("decrypted: {:?}", out);
        assert!(!out.is_empty());
    }
}
