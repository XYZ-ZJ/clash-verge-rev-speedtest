//! In-app mihomo core upgrade.
//!
//! The core replaces itself by truncating its own running executable in place, which macOS
//! kills under Hardened Runtime and which leaves a 0-byte core behind when interrupted
//! (clash-verge-rev#6834). Verge downloads the release itself instead, stages a verified
//! copy beside the managed core and renames it into place: `rename` never touches the inode
//! the running core is executing from, so no page validation can fail.

use crate::{
    config::Config,
    core::{CoreManager, manager::RunningMode},
    utils::network::{NetworkManager, ProxyType},
};
use anyhow::{Context as _, Result, anyhow, bail};
use clash_verge_logging::{Type, logging};
use std::{
    env::current_exe,
    ffi::OsStr,
    fs::File,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const RELEASE_VERSION_URL: &str = "https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt";
const ALPHA_BASE_URL: &str = "https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha";
const RELEASE_DOWNLOAD_URL: &str = "https://github.com/MetaCubeX/mihomo/releases/download";
const VERSION_TIMEOUT_SECS: u64 = 20;
const PACKAGE_TIMEOUT_SECS: u64 = 300;
/// Well above any real core package, low enough that a wrong response cannot exhaust memory.
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

static STAGING_GENERATION: AtomicU64 = AtomicU64::new(0);
/// `.rollback` and `.old` are fixed paths, so two upgrades must not overlap.
static UPGRADE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct CoreUpgradeReport {
    /// False when the managed core was already at the latest version.
    pub upgraded: bool,
}

pub async fn upgrade_core(force: bool) -> Result<CoreUpgradeReport> {
    let _serialized = UPGRADE_LOCK.lock().await;
    let core = Config::verge().await.latest_arc().get_valid_clash_core();
    tracing::Span::current().record("core", tracing::field::display(&core));
    let alpha = core.ends_with("-alpha");
    let target = managed_core_path(&core)?;

    // A core already broken by the in-place updater cannot report a version; upgrading is the repair.
    let installed = read_core_version(&target).await.unwrap_or_else(|error| {
        logging!(warn, Type::Core, "core upgrade: unreadable installed core: {error:#}");
        std::string::String::new()
    });

    let (proxy, latest) = resolve_latest_version(alpha).await?;
    let span = tracing::Span::current();
    span.record("from", tracing::field::display(&installed));
    span.record("to", tracing::field::display(&latest));
    logging!(debug, Type::Core, "core upgrade: latest version resolved via {proxy:?}");

    if !force && installed == latest {
        return Ok(CoreUpgradeReport { upgraded: false });
    }
    if !force && compare_plain_versions(&installed, &latest) == Some(std::cmp::Ordering::Greater) {
        // GitHub moving `latest` backwards must not silently downgrade an
        // installed core (which service mode would even copy into the
        // administrator-approved directory).
        logging!(
            warn,
            Type::Core,
            "core upgrade: latest {latest} is older than installed {installed}; skipping (force to downgrade)"
        );
        return Ok(CoreUpgradeReport { upgraded: false });
    }

    let package_url_string = package_url(alpha, &latest)?;
    let package = download_package(proxy, &package_url_string).await?;
    verify_package_digest(proxy, &package_url_string, &package).await?;
    let staged = stage_core(&target, package, &latest).await?;

    // A hard link keeps the previous core reachable without touching the inode the running
    // core executes from, so publishing below stays one atomic rename.
    let rollback = target.with_file_name(format!(".{core}.rollback"));
    let target_for_link = target.clone();
    let rollback_for_link = rollback.clone();
    let installed_non_empty = !installed.is_empty();
    let restorable = tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_file(&rollback_for_link);
        installed_non_empty && std::fs::hard_link(&target_for_link, &rollback_for_link).is_ok()
    })
    .await
    .unwrap_or(false);

    // Decided before anything can crash: after a failed restart the mode reads NotRunning, which
    // says nothing about whether this upgrade went through the Service.
    let service_mode = matches!(*CoreManager::global().get_running_mode(), RunningMode::Service);

    let target_for_publish = target.clone();
    let mut result = tokio::task::spawn_blocking(move || staged.publish(&target_for_publish))
        .await
        .map_err(|join| anyhow!("core publish task failed: {join}"))
        .and_then(|res| res);
    // The Service executes its own administrator-approved copy, never this file; hand the new
    // bytes over before the restart below asks for them, or a service-mode restart would keep
    // running the previous core while the app reports the new version. Sidecar mode runs the
    // file directly and gets no elevation prompt.
    let service_staging = if result.is_ok() && service_mode {
        result =
            crate::core::service::stage_approved_core(&target).context("core replaced but not accepted by the service");
        if result.is_ok() {
            ServiceStaging::Succeeded
        } else {
            ServiceStaging::Refused
        }
    } else {
        ServiceStaging::NotAttempted
    };
    if result.is_ok() {
        result = CoreManager::global()
            .restart_core()
            .await
            .context("core replaced but failed to restart");
    }

    if let Err(error) = result {
        rollback_failed_upgrade(&target, &rollback, &installed, restorable, service_staging).await;
        return Err(error);
    }
    let _ = std::fs::remove_file(&rollback);
    // The displaced core could not be deleted while it was still executing.
    #[cfg(windows)]
    let _ = std::fs::remove_file(target.with_extension("old"));

    Ok(CoreUpgradeReport { upgraded: true })
}

async fn rollback_failed_upgrade(
    target: &Path,
    rollback: &Path,
    installed: &str,
    restorable: bool,
    service_staging: ServiceStaging,
) {
    // Put the previous core back when its file is gone or its process is down. A failure
    // after the new core started must keep the new file instead. A service that refused the
    // new core also restores: leaving the new file would make a retry read the new version
    // and report nothing to do while the service keeps running the old core.
    let core_is_down = matches!(*CoreManager::global().get_running_mode(), RunningMode::NotRunning);
    if restorable && std::fs::rename(rollback, target).is_ok() {
        logging!(warn, Type::Core, "core upgrade: rolled back to {installed:?}");
        // Only a staging that SUCCEEDED left the failing bytes in the approved copy, and only
        // then must the restore reach it too — otherwise the restart below would spawn the
        // very core that just failed. Refused or never-attempted staging left the approved
        // copy untouched, and re-staging would raise an elevation prompt for a no-op. This is
        // deliberately not gated on the current running mode, which reads NotRunning after
        // the very crash being rolled back.
        if matches!(service_staging, ServiceStaging::Succeeded)
            && let Err(stage_error) = crate::core::service::stage_approved_core(target)
        {
            logging!(
                warn,
                Type::Core,
                "core upgrade: could not restore the service copy: {stage_error:#}"
            );
        }
        if core_is_down {
            let _ = CoreManager::global().restart_core().await;
        }
    }
    // Renaming one hard link over the other succeeds without consuming the name.
    let _ = std::fs::remove_file(rollback);
    // Redundant once the rollback link exists; without one it is the only copy left.
    #[cfg(windows)]
    if restorable {
        let _ = std::fs::remove_file(target.with_extension("old"));
    }
}

/// Whether this upgrade handed bytes to the Service's approved core directory.
///
/// Three states matter, not two: a staging that never ran (publish failed, or sidecar mode) left
/// the approved copy alone just like a refused one, but only a SUCCEEDED staging obliges the
/// rollback path to restore that copy as well. A user who upgrades in sidecar mode and later
/// switches to service mode runs the previously approved core until the next elevated
/// (re)install or upgrade; the Service logs that drift on every spawn.
#[derive(Clone, Copy)]
enum ServiceStaging {
    NotAttempted,
    Succeeded,
    Refused,
}

/// The sidecar next to the app executable. On macOS development builds the Service runs a
/// staged copy of this file, so writing here is what makes an upgrade survive the next start.
fn managed_core_path(core: &str) -> Result<PathBuf> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let path = current_exe()
        .context("failed to locate the current executable")?
        .with_file_name(format!("{core}{extension}"));
    Ok(path)
}

/// Pins the package to the resolved version, so a release moving on mid-upgrade cannot 404.
fn package_url(alpha: bool, version: &str) -> Result<std::string::String> {
    let asset = asset_base_name(alpha)?;
    let extension = if cfg!(windows) { "zip" } else { "gz" };
    Ok(if alpha {
        format!("{ALPHA_BASE_URL}/{asset}-{version}.{extension}")
    } else {
        format!("{RELEASE_DOWNLOAD_URL}/{version}/{asset}-{version}.{extension}")
    })
}

/// Mirrors the asset map in `scripts/prebuild.mjs` so an upgrade keeps the build variant
/// the bundled sidecar was taken from.
fn asset_base_name(alpha: bool) -> Result<&'static str> {
    let arch = std::env::consts::ARCH;
    let unsupported = || anyhow!("no mihomo release asset for {}-{arch}", std::env::consts::OS);

    let name = if cfg!(target_os = "windows") {
        match arch {
            "x86_64" => "mihomo-windows-amd64-v2",
            "x86" => "mihomo-windows-386",
            "aarch64" => "mihomo-windows-arm64",
            _ => return Err(unsupported()),
        }
    } else if cfg!(target_os = "macos") {
        match arch {
            "x86_64" if alpha => "mihomo-darwin-amd64-v1-go122",
            "x86_64" => "mihomo-darwin-amd64-v2-go122",
            "aarch64" => "mihomo-darwin-arm64-go122",
            _ => return Err(unsupported()),
        }
    } else {
        match arch {
            "x86_64" => "mihomo-linux-amd64-v2",
            "x86" => "mihomo-linux-386",
            "aarch64" => "mihomo-linux-arm64",
            "arm" => "mihomo-linux-armv7",
            "riscv64" => "mihomo-linux-riscv64",
            "loongarch64" => "mihomo-linux-loong64",
            _ => return Err(unsupported()),
        }
    };
    Ok(name)
}

/// Returns the proxy that reached GitHub so the package download reuses it.
#[tracing::instrument(skip_all, level = "debug", fields(alpha))]
async fn resolve_latest_version(alpha: bool) -> Result<(ProxyType, std::string::String)> {
    let url = if alpha {
        format!("{ALPHA_BASE_URL}/version.txt")
    } else {
        RELEASE_VERSION_URL.to_owned()
    };
    let mut last_error = None;

    for proxy in [ProxyType::Localhost, ProxyType::System, ProxyType::None] {
        let attempt = NetworkManager::new()
            .get(&url, proxy, Some(VERSION_TIMEOUT_SECS), None, false)
            .await;

        match attempt {
            Ok(response) if response.status().is_success() => {
                // An error page answered with 200 must not become a version, nor reach the URL.
                let version = response.text().trim().to_owned();
                if !is_usable_version(&version) {
                    logging!(
                        warn,
                        Type::Core,
                        "core upgrade: {url} returned an unusable version: {version:?}"
                    );
                    last_error = Some(anyhow!("{url} returned an unusable version"));
                    continue;
                }
                return Ok((proxy, version));
            }
            Ok(response) => {
                logging!(
                    debug,
                    Type::Core,
                    "core upgrade: version probe via {proxy:?}: status {}",
                    response.status()
                );
                last_error = Some(anyhow!("{url} returned status {}", response.status()));
            }
            Err(error) => {
                logging!(
                    debug,
                    Type::Core,
                    "core upgrade: version probe via {proxy:?} failed: {error:#}"
                );
                last_error = Some(error.context(format!("{proxy:?} could not reach {url}")));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("failed to read the latest core version from {url}")))
}

/// Keeps error pages, and anything that could steer the package URL, out of the version.
fn is_usable_version(version: &str) -> bool {
    version.starts_with(|c: char| c.is_ascii_alphanumeric())
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

async fn download_package(proxy: ProxyType, url: &str) -> Result<Vec<u8>> {
    logging!(info, Type::Core, "core upgrade: downloading {url}");

    NetworkManager::new()
        .get_bytes(url, proxy, Some(PACKAGE_TIMEOUT_SECS), MAX_PACKAGE_BYTES)
        .await
        .with_context(|| format!("failed to download {url}"))
}

/// Compares plain `vX.Y.Z` core versions numerically so a moved-back `latest`
/// cannot silently downgrade an install. `None` when either side is not a
/// plain dotted number (alpha builds with hash suffixes keep the existing
/// equality/force semantics).
fn compare_plain_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let parse = |v: &str| -> Option<Vec<u64>> {
        let mut parts = Vec::new();
        for part in v.trim().trim_start_matches('v').split('.') {
            parts.push(part.parse::<u64>().ok()?);
        }
        Some(parts)
    };
    let (left, right) = (parse(a)?, parse(b)?);
    let width = left.len().max(right.len());
    (0..width)
        .map(|i| {
            left.get(i)
                .copied()
                .unwrap_or(0)
                .cmp(&right.get(i).copied().unwrap_or(0))
        })
        .find(|ord| *ord != std::cmp::Ordering::Equal)
        .or(Some(std::cmp::Ordering::Equal))
}

/// Verifies the downloaded package against the SHA-256 digest GitHub's API
/// publishes for the release asset. MetaCubeX does not sign core builds;
/// this binds the bytes to GitHub's own release metadata instead of trusting
/// the download response alone. An asset without a digest (older releases)
/// only downgrades to the staged-version probe; a present mismatch always
/// fails the upgrade.
async fn verify_package_digest(proxy: ProxyType, package_url: &str, bytes: &[u8]) -> Result<()> {
    use sha2::{Digest as _, Sha256};
    use std::fmt::Write as _;

    const DOWNLOAD_PREFIX: &str = "https://github.com/MetaCubeX/mihomo/releases/download/";
    let Some(rest) = package_url.strip_prefix(DOWNLOAD_PREFIX) else {
        anyhow::bail!("unexpected core package URL: {package_url}");
    };
    let Some((tag, asset)) = rest.split_once('/') else {
        anyhow::bail!("unexpected core package URL: {package_url}");
    };
    let api_url = format!("https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/{tag}");

    let response = NetworkManager::new()
        .get(
            &api_url,
            proxy,
            Some(VERSION_TIMEOUT_SECS),
            Some("clash-verge".into()),
            false,
        )
        .await
        .with_context(|| format!("failed to query release metadata for {tag}"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "release metadata for {tag} returned status {}",
        response.status()
    );

    let payload: serde_json::Value = serde_json::from_str(response.text())
        .with_context(|| format!("release metadata for {tag} is not valid JSON"))?;
    let published = payload
        .get("assets")
        .and_then(|assets| assets.as_array())
        .and_then(|assets| {
            assets
                .iter()
                .find(|entry| entry.get("name").and_then(|v| v.as_str()) == Some(asset))
        })
        .and_then(|entry| entry.get("digest"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let expected = if let Some(published) = published {
        published
            .strip_prefix("sha256:")
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("core upgrade: unsupported digest format {published} for {asset}"))?
    } else {
        fetch_checksum_from_release_assets(proxy, &payload, asset, tag).await?
    };

    let digest = Sha256::digest(bytes);
    let mut computed = std::string::String::with_capacity(64);
    for b in digest {
        let _ = write!(&mut computed, "{b:02x}");
    }
    anyhow::ensure!(
        computed == expected,
        "core package digest mismatch for {asset}: expected {expected}, computed {computed}"
    );
    logging!(info, Type::Core, "core upgrade: package digest verified for {asset}");
    Ok(())
}

/// A staged core that is removed unless publishing renamed it away.
struct StagedCore {
    path: PathBuf,
}

impl Drop for StagedCore {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => logging!(
                warn,
                Type::Core,
                "core upgrade: failed to clean {}: {error}",
                self.path.display()
            ),
        }
    }
}

async fn fetch_checksum_from_release_assets(
    proxy: ProxyType,
    payload: &serde_json::Value,
    asset: &str,
    tag: &str,
) -> Result<std::string::String> {
    let checksum_url = payload
        .get("assets")
        .and_then(|assets| assets.as_array())
        .and_then(|assets| {
            assets.iter().find_map(|entry| {
                let name = entry.get("name").and_then(|v| v.as_str())?;
                let lower = name.to_ascii_lowercase();
                if lower == format!("{asset}.sha256").to_ascii_lowercase()
                    || lower == "sha256sums"
                    || lower == "sha256sums.txt"
                    || lower == "sha256sum.txt"
                {
                    entry
                        .get("browser_download_url")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| anyhow!("core upgrade: release metadata for {tag} is missing sha256 digest for {asset}"))?;

    let response = NetworkManager::new()
        .get(
            &checksum_url,
            proxy,
            Some(VERSION_TIMEOUT_SECS),
            Some("clash-verge".into()),
            false,
        )
        .await
        .with_context(|| format!("failed to download checksum asset for {tag}"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "checksum asset for {tag} returned status {}",
        response.status()
    );

    for line in response.text().lines() {
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else {
            continue;
        };
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        match parts.next() {
            Some(file) if file.trim_start_matches('*') == asset => return Ok(hash.to_ascii_lowercase()),
            None if checksum_url.to_ascii_lowercase().ends_with(".sha256") => {
                return Ok(hash.to_ascii_lowercase());
            }
            _ => {}
        }
    }

    bail!("core upgrade: checksum asset for {tag} did not contain a valid sha256 for {asset}")
}

/// Unpacks, permits, signs and runs the new core before it is allowed anywhere near the
/// live path, so a bad download can never replace a working core.
async fn stage_core(target: &Path, package: Vec<u8>, version: &str) -> Result<StagedCore> {
    let target_owned = target.to_path_buf();
    let version_owned = version.to_owned();
    let staged = tokio::task::spawn_blocking(move || -> Result<StagedCore> {
        let directory = target_owned
            .parent()
            .with_context(|| format!("the managed core has no parent directory: {}", target_owned.display()))?;
        let core_name = target_owned
            .file_name()
            .with_context(|| format!("the managed core has no file name: {}", target_owned.display()))?;

        let (path, mut file) = create_staging_file(directory, core_name)?;
        let staged = StagedCore { path };

        unpack(&package, &mut file)
            .with_context(|| format!("failed to unpack the core package for {version_owned}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;

            let mut permissions = file
                .metadata()
                .with_context(|| format!("failed to inspect {}", staged.path.display()))?
                .permissions();
            permissions.set_mode(0o755);
            file.set_permissions(permissions)
                .with_context(|| format!("failed to make {} executable", staged.path.display()))?;
        }

        file.sync_all()
            .with_context(|| format!("failed to flush {}", staged.path.display()))?;
        Ok(staged)
    })
    .await
    .map_err(|join| anyhow!("core staging task failed: {join}"))??;

    let staged_version = read_core_version(&staged.path)
        .await
        .context("the staged core is not runnable")?;
    if staged_version != version {
        bail!("the staged core reports {staged_version}, expected {version}");
    }

    Ok(staged)
}

fn create_staging_file(directory: &Path, core_name: &OsStr) -> Result<(PathBuf, File)> {
    use crate::utils::retry::{RetryError, RetryPolicy, retry_sync};
    retry_sync(
        RetryPolicy::fixed(
            std::num::NonZeroUsize::MIN.saturating_add(31),
            std::time::Duration::ZERO,
        ),
        |_| {
            let generation = STAGING_GENERATION.fetch_add(1, Ordering::Relaxed);
            let path = directory.join(format!(
                ".{}.{}.{generation}.tmp",
                core_name.to_string_lossy(),
                std::process::id()
            ));

            match File::options().write(true).create_new(true).open(&path) {
                Ok(file) => Ok((path, file)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(RetryError::Retry(
                    anyhow::anyhow!("failed to create a unique staging file in {}", directory.display()),
                )),
                Err(error) => Err(RetryError::Stop(
                    anyhow::Error::from(error).context(format!("failed to create {}", path.display())),
                )),
            }
        },
    )
}

/// Real core binaries stay far below this; a decompression bomb must not
/// write without bound.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

fn copy_bounded(reader: impl std::io::Read, out: &mut File) -> Result<()> {
    // `take(MAX + 1)` makes an over-large body surface as an error instead of
    // a silently truncated write.
    let mut limited = reader.take(MAX_UNPACKED_BYTES + 1);
    let copied = std::io::copy(&mut limited, out)?;
    anyhow::ensure!(
        copied <= MAX_UNPACKED_BYTES,
        "extracted core exceeds {MAX_UNPACKED_BYTES} bytes"
    );
    Ok(())
}

#[cfg(windows)]
fn unpack(package: &[u8], out: &mut File) -> Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package)).context("invalid core archive")?;
    let entry = archive.by_index(0).context("the core archive is empty")?;
    copy_bounded(entry, out).context("failed to extract the core")
}

#[cfg(not(windows))]
fn unpack(package: &[u8], out: &mut File) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(package);
    copy_bounded(decoder, out).context("failed to decompress the core")
}

impl StagedCore {
    #[cfg(not(windows))]
    fn publish(self, target: &Path) -> Result<()> {
        std::fs::rename(&self.path, target)
            .with_context(|| format!("failed to publish the core to {}", target.display()))
    }

    #[cfg(windows)]
    fn publish(self, target: &Path) -> Result<()> {
        if std::fs::rename(&self.path, target).is_ok() {
            return Ok(());
        }

        // A running executable cannot be replaced on Windows, but it can be moved aside.
        let displaced = target.with_extension("old");
        let _ = std::fs::remove_file(&displaced);
        std::fs::rename(target, &displaced)
            .with_context(|| format!("failed to move the running core aside from {}", target.display()))?;

        if let Err(error) = std::fs::rename(&self.path, target) {
            // Say where the old core went when it cannot be put back either.
            return match std::fs::rename(&displaced, target) {
                Ok(()) => Err(error).with_context(|| format!("failed to publish the core to {}", target.display())),
                Err(restore) => Err(error).with_context(|| {
                    format!(
                        "failed to publish the core to {} and to restore it from {}: {restore}",
                        target.display(),
                        displaced.display()
                    )
                }),
            };
        }

        let _ = std::fs::remove_file(&displaced);
        Ok(())
    }
}

/// Keeps the `-v` probe from flashing a console window.
#[cfg(windows)]
fn new_async_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = tokio::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn new_async_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::new(program)
}

/// Parses the version out of `Mihomo Meta v1.19.30 darwin arm64 with go1.22.12 ...`.
async fn read_core_version(path: &Path) -> Result<std::string::String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
    let mut command = new_async_command(path);
    command
        .arg("-v")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("{} -v timed out after {}s", path.display(), PROBE_TIMEOUT.as_secs()))?
        .with_context(|| format!("failed to run {} -v", path.display()))?;

    if !output.status.success() {
        bail!("{} -v exited with {}", path.display(), output.status);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .split_whitespace()
        .nth(2)
        .map(str::to_owned)
        .with_context(|| format!("unexpected version output from {}: {stdout}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{is_usable_version, package_url};

    #[test]
    fn only_plain_version_tokens_reach_the_package_url() {
        assert!(is_usable_version("v1.19.30"));
        assert!(is_usable_version("alpha-c0e43eb"));
        for rejected in [
            "",
            ".",
            "..",
            "/etc/passwd",
            "v1.19.30 extra",
            "<html>nope</html>",
            &"v".repeat(65),
        ] {
            assert!(!is_usable_version(rejected), "accepted {rejected:?}");
        }
    }

    #[test]
    fn package_urls_pin_the_resolved_version() {
        let release = package_url(false, "v1.19.30").unwrap_or_default();
        let alpha = package_url(true, "alpha-c0e43eb").unwrap_or_default();
        assert!(release.contains("/releases/download/v1.19.30/"), "{release}");
        assert!(
            release.ends_with("-v1.19.30.gz") || release.ends_with("-v1.19.30.zip"),
            "{release}"
        );
        assert!(alpha.contains("/Prerelease-Alpha/"), "{alpha}");
    }
}
