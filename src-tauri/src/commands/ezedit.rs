use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use portable_pty::CommandBuilder;
use russh_sftp::{
    client::{RawSftpSession, error::Error as SftpError},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeResponseBody},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};

use crate::{
    commands::require_unlocked,
    error::{AppError, Result},
    local::spawn_editor,
    sftp::normalise_remote_path,
    state::AppState,
};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const CHUNK: usize = 16 * 1024;
const POSIX_RENAME: &str = "posix-rename@openssh.com";
static SAVE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditEncoding {
    #[serde(rename = "iso-8859-1")]
    Iso8859_1,
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EditOutcome {
    Finished { saved: bool },
    ChooseEncoding { detected: Option<EditEncoding> },
}

async fn detect_encoding(bytes: &[u8]) -> Result<Option<EditEncoding>> {
    let probe = tokio::time::timeout(Duration::from_secs(2), async {
        let mut command = Command::new("file");
        command
            .args(["-b", "--mime-encoding", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn()?;
        let mut input = child.stdin.take().expect("piped stdin");
        // A detector can finish before it consumes the complete sample.
        let output = child.wait_with_output();
        let write = async move {
            let _ = input.write_all(bytes).await;
        };
        let (output, ()) = tokio::join!(output, write);
        output
    })
    .await;
    if let Ok(Ok(output)) = probe
        && output.status.success()
    {
        return match String::from_utf8_lossy(&output.stdout).trim() {
            "iso-8859-1" => Ok(Some(EditEncoding::Iso8859_1)),
            "binary" => Err(binary_error()),
            _ => Ok(None),
        };
    }

    // Portable Windows builds typically do not have file(1). Suggest Latin-1
    // for text-shaped input, and still require the user to confirm it.
    let looks_like_latin1 = bytes
        .iter()
        .all(|byte| matches!(*byte, b'\t' | b'\n' | b'\r' | 0x20..=0x7e | 0xa0..=0xff));
    Ok(looks_like_latin1.then_some(EditEncoding::Iso8859_1))
}

fn binary_error() -> AppError {
    AppError::Validation("ezedit requires a text file".into())
}

fn decode_latin1(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .copied()
        .map(char::from)
        .collect::<String>()
        .into_bytes()
}

fn encode_latin1(bytes: Vec<u8>) -> Result<Vec<u8>> {
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::Validation("Edited copy is not valid UTF-8".into()))?;
    text.chars()
        .map(|character| {
            u8::try_from(u32::from(character)).map_err(|_| {
                AppError::Validation(format!(
                    "ISO-8859-1 cannot store U+{:04X}",
                    u32::from(character)
                ))
            })
        })
        .collect()
}

fn edit_directory() -> Result<tempfile::TempDir> {
    let mut temp = tempfile::Builder::new();
    temp.prefix("ezterm-edit-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.permissions(std::fs::Permissions::from_mode(0o700));
    }
    Ok(temp.tempdir()?)
}

async fn edited_bytes(path: &Path, encoding: Option<EditEncoding>, exit: bool) -> Result<Vec<u8>> {
    check_helix_exit(exit)?;
    // Each Latin-1 byte can occupy up to two bytes in the UTF-8 snapshot.
    let limit = if encoding.is_some() {
        MAX_BYTES * 2
    } else {
        MAX_BYTES
    };
    let mut edited = Vec::new();
    fs::File::open(path)
        .await?
        .take((limit + 1) as u64)
        .read_to_end(&mut edited)
        .await?;
    if edited.len() > limit {
        return Err(AppError::Validation("Edited file exceeds 4 MiB".into()));
    }
    if encoding.is_some() {
        edited = encode_latin1(edited)?;
    }
    if edited.len() > MAX_BYTES {
        return Err(AppError::Validation("Edited file exceeds 4 MiB".into()));
    }
    Ok(edited)
}

fn recover_copy(directory: tempfile::TempDir, name: &Path, error: AppError) -> AppError {
    let recovered = directory.keep().join(name);
    AppError::Validation(format!("{error}. Local copy: {}", recovered.display()))
}

#[tauri::command]
pub async fn ezedit(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: u64,
    path: String,
    encoding: Option<EditEncoding>,
    size: (u16, u16),
    ready: Channel<u64>,
    output: Channel<InvokeResponseBody>,
) -> Result<EditOutcome> {
    require_unlocked(&state).await?;
    let path = normalise_remote_path(&path)?;
    if !path.starts_with('/') {
        return Err(AppError::Validation(
            "ezedit requires an absolute remote path".into(),
        ));
    }
    let helix = helix_directory(&app)?;
    let conn = state
        .ssh
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    let channel = conn
        .ssh_handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(e.to_string()))?;
    let sftp = RawSftpSession::new(channel.into_stream());
    let version = sftp.init().await.map_err(sftp_error)?;
    if version.extensions.get(POSIX_RENAME).map(String::as_str) != Some("1") {
        return Err(AppError::Sftp(
            "ezedit requires SFTP atomic rename support".into(),
        ));
    }
    let target = canonicalize(&sftp, &path).await?;
    let metadata = regular_file(&sftp, &target).await?;
    let original = read_remote(&sftp, &target).await?;
    if original.contains(&0) {
        return Err(binary_error());
    }
    if encoding.is_none() && std::str::from_utf8(&original).is_err() {
        return Ok(EditOutcome::ChooseEncoding {
            detected: detect_encoding(&original).await?,
        });
    }

    let working = edit_directory()?;
    let name = local_name(&path);
    let local_file = working.path().join(&name);
    let snapshot = if encoding.is_some() {
        decode_latin1(&original)
    } else {
        original.clone()
    };
    fs::write(&local_file, &snapshot).await?;
    // Keep language servers off for snapshots downloaded from remote hosts.
    let config = working.path().join("editor-config.toml");
    fs::write(&config, "[editor.lsp]\nenable = false\n").await?;
    let cmd = helix_command(&helix, &local_file, working.path(), Some(&config));
    let exit = run_helix(&state, app, cmd, size, ready, output).await?;

    let result = async {
        let edited = edited_bytes(&local_file, encoding, exit).await?;
        if edited == original {
            return Ok(EditOutcome::Finished { saved: false });
        }
        let _save = SAVE_LOCK.lock().await;
        require_unlocked(&state).await?;
        if state.ssh.get(connection_id).await.is_none() {
            return Err(AppError::ChannelClosed);
        }
        save_remote(&sftp, &path, &target, &metadata, &original, &edited).await?;
        Ok(EditOutcome::Finished { saved: true })
    }
    .await;

    result.map_err(|error| recover_copy(working, &name, error))
}

#[derive(serde::Deserialize)]
pub struct LocalEditFile {
    path: PathBuf,
    cwd: Option<PathBuf>,
}

#[tauri::command]
pub async fn ezedit_local(
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: u64,
    file: LocalEditFile,
    encoding: Option<EditEncoding>,
    size: (u16, u16),
    ready: Channel<u64>,
    output: Channel<InvokeResponseBody>,
) -> Result<EditOutcome> {
    require_unlocked(&state).await?;
    let shell = state
        .local
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    if shell.wsl_meta.is_some() {
        return Err(AppError::Validation(
            "ezedit requires a local shell tab".into(),
        ));
    }
    let document = resolve_local_path(&file.path, file.cwd.as_deref())?;
    let directory = document
        .parent()
        .ok_or_else(|| AppError::Validation("Enter a local file path".into()))?;
    let original = match fs::metadata(&document).await {
        Ok(metadata) if metadata.is_file() => Some(read_local_prefix(&document).await?),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && fs::metadata(directory).await?.is_dir() =>
        {
            None
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {
            return Err(AppError::Validation(
                "ezedit requires a regular file".into(),
            ));
        }
    };
    let helix = helix_directory(&app)?;
    if let Some(original) = original {
        if original.contains(&0) {
            return Err(binary_error());
        }
        if original.len() > MAX_BYTES {
            if encoding.is_some() {
                return Err(latin1_size_error());
            }
            validate_large_local_utf8(&document).await?;
        } else if encoding.is_some() {
            let target = fs::canonicalize(&document).await?;
            let name = Path::new("document").join(document.file_name().ok_or(AppError::NotFound)?);
            let working = edit_directory()?;
            fs::create_dir(working.path().join("document")).await?;
            let snapshot = working.path().join(&name);
            fs::write(&snapshot, decode_latin1(&original)).await?;
            let config = working.path().join("editor-config.toml");
            fs::write(&config, "[editor.lsp]\nenable = false\n").await?;
            let cmd = helix_command(&helix, &snapshot, working.path(), Some(&config));
            let exit = run_helix(&state, app, cmd, size, ready, output).await?;
            let result = async {
                let edited = edited_bytes(&snapshot, encoding, exit).await?;
                if edited != original {
                    let _save = SAVE_LOCK.lock().await;
                    require_unlocked(&state).await?;
                    save_local(&document, &target, &original, &edited).await?;
                }
                Ok(EditOutcome::Finished {
                    saved: edited != original,
                })
            }
            .await;
            return result.map_err(|error| recover_copy(working, &name, error));
        } else if std::str::from_utf8(&original).is_err() {
            return Ok(EditOutcome::ChooseEncoding {
                detected: detect_encoding(&original).await?,
            });
        }
    }
    let cmd = helix_command(&helix, &document, directory, None);
    let exit = run_helix(&state, app, cmd, size, ready, output).await?;
    check_helix_exit(exit)?;
    Ok(EditOutcome::Finished { saved: false })
}

async fn read_local_prefix(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .await?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn latin1_size_error() -> AppError {
    AppError::Validation("ISO-8859-1 files may be up to 4 MiB".into())
}

async fn validate_large_local_utf8(path: &Path) -> Result<()> {
    let mut file = fs::File::open(path).await?;
    let mut buffer = vec![0; CHUNK + 3];
    let mut tail = 0;
    loop {
        let read = file.read(&mut buffer[tail..]).await?;
        if read == 0 {
            return if tail == 0 {
                Ok(())
            } else {
                Err(latin1_size_error())
            };
        }
        let bytes = &buffer[..tail + read];
        if bytes.contains(&0) {
            return Err(binary_error());
        }
        tail = match std::str::from_utf8(bytes) {
            Ok(_) => 0,
            Err(error) if error.error_len().is_some() => return Err(latin1_size_error()),
            Err(error) => {
                let end = bytes.len();
                buffer.copy_within(error.valid_up_to()..end, 0);
                end - error.valid_up_to()
            }
        };
    }
}

async fn save_local(document: &Path, target: &Path, original: &[u8], edited: &[u8]) -> Result<()> {
    let parent = target.parent().ok_or(AppError::NotFound)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    // Respect the original file's write permissions before replacing it.
    std::fs::OpenOptions::new().write(true).open(target)?;
    staged.write_all(edited)?;
    staged
        .as_file()
        .set_permissions(fs::metadata(target).await?.permissions())?;
    staged.as_file().sync_all()?;
    if fs::canonicalize(document).await? != target || read_local_prefix(target).await? != original {
        return Err(AppError::Validation(
            "Local file changed while editing".into(),
        ));
    }
    staged.persist(target).map_err(|error| error.error)?;
    Ok(())
}

fn resolve_local_path(path: &Path, cwd: Option<&Path>) -> Result<PathBuf> {
    if path.file_name().is_none() {
        return Err(AppError::Validation("Enter a local file path".into()));
    }
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    // Drive-relative paths such as D:file use a per-drive working directory
    // that the shell prompt does not report.
    if matches!(
        path.components().next(),
        Some(std::path::Component::Prefix(_))
    ) {
        return Err(AppError::Validation(
            "Enter an absolute path for a drive-qualified filename".into(),
        ));
    }
    let cwd = cwd.filter(|dir| dir.is_absolute()).ok_or_else(|| {
        AppError::Validation(
            "The shell has not reported its current folder. Enter an absolute path or wait for the next prompt.".into(),
        )
    })?;
    Ok(cwd.join(path))
}

fn helix_command(
    helix: &Path,
    document: &Path,
    directory: &Path,
    config: Option<&Path>,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(helix.join(helix_binary()));
    if let Some(config) = config {
        cmd.arg("--config");
        cmd.arg(config);
    }
    cmd.arg(document);
    cmd.cwd(directory);
    cmd.env("TERM", "xterm-256color");
    cmd.env("HELIX_RUNTIME", helix.join("runtime"));
    cmd
}

async fn run_helix(
    state: &AppState,
    app: AppHandle,
    cmd: CommandBuilder,
    size: (u16, u16),
    ready: Channel<u64>,
    output: Channel<InvokeResponseBody>,
) -> Result<bool> {
    let (editor_id, done) = spawn_editor(state, app, cmd, size, output).await?;
    if ready.send(editor_id).is_err() {
        state.local.close(editor_id).await;
    }
    let exit = done.await;
    state.local.close(editor_id).await;
    Ok(matches!(exit, Ok(Ok(status)) if status.success()))
}

fn check_helix_exit(success: bool) -> Result<()> {
    if success {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Helix did not exit successfully".into(),
        ))
    }
}

fn helix_binary() -> &'static str {
    if cfg!(windows) { "hx.exe" } else { "hx" }
}

fn helix_directory(app: &AppHandle) -> Result<PathBuf> {
    let resource_dir = app.path().resource_dir().ok().map(|p| p.join("helix"));
    let portable_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|parent| parent.join("helix")));
    [resource_dir, portable_dir]
        .into_iter()
        .flatten()
        .find(|dir| dir.join(helix_binary()).is_file() && dir.join("runtime").is_dir())
        .ok_or_else(|| {
            AppError::Validation(
                "Helix bundle missing. Use an ezTerm installer or portable package with Helix."
                    .into(),
            )
        })
}

fn local_name(remote: &str) -> PathBuf {
    let name = remote.rsplit('/').next().unwrap_or_default();
    // A local prefix avoids reserved Windows basenames (CON, NUL, etc.).
    // Keep the extension for Helix's language detection.
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim_end_matches(['.', ' ']);
    let candidate = format!("remote-{safe}");
    if candidate.len() <= 240 {
        PathBuf::from(candidate)
    } else {
        PathBuf::from("remote-file")
    }
}

fn sftp_error(error: SftpError) -> AppError {
    AppError::Sftp(error.to_string())
}

async fn canonicalize(sftp: &RawSftpSession, path: &str) -> Result<String> {
    let resolved = sftp
        .realpath(path)
        .await
        .map_err(sftp_error)?
        .files
        .into_iter()
        .next()
        .ok_or(AppError::NotFound)?
        .filename;
    if !resolved.starts_with('/') {
        return Err(AppError::Validation(
            "SFTP returned a non-absolute path".into(),
        ));
    }
    normalise_remote_path(&resolved)
}

async fn regular_file(sftp: &RawSftpSession, path: &str) -> Result<FileAttributes> {
    let attrs = sftp.lstat(path).await.map_err(sftp_error)?.attrs;
    if !attrs.file_type().is_file() {
        return Err(AppError::Validation(
            "ezedit requires an existing regular file".into(),
        ));
    }
    if attrs.len() > MAX_BYTES as u64 {
        return Err(AppError::Validation("Remote file exceeds 4 MiB".into()));
    }
    Ok(attrs)
}

async fn read_remote(sftp: &RawSftpSession, path: &str) -> Result<Vec<u8>> {
    let opened = sftp
        .open(path, OpenFlags::READ, FileAttributes::empty())
        .await
        .map_err(sftp_error)?;
    let result = async {
        let mut bytes = Vec::new();
        loop {
            match sftp
                .read(&opened.handle, bytes.len() as u64, CHUNK as u32)
                .await
            {
                Ok(packet) if packet.data.is_empty() => return Ok(bytes),
                Ok(packet) => {
                    if bytes.len() + packet.data.len() > MAX_BYTES {
                        return Err(AppError::Validation("Remote file exceeds 4 MiB".into()));
                    }
                    bytes.extend(packet.data);
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                    return Ok(bytes);
                }
                Err(error) => return Err(sftp_error(error)),
            }
        }
    }
    .await;
    let closed = sftp.close(opened.handle).await.map_err(sftp_error);
    let bytes = result?;
    closed?;
    Ok(bytes)
}

async fn save_remote(
    sftp: &RawSftpSession,
    path: &str,
    target: &str,
    original_attrs: &FileAttributes,
    original: &[u8],
    edited: &[u8],
) -> Result<()> {
    let (parent, _) = target.rsplit_once('/').ok_or(AppError::NotFound)?;
    let staging = format!("{parent}/.ezterm-{:032x}.tmp", rand::random::<u128>());
    let opened = sftp
        .open(
            &staging,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes {
                permissions: Some(0o600),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(sftp_error)?;

    let result = async {
        let write = async {
            for (index, chunk) in edited.chunks(CHUNK).enumerate() {
                sftp.write(&opened.handle, (index * CHUNK) as u64, chunk.to_vec())
                    .await
                    .map_err(sftp_error)?;
            }
            Ok::<_, AppError>(())
        }
        .await;
        let closed = sftp.close(opened.handle).await.map_err(sftp_error);
        write?;
        closed?;

        let attrs = regular_file(sftp, target).await?;
        if canonicalize(sftp, path).await? != target
            || attrs.permissions != original_attrs.permissions
            || attrs.uid != original_attrs.uid
            || attrs.gid != original_attrs.gid
            || attrs.mtime != original_attrs.mtime
            || read_remote(sftp, target).await? != original
        {
            return Err(AppError::Sftp("Remote file changed while editing".into()));
        }
        // Replacing an inode requires directory write access. Also check
        // that the user can write the original file without truncating it.
        let writable = sftp
            .open(target, OpenFlags::WRITE, FileAttributes::empty())
            .await
            .map_err(sftp_error)?;
        sftp.close(writable.handle).await.map_err(sftp_error)?;
        sftp.setstat(
            &staging,
            FileAttributes {
                uid: attrs.uid,
                gid: attrs.gid,
                permissions: attrs.permissions.map(|mode| mode & 0o7777),
                ..FileAttributes::empty()
            },
        )
        .await
        .map_err(sftp_error)?;

        let mut payload = Vec::new();
        for name in [&staging, target] {
            payload.extend_from_slice(&(name.len() as u32).to_be_bytes());
            payload.extend_from_slice(name.as_bytes());
        }
        match sftp
            .extended(POSIX_RENAME, payload)
            .await
            .map_err(sftp_error)?
        {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => Err(sftp_error(status.into())),
            _ => Err(AppError::Sftp("Unexpected SFTP rename response".into())),
        }
    }
    .await;

    if result.is_err() {
        let _ = sftp.remove(&staging).await;
    }
    result
}

#[cfg(test)]
mod local_path_tests {
    use super::*;

    #[test]
    fn latin1_round_trips_every_byte_and_rejects_unrepresentable_text() {
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(encode_latin1(decode_latin1(&bytes)).unwrap(), bytes);
        assert!(encode_latin1("한글 €".as_bytes().to_vec()).is_err());
    }

    #[tokio::test]
    async fn edited_latin1_is_checked_after_encoding() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("example.txt");
        fs::write(&file, "café".repeat(MAX_BYTES / 4))
            .await
            .unwrap();
        let edited = edited_bytes(&file, Some(EditEncoding::Iso8859_1), true)
            .await
            .unwrap();
        assert_eq!(edited.len(), MAX_BYTES);
        assert_eq!(&edited[..4], b"caf\xe9");
        fs::write(&file, "café €").await.unwrap();
        assert!(
            edited_bytes(&file, Some(EditEncoding::Iso8859_1), true)
                .await
                .is_err()
        );
    }

    #[test]
    fn local_paths_use_the_shell_directory_only_when_needed() {
        let cwd = tempfile::tempdir().unwrap();
        let relative = Path::new("folder with spaces").join("README.md");
        let absolute = cwd.path().join(&relative);
        assert_eq!(
            resolve_local_path(&relative, Some(cwd.path())).unwrap(),
            absolute
        );
        assert_eq!(resolve_local_path(&absolute, None).unwrap(), absolute);
        assert!(resolve_local_path(&relative, None).is_err());
        assert!(resolve_local_path(Path::new("."), Some(cwd.path())).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn local_paths_handle_windows_drive_and_unc_paths() {
        let cwd = Path::new(r"C:\work\dashboard");
        let unc = Path::new(r"\\server\share\readme.md");
        assert_eq!(
            resolve_local_path(Path::new(r".\docs\readme.md"), Some(cwd)).unwrap(),
            cwd.join(r".\docs\readme.md")
        );
        assert_eq!(
            resolve_local_path(Path::new(r"\file.txt"), Some(cwd)).unwrap(),
            Path::new(r"C:\file.txt")
        );
        assert_eq!(resolve_local_path(unc, None).unwrap(), unc);
        assert!(resolve_local_path(Path::new(r"D:readme.md"), Some(cwd)).is_err());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::Stdio};

    #[tokio::test]
    async fn saves_and_detects_remote_conflicts() {
        let Some(server) = crate::sftp::test_server() else {
            assert!(
                std::env::var_os("CI").is_none(),
                "OpenSSH sftp-server missing"
            );
            return;
        };
        let mut child = tokio::process::Command::new(server)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let channel = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
        let sftp = RawSftpSession::new(channel);
        let version = sftp.init().await.unwrap();
        assert_eq!(version.extensions[POSIX_RENAME], "1");

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("원격 file.txt");
        let link = dir.path().join("current");
        fs::write(&file, b"original").await.unwrap();
        fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640))
            .await
            .unwrap();
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let path = link.to_str().unwrap();
        let target = canonicalize(&sftp, path).await.unwrap();
        let attrs = regular_file(&sftp, &target).await.unwrap();
        let original = read_remote(&sftp, &target).await.unwrap();

        save_remote(&sftp, path, &target, &attrs, &original, b"edited")
            .await
            .unwrap();
        assert_eq!(fs::read(&file).await.unwrap(), b"edited");
        assert!(fs::symlink_metadata(&link).await.unwrap().is_symlink());
        assert_eq!(
            fs::metadata(&file).await.unwrap().permissions().mode() & 0o777,
            0o640
        );

        let err = save_remote(&sftp, path, &target, &attrs, &original, b"stale")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Remote file changed"));
        assert_eq!(fs::read(&file).await.unwrap(), b"edited");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
