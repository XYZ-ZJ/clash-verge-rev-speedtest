use crate::{
    config::{Config, IClashTemp, IProfiles, IVerge},
    core::{CoreManager, backup, proxy_control, proxy_control::SystemProxyStateUnknown},
    process::AsyncHandler,
    utils::{
        dirs::{PathBufExec as _, app_home_dir, local_backup_dir, verge_path},
        help,
    },
};
use anyhow::{Result, anyhow};
use chrono::Utc;
use clash_verge_logging::{Type, logging};
use reqwest_dav::list_cmd::ListFile;
use serde::Serialize;
use smartstring::alias::String;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Serialize, specta::Type)]
pub struct LocalBackupFile {
    #[specta(type = std::string::String)]
    pub filename: String,
    #[specta(type = std::string::String)]
    pub path: String,
    #[specta(type = std::string::String)]
    pub last_modified: String,
    pub content_length: u64,
}

/// Backup filenames arrive from the frontend. Only accept a plain
/// single-segment name so a crafted value can neither traverse out of the
/// local backup directory nor out of the WebDAV server's backup folder.
fn validate_backup_name(filename: &str) -> Result<()> {
    use std::path::{Component, Path};

    if filename.is_empty()
        || filename == "."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
    {
        return Err(anyhow!("invalid backup filename: {filename:?}"));
    }

    let mut components = Path::new(filename).components();
    match components.next() {
        Some(Component::Normal(seg)) if seg == filename && components.next().is_none() => Ok(()),
        _ => Err(anyhow!("invalid backup filename structure: {filename:?}")),
    }
}

fn sanitize_restored_verge(
    restored: &mut IVerge,
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
) {
    restored.webdav_url = webdav_url;
    restored.webdav_username = webdav_username;
    restored.webdav_password = webdav_password;
    if restored.startup_script.take().is_some() {
        logging!(
            warn,
            Type::Backup,
            "Stripped startup_script from restored backup for safety"
        );
    }
    if let Some(theme_setting) = restored.theme_setting.as_mut()
        && theme_setting.css_injection.take().is_some()
    {
        logging!(
            warn,
            Type::Backup,
            "Stripped theme_setting.css_injection from restored backup for safety"
        );
    }
    if let Some(core) = restored.clash_core.as_deref()
        && !IVerge::VALID_CLASH_CORES.contains(&core.trim())
    {
        logging!(
            warn,
            Type::Backup,
            "Reset invalid clash_core '{core}' from restored backup to default"
        );
        restored.clash_core = Some("verge-mihomo".into());
    }
}

fn sanitize_restored_profiles(restored_profiles: &mut IProfiles) {
    if let Some(items) = restored_profiles.items.as_mut() {
        for item in items.iter_mut() {
            if let Some(file) = item.file.as_deref()
                && validate_backup_name(file).is_err()
            {
                logging!(
                    warn,
                    Type::Backup,
                    "Cleared unsafe profile file reference '{file}' from restored backup"
                );
                item.file = None;
            }
        }
    }
}

/// Reloads restored configs into memory while preserving WebDAV credentials
/// and stripping executable startup/CSS injection fields from untrusted archives.
async fn finalize_restored_verge_config(
    config_write: tokio::sync::MutexGuard<'_, ()>,
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
) -> Result<()> {
    // A broken restored `verge.yaml` is a restore failure, not a reason to load defaults.
    let mut restored = help::read_yaml::<IVerge>(&verge_path()?).await?;
    sanitize_restored_verge(&mut restored, webdav_url, webdav_username, webdav_password);
    restored.save_file().await?;

    let mut restored_profiles = IProfiles::new().await;
    sanitize_restored_profiles(&mut restored_profiles);
    restored_profiles.save_file().await?;

    let restored_clash = IClashTemp::new().await;
    let clash_draft = Config::clash().await;
    let profiles_draft = Config::profiles().await;
    let verge_draft = Config::verge().await;
    let transaction = clash_verge_draft::DraftTransaction::begin(vec![&clash_draft, &profiles_draft, &verge_draft])?;

    clash_draft.edit_draft(|d| {
        *d = restored_clash;
    });
    profiles_draft.edit_draft(|d| {
        *d = restored_profiles;
    });
    verge_draft.edit_draft(|d| {
        *d = restored.clone();
    });

    // Turn it off here; a failing core side effect below would otherwise skip this step.
    if !restored.enable_system_proxy.unwrap_or_default() {
        let result = async {
            let _lifecycle = CoreManager::global().lifecycle_lock.lock().await;
            proxy_control::apply().await?;
            proxy_control::refresh_guard().await
        }
        .await;
        if let Err(err) = result {
            logging!(error, Type::Backup, "Failed to turn the system proxy off: {err:#}");
            if SystemProxyStateUnknown::is_in(&err) {
                return Err(err);
            }
        }
    }

    transaction.commit();

    // `patch_verge` re-acquires the configuration write lock.
    drop(config_write);

    // Run configuration side effects without rewriting the already-restored file.
    if let Err(err) = super::patch_verge(&restored, true).await {
        logging!(error, Type::Backup, "Failed to apply restored verge config: {err:#}");
        // Propagate unknown proxy state; ordinary side-effect failures stay logged.
        if SystemProxyStateUnknown::is_in(&err) {
            return Err(err);
        }
    }
    Ok(())
}

#[tracing::instrument(skip_all, level = "info")]
pub async fn create_backup_and_upload_webdav() -> Result<()> {
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create backup: {err:#}");
        err
    })?;

    if let Err(err) = backup::WebDavClient::global()
        .upload(temp_file_path.clone(), file_name)
        .await
    {
        logging!(error, Type::Backup, "Failed to upload to WebDAV: {err:#}");
        let _ = temp_file_path.remove_if_exists().await;
        backup::WebDavClient::global().reset();
        return Err(err);
    }

    if let Err(err) = temp_file_path.remove_if_exists().await {
        logging!(warn, Type::Backup, "Failed to remove temp file: {err:#}");
    }

    Ok(())
}

pub async fn list_webdav_backup() -> Result<Vec<ListFile>> {
    backup::WebDavClient::global().list().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to list WebDAV backup files: {err:#}");
        err
    })
}

pub async fn delete_webdav_backup(filename: String) -> Result<()> {
    validate_backup_name(filename.as_str())?;
    let name = filename.to_string();
    backup::WebDavClient::global().delete(filename).await.map_err(|err| {
        logging!(
            error,
            Type::Backup,
            "Failed to delete WebDAV backup file {name}: {err:#}"
        );
        err
    })
}

const MAX_BACKUP_ENTRIES: usize = 2048;
const MAX_BACKUP_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

fn is_allowed_backup_rel_path(rel_path: &std::path::Path, is_dir: bool) -> bool {
    use crate::utils::dirs;
    use std::path::Component;

    let parts: Vec<&str> = rel_path
        .components()
        .filter_map(|c| match c {
            Component::Normal(os) => os.to_str(),
            _ => None,
        })
        .collect();

    if parts.len() != rel_path.components().count() || parts.is_empty() {
        return false;
    }

    match (parts.as_slice(), is_dir) {
        (["profiles"] | ["icons"], true) => true,
        ([single], false) => [
            dirs::CLASH_CONFIG,
            dirs::VERGE_CONFIG,
            dirs::PROFILE_YAML,
            crate::constants::files::DNS_CONFIG,
        ]
        .contains(single),
        (["profiles" | "icons", file_name], false) => validate_backup_name(file_name).is_ok(),
        _ => false,
    }
}

fn validate_backup_archive_name(filename: &str) -> Result<()> {
    validate_backup_name(filename)?;
    if !filename.to_ascii_lowercase().ends_with(".zip") {
        return Err(anyhow!("backup archive must be a .zip file: {filename:?}"));
    }
    Ok(())
}

fn stage_backup_archive(
    path: &std::path::Path,
    home_dir: &std::path::Path,
) -> Result<(PathBuf, Vec<(PathBuf, PathBuf)>)> {
    use std::io::Read as _;

    let file = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    if zip.len() > MAX_BACKUP_ENTRIES {
        return Err(anyhow!(
            "backup archive exceeds entry limit ({} > {MAX_BACKUP_ENTRIES})",
            zip.len()
        ));
    }

    let staging_dir = home_dir.join(format!(".restore-staging-{}", nanoid::nanoid!(8)));
    std::fs::create_dir_all(&staging_dir)?;
    let cleanup_on_err = scopeguard::guard(staging_dir, |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });

    let mut total_bytes: u64 = 0;
    let mut files_to_apply: Vec<(PathBuf, PathBuf)> = Vec::new();

    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.unix_mode().is_some_and(|mode| (mode & 0o170000) == 0o120000) {
            return Err(anyhow!("backup archive contains disallowed symlink entry"));
        }

        let rel_path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("backup archive contains unsafe path"))?
            .to_path_buf();
        let is_dir = entry.is_dir();

        if !is_allowed_backup_rel_path(&rel_path, is_dir) {
            return Err(anyhow!(
                "backup archive contains disallowed path: {}",
                rel_path.display()
            ));
        }
        if is_dir {
            continue;
        }

        let staged_file = cleanup_on_err.join(&rel_path);
        if let Some(parent) = staged_file.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let remaining = MAX_BACKUP_TOTAL_BYTES.saturating_sub(total_bytes);
        let mut limited = entry.take(remaining.saturating_add(1));
        let mut out = std::fs::File::create(&staged_file)?;
        let copied = std::io::copy(&mut limited, &mut out)?;
        total_bytes = total_bytes
            .checked_add(copied)
            .filter(|&sum| sum <= MAX_BACKUP_TOTAL_BYTES)
            .ok_or_else(|| anyhow!("backup archive exceeds maximum uncompressed size limit"))?;

        files_to_apply.push((staged_file, home_dir.join(&rel_path)));
    }

    let staged_verge = cleanup_on_err.join(crate::utils::dirs::VERGE_CONFIG);
    if staged_verge.is_file() {
        let reader = std::fs::File::open(&staged_verge)?;
        let _: IVerge =
            serde_yaml_ng::from_reader(reader).map_err(|err| anyhow!("restored verge.yaml is invalid: {err}"))?;
    }

    let staging_dir = scopeguard::ScopeGuard::into_inner(cleanup_on_err);
    Ok((staging_dir, files_to_apply))
}

struct BackupRestoreRollback {
    rollback_dir: PathBuf,
    entries: Vec<(PathBuf, Option<PathBuf>)>,
}

impl BackupRestoreRollback {
    fn capture(home_dir: &std::path::Path, files_to_apply: &[(PathBuf, PathBuf)]) -> Result<Self> {
        let rollback_dir = home_dir.join(format!(".restore-rollback-{}", nanoid::nanoid!(8)));
        std::fs::create_dir_all(&rollback_dir)?;
        let mut entries = Vec::with_capacity(files_to_apply.len());
        for (idx, (_, target)) in files_to_apply.iter().enumerate() {
            if target.exists() {
                let saved = rollback_dir.join(format!("orig-{idx}"));
                std::fs::copy(target, &saved)?;
                entries.push((target.clone(), Some(saved)));
            } else {
                entries.push((target.clone(), None));
            }
        }
        Ok(Self { rollback_dir, entries })
    }

    fn restore(&self) {
        for (target, saved) in &self.entries {
            match saved {
                Some(orig) => {
                    let _ = std::fs::copy(orig, target);
                }
                None => {
                    let _ = std::fs::remove_file(target);
                }
            }
        }
    }
}

impl Drop for BackupRestoreRollback {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.rollback_dir);
    }
}

fn apply_staged_backup(
    home_dir: &std::path::Path,
    files_to_apply: &[(PathBuf, PathBuf)],
) -> Result<BackupRestoreRollback> {
    let rollback = BackupRestoreRollback::capture(home_dir, files_to_apply)?;
    for (staged, target) in files_to_apply {
        if let Some(parent) = target.parent()
            && let Err(err) = std::fs::create_dir_all(parent)
        {
            rollback.restore();
            return Err(err.into());
        }
        if let Err(err) = std::fs::copy(staged, target) {
            rollback.restore();
            return Err(err.into());
        }
    }
    Ok(rollback)
}

/// Backup creation strips the WebDAV credentials, so the live ones are kept.
#[allow(
    clippy::significant_drop_tightening,
    reason = "config_write is moved into finalize_restored_verge_config"
)]
async fn restore_backup_archive(path: PathBuf) -> Result<()> {
    let (webdav_url, webdav_username, webdav_password) = {
        let verge = Config::verge().await;
        let verge = verge.latest_arc();
        (
            verge.webdav_url.clone(),
            verge.webdav_username.clone(),
            verge.webdav_password.clone(),
        )
    };

    let home_dir = app_home_dir()?;
    let home_for_stage = home_dir.clone();
    let (staging_dir, files_to_apply) =
        AsyncHandler::spawn_blocking(move || stage_backup_archive(&path, &home_for_stage))
            .await
            .map_err(|join| anyhow!("backup extraction task failed: {join}"))??;
    let _cleanup_staging = scopeguard::guard(staging_dir, |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });

    let _profile_write = crate::config::profiles::PROFILE_WRITE_LOCK.lock().await;
    let (rollback, finalize_res) = {
        let config_write = Config::lock_config_write().await;
        let rollback = AsyncHandler::spawn_blocking(move || apply_staged_backup(&home_dir, &files_to_apply))
            .await
            .map_err(|join| anyhow!("backup apply task failed: {join}"))??;
        let finalize_res =
            finalize_restored_verge_config(config_write, webdav_url, webdav_username, webdav_password).await;
        (rollback, finalize_res)
    };
    if let Err(err) = finalize_res {
        rollback.restore();
        reload_configs_from_disk().await;
        return Err(err);
    }
    Ok(())
}

async fn reload_configs_from_disk() {
    let _config_write = Config::lock_config_write().await;
    let clash_draft = Config::clash().await;
    let profiles_draft = Config::profiles().await;
    let verge_draft = Config::verge().await;
    let Ok(transaction) = clash_verge_draft::DraftTransaction::begin(vec![&clash_draft, &profiles_draft, &verge_draft])
    else {
        return;
    };
    let (clash, profiles, verge) = tokio::join!(IClashTemp::new(), IProfiles::new(), IVerge::new());
    clash_draft.edit_draft(|d| *d = clash);
    profiles_draft.edit_draft(|d| *d = profiles);
    verge_draft.edit_draft(|d| *d = verge);
    transaction.commit();
}

fn webdav_restore_temp_path() -> Result<PathBuf> {
    Ok(app_home_dir()?.join(format!(".webdav-restore-{}.zip", nanoid::nanoid!(8))))
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename))]
pub async fn restore_webdav_backup(filename: String) -> Result<()> {
    validate_backup_archive_name(filename.as_str())?;
    let backup_storage_path = webdav_restore_temp_path()?;
    let name = filename.to_string();
    let download_res = backup::WebDavClient::global()
        .download(filename, backup_storage_path.clone())
        .await;
    if let Err(err) = download_res {
        let _ = backup_storage_path.remove_if_exists().await;
        logging!(
            error,
            Type::Backup,
            "Failed to download WebDAV backup file {name}: {err:#}"
        );
        return Err(err);
    }

    let res = restore_backup_archive(backup_storage_path.clone()).await;
    let _ = backup_storage_path.remove_if_exists().await;
    res
}

pub async fn create_local_backup() -> Result<()> {
    create_local_backup_with_namer(|name| name.to_string().into())
        .await
        .map(|_| ())
}

pub async fn create_local_backup_with_namer<F>(namer: F) -> Result<String>
where
    F: FnOnce(&str) -> String,
{
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create local backup: {err:#}");
        err
    })?;

    let backup_dir = local_backup_dir()?;
    let final_name = namer(file_name.as_str());
    let target_path = backup_dir.join(final_name.as_str());

    if let Err(err) = move_file(temp_file_path.clone(), target_path.clone()).await {
        logging!(
            error,
            Type::Backup,
            "Failed to move local backup file to {}: {err:#}",
            target_path.display()
        );
        if let Err(clean_err) = temp_file_path.remove_if_exists().await {
            logging!(
                warn,
                Type::Backup,
                "Failed to remove temp backup file after move error: {clean_err:#}"
            );
        }
        return Err(err);
    }

    Ok(final_name)
}

#[tracing::instrument(skip_all, level = "info", fields(source = %source))]
pub async fn import_local_backup(source: String) -> Result<String> {
    let source_path = PathBuf::from(source.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {source}"));
    }
    if !source_path.is_file() {
        return Err(anyhow!("Backup path is not a file: {source}"));
    }

    let ext = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "zip" {
        return Err(anyhow!("Only .zip backup files are supported"));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Invalid backup file name"))?;

    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(file_name);

    if target_path == source_path {
        return Ok(file_name.to_string().into());
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    if target_path.exists() {
        return Err(anyhow!("Backup file already exists: {file_name}"));
    }

    fs::copy(&source_path, &target_path)
        .await
        .map_err(|err| anyhow!("Failed to import backup file: {err:#}"))?;

    Ok(file_name.to_string().into())
}

async fn move_file(from: PathBuf, to: PathBuf) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).await?;
    }

    match fs::rename(&from, &to).await {
        Ok(_) => Ok(()),
        Err(rename_err) => {
            // Rename can fail across filesystems; fall back to copy then remove.
            logging!(
                warn,
                Type::Backup,
                "Failed to rename backup file directly, fallback to copy/remove: {rename_err}"
            );
            fs::copy(&from, &to)
                .await
                .map_err(|err| anyhow!("Failed to copy backup file: {err:#}"))?;
            fs::remove_file(&from)
                .await
                .map_err(|err| anyhow!("Failed to remove temp backup file: {err:#}"))?;
            Ok(())
        }
    }
}

pub async fn list_local_backup() -> Result<Vec<LocalBackupFile>> {
    let backup_dir = local_backup_dir()?;
    if !backup_dir.exists() {
        return Ok(vec![]);
    }

    let mut backups = Vec::new();
    let mut dir = fs::read_dir(&backup_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;
        if !metadata.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let last_modified = metadata
            .modified()
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339())
            .unwrap_or_default();
        backups.push(LocalBackupFile {
            filename: file_name.into(),
            path: path.to_string_lossy().into(),
            last_modified: last_modified.into(),
            content_length: metadata.len(),
        });
    }

    backups.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(backups)
}

pub async fn delete_local_backup(filename: String) -> Result<()> {
    validate_backup_name(filename.as_str())?;
    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(filename.as_str());
    if !target_path.exists() {
        logging!(debug, Type::Backup, "Local backup file not found: {}", filename);
        return Ok(());
    }
    target_path.remove_if_exists().await?;
    Ok(())
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename))]
pub async fn restore_local_backup(filename: String) -> Result<()> {
    validate_backup_archive_name(filename.as_str())?;
    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(filename.as_str());
    if !target_path.exists() {
        return Err(anyhow!("Backup file not found: {}", filename));
    }

    restore_backup_archive(target_path).await
}

#[tracing::instrument(skip_all, level = "info", fields(filename = %filename, destination = %destination))]
pub async fn export_local_backup(filename: String, destination: String) -> Result<()> {
    validate_backup_name(filename.as_str())?;
    let backup_dir = local_backup_dir()?;
    let source_path = backup_dir.join(filename.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {}", filename));
    }

    let dest_path = PathBuf::from(destination.as_str());
    if !dest_path.is_absolute()
        || dest_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || !dest_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        return Err(anyhow!("invalid backup export destination path: {destination:?}"));
    }
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::copy(&source_path, &dest_path)
        .await
        .map(|_| ())
        .map_err(|err| anyhow!("Failed to export backup file: {err:#}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        is_allowed_backup_rel_path, validate_backup_archive_name, validate_backup_name, webdav_restore_temp_path,
    };

    #[test]
    fn backup_filename_validation_blocks_traversal_and_separators() {
        assert!(validate_backup_name("backup-2026.zip").is_ok());
        assert!(validate_backup_name("").is_err());
        assert!(validate_backup_name(".").is_err());
        assert!(validate_backup_name("../escape.zip").is_err());
        assert!(validate_backup_name("dir/backup.zip").is_err());
        assert!(validate_backup_name("dir\\backup.zip").is_err());
        assert!(validate_backup_name("bad\0.zip").is_err());
        assert!(validate_backup_archive_name("config.yaml").is_err());
        assert!(validate_backup_archive_name("backup-2026.zip").is_ok());
        assert_eq!(
            webdav_restore_temp_path().ok().as_deref().and_then(Path::parent),
            super::app_home_dir().ok().as_deref()
        );
    }

    #[test]
    fn backup_restore_whitelist_accepts_only_expected_config_paths() {
        assert!(is_allowed_backup_rel_path(Path::new("config.yaml"), false));
        assert!(is_allowed_backup_rel_path(Path::new("verge.yaml"), false));
        assert!(is_allowed_backup_rel_path(Path::new("profiles.yaml"), false));
        assert!(is_allowed_backup_rel_path(Path::new("dns_config.yaml"), false));
        assert!(is_allowed_backup_rel_path(Path::new("profiles"), true));
        assert!(is_allowed_backup_rel_path(Path::new("icons"), true));
        assert!(is_allowed_backup_rel_path(Path::new("profiles/sub.yaml"), false));
        assert!(is_allowed_backup_rel_path(Path::new("icons/tray.png"), false));

        assert!(!is_allowed_backup_rel_path(Path::new("../evil.yaml"), false));
        let traversal = Path::new("profiles/../evil.yaml");
        assert!(!is_allowed_backup_rel_path(traversal, false));
        let nested = Path::new("profiles/sub/nested.yaml");
        assert!(!is_allowed_backup_rel_path(nested, false));
        assert!(!is_allowed_backup_rel_path(Path::new("random.exe"), false));
        assert!(!is_allowed_backup_rel_path(Path::new("etc"), true));
    }
}
