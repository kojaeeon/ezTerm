//! Local filesystem browser. Listing never launches a shell or executes a file.
use crate::{
    error::{AppError, Result},
    state::AppState,
};
use serde::Serialize;
use std::{path::PathBuf, time::UNIX_EPOCH};
use tauri::State;

#[derive(Serialize)]
pub struct LocalEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: Option<u64>,
    hidden: bool,
}

#[derive(Serialize)]
pub struct LocalListing {
    path: String,
    parent: Option<String>,
    entries: Vec<LocalEntry>,
}

fn display_path(path: &std::path::Path) -> String {
    // Canonical Windows paths use the extended prefix; retain it for I/O,
    // but return normal drive/UNC paths for the address bar and Explorer.
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
}

fn list_directory(path: &str) -> Result<LocalListing> {
    let requested = if path.is_empty() {
        directories::UserDirs::new()
            .ok_or_else(|| AppError::Validation("Home directory unavailable".into()))?
            .home_dir()
            .to_path_buf()
    } else {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err(AppError::Validation("Enter an absolute folder path".into()));
        }
        p
    };
    let directory = std::fs::canonicalize(requested)?;
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&directory)? {
        let item = item?;
        // Unreadable/broken links still appear; do not fail the whole folder.
        let metadata = std::fs::metadata(item.path()).ok();
        let name = item.file_name().to_string_lossy().into_owned();
        let hidden = name.starts_with('.');
        #[cfg(windows)]
        let hidden = hidden
            || metadata.as_ref().is_some_and(|m| {
                use std::os::windows::fs::MetadataExt;
                m.file_attributes() & 2 != 0
            });
        entries.push(LocalEntry {
            name,
            path: display_path(&item.path()),
            is_dir: metadata.as_ref().is_some_and(|m| m.is_dir()),
            size: metadata.as_ref().map_or(0, |m| m.len()),
            modified: metadata
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_secs()),
            hidden,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(LocalListing {
        path: display_path(&directory),
        parent: directory.parent().map(display_path),
        entries,
    })
}

#[tauri::command]
pub async fn local_files_list(state: State<'_, AppState>, path: String) -> Result<LocalListing> {
    super::require_unlocked(&state).await?;
    tokio::task::spawn_blocking(move || list_directory(&path))
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?
}

#[tauri::command]
pub async fn local_files_roots(state: State<'_, AppState>) -> Result<Vec<String>> {
    super::require_unlocked(&state).await?;
    tokio::task::spawn_blocking(|| {
        #[cfg(windows)]
        {
            (b'A'..=b'Z')
                .map(|d| format!("{}:\\", d as char))
                .filter(|p| std::path::Path::new(p).is_dir())
                .collect()
        }
        #[cfg(not(windows))]
        {
            vec!["/".to_owned()]
        }
    })
    .await
    .map_err(|e| AppError::Validation(e.to_string()))
}

#[tauri::command]
pub async fn local_files_icons(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>> {
    super::require_unlocked(&state).await?;
    if paths.len() > 64 {
        return Err(AppError::Validation("At most 64 icons per request".into()));
    }
    tokio::task::spawn_blocking(move || {
        use base64::{Engine, engine::general_purpose::STANDARD};
        paths
            .into_iter()
            .filter_map(|path| {
                let png = crate::local_icons::icon_png(&path)?;
                Some((
                    path,
                    format!("data:image/png;base64,{}", STANDARD.encode(png)),
                ))
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Validation(e.to_string()))
}

#[tauri::command]
pub async fn local_files_explorer(state: State<'_, AppState>, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    tokio::task::spawn_blocking(move || {
        let path = std::fs::canonicalize(path)?;
        let directory = if path.is_dir() {
            path.as_path()
        } else {
            path.parent()
                .ok_or_else(|| AppError::Validation("Folder unavailable".into()))?
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer.exe")
                .arg(display_path(directory))
                .creation_flags(0x08000000)
                .spawn()?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = directory;
            Err(AppError::Validation(
                "Windows Explorer is only available on Windows".into(),
            ))
        }
    })
    .await
    .map_err(|e| AppError::Validation(e.to_string()))?
}

#[tauri::command]
pub async fn local_files_clipboard(state: State<'_, AppState>, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    tokio::task::spawn_blocking(move || {
        let path = std::fs::canonicalize(path)?;
        #[cfg(windows)]
        {
            use clipboard_win::Setter;
            let _clipboard = clipboard_win::Clipboard::new_attempts(10)
                .map_err(|e| AppError::Validation(format!("Windows clipboard: {e}")))?;
            clipboard_win::formats::FileList
                .write_clipboard(&[display_path(&path)])
                .map_err(|e| AppError::Validation(format!("Windows clipboard: {e}")))
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err(AppError::Validation(
                "File clipboard is supported on Windows".into(),
            ))
        }
    })
    .await
    .map_err(|e| AppError::Validation(e.to_string()))?
}

#[tauri::command]
pub async fn local_files_open(state: State<'_, AppState>, path: String) -> Result<()> {
    super::require_unlocked(&state).await?;
    tokio::task::spawn_blocking(move || {
        let path = std::fs::canonicalize(path)?;
        #[cfg(windows)]
        {
            #[link(name = "shell32")]
            unsafe extern "system" {
                fn ShellExecuteW(
                    window: *mut std::ffi::c_void,
                    operation: *const u16,
                    file: *const u16,
                    parameters: *const u16,
                    directory: *const u16,
                    show: i32,
                ) -> isize;
            }
            #[link(name = "ole32")]
            unsafe extern "system" {
                fn CoInitializeEx(reserved: *mut std::ffi::c_void, flags: u32) -> i32;
                fn CoUninitialize();
            }
            let file: Vec<u16> = display_path(&path).encode_utf16().chain(Some(0)).collect();
            let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
            let directory: Vec<u16> = path
                .parent()
                .map(display_path)
                .unwrap_or_default()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // Use Windows' registered open verb, exactly as an Explorer open.
            // There is no command interpreter or interpolated command string.
            let initialized = unsafe { CoInitializeEx(std::ptr::null_mut(), 2) };
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    operation.as_ptr(),
                    file.as_ptr(),
                    std::ptr::null(),
                    directory.as_ptr(),
                    1,
                )
            };
            if initialized >= 0 {
                unsafe {
                    CoUninitialize();
                }
            }
            if result <= 32 {
                return Err(AppError::Validation(format!(
                    "Windows could not open this file (code {result})"
                )));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err(AppError::Validation(
                "Open with the default app is supported on Windows".into(),
            ))
        }
    })
    .await
    .map_err(|e| AppError::Validation(e.to_string()))?
}

fn copy_file(source: &str, directory: &str) -> Result<String> {
    let source = PathBuf::from(source);
    let directory = PathBuf::from(directory);
    if !source.is_absolute() || !directory.is_absolute() {
        return Err(AppError::Validation("Copy requires absolute paths".into()));
    }
    let mut input = std::fs::File::open(&source)?;
    if !input.metadata()?.is_file() {
        return Err(AppError::Validation(
            "Drag individual files, not folders".into(),
        ));
    }
    let directory = std::fs::canonicalize(directory)?;
    if !directory.is_dir() {
        return Err(AppError::Validation(
            "Copy destination is not a folder".into(),
        ));
    }
    let name = source
        .file_name()
        .ok_or_else(|| AppError::Validation("Missing file name".into()))?;
    let destination = directory.join(name);
    // Atomic create_new prevents overwriting even if another copy races us.
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&destination);
        return Err(error.into());
    }
    Ok(display_path(&destination))
}

#[tauri::command]
pub async fn local_files_copy(
    state: State<'_, AppState>,
    connection_id: u64,
    source: String,
    directory: String,
) -> Result<String> {
    super::require_unlocked(&state).await?;
    let connection = state
        .local
        .get(connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    if connection.wsl_meta.is_some() {
        return Err(AppError::Validation(
            "Copy to a local PowerShell or CMD tab".into(),
        ));
    }
    tokio::task::spawn_blocking(move || copy_file(&source, &directory))
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_preserves_content_and_refuses_to_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("한글 space.txt");
        let target = temp.path().join("destination");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(&source, b"original").unwrap();
        let result = copy_file(source.to_str().unwrap(), target.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(&result).unwrap(), b"original");
        std::fs::write(&source, b"replacement").unwrap();
        assert!(copy_file(source.to_str().unwrap(), target.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(&result).unwrap(), b"original");
        assert!(copy_file(target.to_str().unwrap(), temp.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn lists_unicode_files_directories_and_parent() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("한글.txt"), b"hello").unwrap();
        std::fs::create_dir(temp.path().join("Z folder")).unwrap();
        let list = list_directory(temp.path().to_str().unwrap()).unwrap();
        assert_eq!(list.entries.len(), 2);
        assert!(list.entries[0].is_dir);
        assert_eq!(list.entries[1].name, "한글.txt");
        assert_eq!(list.entries[1].size, 5);
        assert!(list.parent.is_some());
        assert!(std::path::Path::new(&list.entries[1].path).is_file());
    }

    #[test]
    fn rejects_relative_and_non_directory_paths() {
        assert!(list_directory("relative/path").is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(list_directory(file.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn displays_windows_paths_without_changing_unc_roots() {
        assert_eq!(
            display_path(std::path::Path::new(r"\\?\C:\Users\test")),
            r"C:\Users\test"
        );
        assert_eq!(
            display_path(std::path::Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
    }
}
