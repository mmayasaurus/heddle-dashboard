use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Ensure a self-signed TLS certificate exists in the data directory, reading an existing one or generating it.
/// Return (cert_pem, key_pem) bytes.
pub fn ensure_cert(data_dir: &Path, lan_ips: &[String]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let tls_dir = data_dir.join("tls");
    let cert_path = tls_dir.join("cert.pem");
    let key_path = tls_dir.join("key.pem");

    if cert_path.exists() && key_path.exists() {
        let cert =
            std::fs::read(&cert_path).map_err(|e| format!("Failed to read certificate: {e}"))?;
        let key =
            std::fs::read(&key_path).map_err(|e| format!("Failed to read private key: {e}"))?;
        return Ok((cert, key));
    }

    let mut params = rcgen::CertificateParams::new(vec!["localhost".into()])
        .map_err(|e| format!("Invalid certificate parameters: {e}"))?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "heddle");
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    for ip_str in lan_ips {
        if let Ok(ip) = ip_str.parse::<IpAddr>() {
            params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
        }
    }

    let key_pair =
        rcgen::KeyPair::generate().map_err(|e| format!("Failed to generate key pair: {e}"))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("Failed to generate self-signed certificate: {e}"))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    std::fs::create_dir_all(&tls_dir)
        .map_err(|e| format!("Failed to create TLS directory: {e}"))?;
    std::fs::write(&cert_path, &cert_pem)
        .map_err(|e| format!("Failed to write certificate: {e}"))?;
    std::fs::write(&key_path, &key_pem).map_err(|e| format!("Failed to write private key: {e}"))?;

    Ok((cert_pem.into_bytes(), key_pem.into_bytes()))
}

/// Compute the certificate's SHA-256 fingerprint as uppercase colon-separated hexadecimal, matching browser
/// certificate viewers so users can compare it segment by segment. Return None on parse failure.
pub fn fingerprint_sha256(cert_pem: &[u8]) -> Option<String> {
    let parsed = pem::parse(cert_pem).ok()?;
    let digest = Sha256::digest(parsed.contents());
    Some(
        digest
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}
