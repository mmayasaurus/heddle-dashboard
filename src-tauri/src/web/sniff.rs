//! Same-port plaintext HTTP → HTTPS sniffing redirect.
//!
//! The service exposes only one HTTPS port, but users often enter `host:8799` without a scheme. Browsers default
//! to HTTP, which yields only `ERR_INVALID_HTTP_RESPONSE` on a TLS port. Before the TLS handshake, peek at the first
//! byte: pass `0x16` (a TLS handshake record) unchanged to rustls; otherwise treat it as plaintext HTTP, read Host
//! and path, return `301 → https://…`, and disconnect. The browser follows HTTPS automatically, leaving only the
//! self-signed certificate warning for the user to accept.

use std::io;
use std::time::Duration;

use axum_server::accept::Accept;
use futures_util::future::BoxFuture;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Timeout for the first byte so a connected peer that sends nothing cannot hang the connection before the TLS handshake timeout starts.
const PEEK_TIMEOUT: Duration = Duration::from_secs(10);

/// Sniffing acceptor used as `RustlsAcceptor`'s inner layer to access the raw TcpStream before TLS handshaking.
#[derive(Clone, Copy, Debug, Default)]
pub struct HttpSniff;

impl<S> Accept<TcpStream, S> for HttpSniff
where
    S: Send + 'static,
{
    type Stream = TcpStream;
    type Service = S;
    type Future = BoxFuture<'static, io::Result<(TcpStream, S)>>;

    fn accept(&self, stream: TcpStream, service: S) -> Self::Future {
        Box::pin(async move {
            // peek does not consume bytes, so rustls still receives the complete ClientHello on the TLS path.
            let mut first = [0u8; 1];
            let n = tokio::time::timeout(PEEK_TIMEOUT, stream.peek(&mut first))
                .await
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::TimedOut, "timed out waiting for first byte")
                })??;
            // 0x16 is a TLS handshake record; also return n==0 (peer closed) to the TLS layer for normal cleanup.
            if n == 0 || first[0] == 0x16 {
                return Ok((stream, service));
            }

            // Plain HTTP: read enough headers for the request line and Host, return a redirect, then disconnect.
            let mut stream = stream;
            let mut buf = vec![0u8; 2048];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let resp = redirect_response(&head);
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;
            // Return Err so axum-server discards this connection; per-connection accept errors are silent and do not affect the service.
            Err(io::Error::other("plain HTTP request redirected to https"))
        })
    }
}

/// Build a response from request headers: parsed Host/path receives an HTTPS 301; invalid input receives 400 plus guidance.
fn redirect_response(head: &str) -> String {
    match host_and_path(head) {
        Some((host, path)) => format!(
            "HTTP/1.1 301 Moved Permanently\r\n\
             Location: https://{host}{path}\r\n\
             Content-Length: 0\r\n\
             Connection: close\r\n\r\n"
        ),
        None => {
            let body = "This service is HTTPS only; please use https://";
            format!(
                "HTTP/1.1 400 Bad Request\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\r\n{body}",
                body.len()
            )
        }
    }
}

/// Extract (Host, path) from HTTP headers. Validate Host against an allowlist of alphanumerics plus . - : [ ],
/// covering domains/IPv4/IPv6:port and preventing arbitrary bytes from entering response headers. Return None
/// when the request line does not look like HTTP (method not uppercase) or Host is absent.
fn host_and_path(head: &str) -> Option<(String, String)> {
    let mut lines = head.lines();
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let path = parts.next().unwrap_or("/");
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        "/".to_string()
    };
    let host = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        if !k.trim().eq_ignore_ascii_case("host") {
            return None;
        }
        let v = v.trim();
        (!v.is_empty()
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":.-[]".contains(&b)))
        .then(|| v.to_string())
    })?;
    Some((host, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_and_path_parses_typical_request() {
        let head = "GET /login?x=1 HTTP/1.1\r\nUser-Agent: curl\r\nHost: 10.10.10.16:8799\r\n\r\n";
        assert_eq!(
            host_and_path(head),
            Some(("10.10.10.16:8799".into(), "/login?x=1".into()))
        );
    }

    #[test]
    fn host_and_path_rejects_garbage() {
        // Not HTTP, such as a binary protocol that happens to start with visible characters → None.
        assert!(host_and_path("hello world\r\n").is_none());
        // Missing Host → None.
        assert!(host_and_path("GET / HTTP/1.1\r\n\r\n").is_none());
        // Host contains invalid characters (response-header injection guard) → None.
        assert!(host_and_path("GET / HTTP/1.1\r\nHost: a\\r\\nb evil\r\n\r\n").is_none());
    }

    #[test]
    fn redirect_response_builds_301_or_400() {
        let ok = redirect_response("GET /a HTTP/1.1\r\nHost: h:8799\r\n\r\n");
        assert!(ok.starts_with("HTTP/1.1 301"));
        assert!(ok.contains("Location: https://h:8799/a\r\n"));

        let bad = redirect_response("\u{1}\u{2}binary");
        assert!(bad.starts_with("HTTP/1.1 400"));
    }
}
