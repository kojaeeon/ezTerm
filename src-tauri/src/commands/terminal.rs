//! Commands that apply to any terminal connection, SSH or local PTY.

use tauri::State;

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Save a user-selected terminal snapshot as UTF-8 on this computer, including
/// for SSH tabs. The frontend obtains the path through the native save dialog.
#[tauri::command]
pub async fn terminal_save_log(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<()> {
    super::require_unlocked(&state).await?;
    if !std::path::Path::new(&path).is_absolute() {
        return Err(AppError::Validation(
            "Choose an absolute log file path".into(),
        ));
    }
    tokio::fs::write(path, content.as_bytes()).await?;
    Ok(())
}

/// Chunks the backend has pushed into a connection's output channel. The
/// frontend's stall watchdog (lib/ssh.ts) compares this with what it has
/// received. `not_found` once the connection is gone, which tells the
/// watchdog to stop.
#[tauri::command]
pub async fn terminal_output_sent(state: State<'_, AppState>, connection_id: u64) -> Result<u64> {
    state
        .output_sent(connection_id)
        .await
        .ok_or(AppError::NotFound)
}
