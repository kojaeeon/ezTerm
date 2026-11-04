# Local file explorer (custom build)

Use the **Local files** button above the terminal tabs to open the local file
browser. It is available without an active terminal session and can remain
beside the SSH/SFTP view.

- Click a drive, use Home, or enter an absolute folder/UNC path and press Enter.
- Double-click a folder, or focus its row and press Enter, to enter it.
- Back, Forward, Up, Refresh, and the folder picker provide navigation.
- Filter matches names in the current folder. Hidden includes Windows hidden
  attributes and dotfiles.
- Click a file to see its size and modification time. Copy path copies the
  selected item's path, or the current folder when nothing is selected.
- Drag the right edge to resize. The last visited directory is remembered.
- Use the arrow next to Home to choose a home folder, use the current folder,
  or restore the default user home. Right-clicking Home opens the same menu.
- The address bar's star adds or removes the current folder from the bookmarks
  bar. Click a bookmark to navigate; right-click to rename, reorder, remove,
  open in Windows Explorer, or make it Home. Preferences persist locally.
- Right-click a file, folder, or the empty list background for Windows Explorer.
  Files open their containing folder; folder entries open that folder directly.
- File and folder icons come from the Windows shell, including associated apps
  and executables' own icons. Visible rows load first in small batches; results
  are cached. A generic icon remains if the shell cannot provide one.

Right-click a row for **파일 경로 복사**, **파일 복사**, and **열기 / 실행**.
File copy puts the file on the Windows clipboard for Ctrl+V in Explorer;
Open uses the registered Windows application, including normal execution for
executables. Double-clicking a file also opens it.

Drag an individual file from this panel onto a connected local PowerShell or
CMD terminal to copy it into that shell's current folder. A drop highlight shows
the destination. Existing files are never overwritten. Folder drags and external
Explorer-to-terminal drags are not included in this custom interaction.

Reconnect local tabs after upgrading so their prompts report the current folder.
The app installs a per-session prompt wrapper; no profile files are edited.
Unsupported shells, non-filesystem PowerShell locations, and unavailable current
folders cause an error rather than guessing a destination. A copy uses the most
recent prompt's folder, captured at the instant of the drop.

Existing SFTP upload/download actions remain in the SFTP pane.

Backend directory enumeration runs on a blocking worker, and the IPC commands
require the vault to be unlocked. Navigation discards stale responses so a slow
folder request cannot replace a newer one.

This is a local modification of upstream 1.15.0. Installing an upstream update
may replace the custom executable and remove this panel.

## Validation

The bookmark parser tests cover persisted home, renamed favorites, malformed
storage, and case-insensitive Windows path deduplication. Native tests obtain
and decode transparent PNGs for a folder, a Unicode-named text file, and an EXE.
A browser fixture with a mocked filesystem verifies bookmarking, renaming,
home navigation, persisted state after reload, and context-menu layout.
The fixture is removed before release builds and is not part of the application.
