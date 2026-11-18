pub mod registry;
pub mod session;
pub mod transfer;
pub mod upload_stream;

pub use registry::{FileBrowser, SftpRegistry};
#[allow(unused_imports)] // re-exports consumed by Bundle 2 command modules
pub use session::{SftpHandle, normalise_remote_path};

#[cfg(all(test, unix))]
pub(crate) fn test_server() -> Option<String> {
    if let Ok(p) = std::env::var("EZTERM_SFTP_SERVER") {
        return Some(p);
    }
    [
        "/usr/lib/openssh/sftp-server",
        "/usr/libexec/openssh/sftp-server",
        "/usr/libexec/sftp-server",
        "/usr/lib/ssh/sftp-server",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).exists())
    .map(str::to_string)
}
