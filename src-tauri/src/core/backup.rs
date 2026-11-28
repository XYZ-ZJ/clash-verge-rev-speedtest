use crate::constants::files::DNS_CONFIG;
use crate::{config::Config, process::AsyncHandler, utils::dirs};
use anyhow::Error;
use arc_swap::ArcSwapOption;
use backon::{ConstantBuilder, Retryable as _};
use clash_verge_logging::{Type, logging};
use reqwest_dav::list_cmd::{ListEntity, ListFile, ListMultiStatus};
use smartstring::alias::String;
use std::{
    env::{consts::OS, temp_dir},
    io::Write as _,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{fs, io::AsyncWriteExt as _, time::timeout};
use zip::write::SimpleFileOptions;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const TIMEOUT_UPLOAD: u64 = 300;
const TIMEOUT_DOWNLOAD: u64 = 300;
const TIMEOUT_LIST: u64 = 30;
const TIMEOUT_DELETE: u64 = 30;
const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone)]
struct WebDavConfig {
    url: String,
    username: String,
    password: String,
}

pub struct WebDavClient {
    config: ArcSwapOption<WebDavConfig>,
    client: ArcSwapOption<reqwest_dav::Client>,
    init_lock: tokio::sync::Mutex<()>,
}

impl WebDavClient {
    pub fn global() -> &'static Self {
        static WEBDAV_CLIENT: OnceLock<WebDavClient> = OnceLock::new();
        WEBDAV_CLIENT.get_or_init(|| Self {
            config: ArcSwapOption::new(None),
            client: ArcSwapOption::new(None),
            init_lock: tokio::sync::Mutex::new(()),
        })
    }

    async fn get_client(&self) -> Result<reqwest_dav::Client, Error> {
        let cached = self.client.load_full();
        if let Some(client) = cached {
            return Ok((*client).clone());
        }

        let _guard = self.init_lock.lock().await;
        let cached = self.client.load_full();
        if let Some(client) = cached {
            return Ok((*client).clone());
        }

        let config = {
            let existing_config = self.config.load();

            if let Some(cfg_arc) = existing_config.clone() {
                (*cfg_arc).clone()
            } else {
                let verge = Config::verge().await.data_arc();
                if verge.webdav_url.is_none() || verge.webdav_username.is_none() || verge.webdav_password.is_none() {
                    let msg: String =
                        "Unable to create web dav client, please make sure the webdav config is correct".into();
                    return Err(anyhow::Error::msg(msg));
                }

                let config = WebDavConfig {
                    url: verge
                        .webdav_url
                        .clone()
                        .unwrap_or_default()
                        .trim_end_matches('/')
                        .into(),
                    username: verge.webdav_username.clone().unwrap_or_default(),
                    password: verge.webdav_password.clone().unwrap_or_default(),
                };

                self.config.store(Some(Arc::new(config.clone())));
                config
            }
        };

        let parsed_base_url = tauri::Url::parse(config.url.as_str())
            .map_err(|e| anyhow::Error::msg(format!("Invalid WebDAV URL: {e}")))?;
        let max_timeout = TIMEOUT_UPLOAD
            .max(TIMEOUT_DOWNLOAD)
            .max(TIMEOUT_LIST)
            .max(TIMEOUT_DELETE);
        let client = reqwest_dav::ClientBuilder::new()
            .set_agent(
                reqwest::Client::builder()
                    .use_rustls_tls()
                    .timeout(Duration::from_secs(max_timeout))
                    .user_agent(format!("clash-verge/{APP_VERSION} ({OS} WebDAV-Client)"))
                    .redirect(build_webdav_redirect_policy(&parsed_base_url))
                    .build()?,
            )
            .set_host(config.url.into())
            .set_auth(reqwest_dav::Auth::Basic(config.username.into(), config.password.into()))
            .build()?;

        // 直接使用 MKCOL；部分服务器的 depth-0 PROPFIND 会误报解码错误。
        if let Err(e) = client.mkcol(dirs::BACKUP_DIR).await {
            self.handle_mkcol_error(e)?;
        } else {
            logging!(info, Type::Backup, "Successfully created backup directory");
        }

        self.client.store(Some(Arc::new(client.clone())));

        Ok(client)
    }

    fn handle_mkcol_error(&self, e: reqwest_dav::Error) -> Result<(), Error> {
        let (status_code, message) = match &e {
            reqwest_dav::Error::Decode(reqwest_dav::DecodeError::Server(server_err)) => {
                (Some(server_err.response_code), Some(server_err.message.as_str()))
            }
            reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(status_err)) => {
                (Some(status_err.response_code), None)
            }
            reqwest_dav::Error::Reqwest(http_err) => (http_err.status().map(|s| s.as_u16()), None),
            _ => (None, None),
        };

        // 409 表示父目录不存在，不能按消息启发式处理。
        if status_code == Some(409) {
            logging!(
                warn,
                Type::Backup,
                "Backup directory cannot be created because its parent folder does not exist"
            );
            self.reset();
            return Err(anyhow::Error::msg(
                "Failed to create backup directory: parent directory does not exist",
            ));
        }

        // 405 是标准的已存在响应；部分服务器只在消息里说明。
        let already_exists = status_code == Some(405)
            || message.is_some_and(|m| {
                let m = m.to_ascii_lowercase();
                m.contains("already exist") || m.contains("already taken")
            });

        if already_exists {
            logging!(info, Type::Backup, "Backup directory already exists");
            Ok(())
        } else {
            logging!(warn, Type::Backup, "Failed to create backup directory: {}", e);
            self.reset();
            Err(anyhow::Error::msg(format!("Failed to create backup directory: {}", e)))
        }
    }

    pub fn reset(&self) {
        self.config.store(None);
        self.client.store(None);
    }

    pub async fn upload(&self, file_path: PathBuf, file_name: String) -> Result<(), Error> {
        let client = self.get_client().await?;
        let webdav_path: String = format!("{}/{}", dirs::BACKUP_DIR, file_name).into();

        let file_content = fs::read(&file_path).await?;

        let backoff = ConstantBuilder::default()
            .with_delay(Duration::from_millis(500))
            .with_max_times(1);

        (|| async {
            timeout(
                Duration::from_secs(TIMEOUT_UPLOAD),
                client.put(&webdav_path, file_content.clone()),
            )
            .await??;
            Ok::<(), Error>(())
        })
        .retry(backoff)
        .notify(|err, dur| {
            logging!(warn, Type::Backup, "Upload failed: {err}, retrying in {dur:?}");
        })
        .await
    }

    fn validate_remote_filename(filename: &str) -> Result<(), Error> {
        if filename.is_empty()
            || filename == "."
            || filename == ".."
            || filename.contains('/')
            || filename.contains('\\')
            || filename.contains('\0')
        {
            anyhow::bail!("invalid WebDAV backup filename: {filename:?}");
        }
        Ok(())
    }

    pub async fn download(&self, filename: String, storage_path: PathBuf) -> Result<(), Error> {
        Self::validate_remote_filename(filename.as_str())?;
        let client = self.get_client().await?;
        let path = format!("{}/{}", dirs::BACKUP_DIR, filename);

        let fut = async {
            let mut response = client.get(path.as_str()).await?;
            let status = response.status();
            if !status.is_success() {
                anyhow::bail!("WebDAV download failed with status {status}");
            }
            if response.content_length().is_some_and(|len| len > MAX_DOWNLOAD_BYTES) {
                anyhow::bail!("WebDAV backup exceeds maximum allowed size ({MAX_DOWNLOAD_BYTES} bytes)");
            }

            if let Some(parent) = storage_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            let std_file = {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt as _;
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&storage_path)?
                }
                #[cfg(windows)]
                {
                    crate::core::owner_identity::create_private_current_user_file(&storage_path)?
                }
                #[cfg(not(any(unix, windows)))]
                {
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&storage_path)?
                }
            };
            let mut file = fs::File::from_std(std_file);
            let mut total: u64 = 0;
            while let Some(chunk) = response.chunk().await? {
                total = total
                    .checked_add(chunk.len() as u64)
                    .filter(|&sum| sum <= MAX_DOWNLOAD_BYTES)
                    .ok_or_else(|| {
                        anyhow::anyhow!("WebDAV backup exceeds maximum allowed size ({MAX_DOWNLOAD_BYTES} bytes)")
                    })?;
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            Ok::<(), Error>(())
        };

        let result = timeout(Duration::from_secs(TIMEOUT_DOWNLOAD), fut).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => {
                let _ = fs::remove_file(&storage_path).await;
                Err(err)
            }
            Err(elapsed) => {
                let _ = fs::remove_file(&storage_path).await;
                Err(elapsed.into())
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<ListFile>, Error> {
        let client = self.get_client().await?;
        let path = format!("{}/", dirs::BACKUP_DIR);

        let fut = async {
            let response = client.list_raw(path.as_str(), reqwest_dav::Depth::Number(1)).await?;
            let status = response.status();
            if !status.is_success() {
                return Err(reqwest_dav::Error::Decode(reqwest_dav::DecodeError::StatusMismatched(
                    reqwest_dav::StatusMismatchedError {
                        response_code: status.as_u16(),
                        expected_code: 207,
                    },
                )));
            }

            let xml = response.text().await?;
            let files = parse_webdav_list(&xml)?;
            let mut final_files = Vec::new();
            for file in files {
                if let ListEntity::File(file) = file {
                    final_files.push(file);
                }
            }
            Ok::<Vec<ListFile>, reqwest_dav::Error>(final_files)
        };

        Ok(timeout(Duration::from_secs(TIMEOUT_LIST), fut).await??)
    }

    pub async fn delete(&self, file_name: String) -> Result<(), Error> {
        Self::validate_remote_filename(file_name.as_str())?;
        let client = self.get_client().await?;
        let path = format!("{}/{}", dirs::BACKUP_DIR, file_name);

        let fut = client.delete(&path);
        timeout(Duration::from_secs(TIMEOUT_DELETE), fut).await??;
        Ok(())
    }
}

fn build_webdav_redirect_policy(parsed_base_url: &tauri::Url) -> reqwest::redirect::Policy {
    let base_scheme = parsed_base_url.scheme().to_ascii_lowercase();
    let base_host = parsed_base_url.host_str().map(|h| h.to_ascii_lowercase());
    let base_port = parsed_base_url.port_or_known_default();

    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("重定向次数过多");
        }
        let target = attempt.url();
        let same_scheme = target.scheme().eq_ignore_ascii_case(&base_scheme);
        let same_host = target.host_str().map(|h| h.to_ascii_lowercase()) == base_host;
        let same_port = target.port_or_known_default() == base_port;
        if !same_scheme || !same_host || !same_port {
            return attempt.error("Refusing cross-origin or scheme-downgrade WebDAV redirect");
        }
        attempt.follow()
    })
}

fn parse_webdav_list(xml: &str) -> Result<Vec<ListEntity>, reqwest_dav::Error> {
    // Some WebDAV servers emit RFC 2822's numeric UTC offset instead of HTTP-date's `GMT`.
    let normalized_xml = xml.replace(" +0000</", " GMT</");
    let multi_status: ListMultiStatus = reqwest_dav::re_exports::serde_xml_rs::from_str(&normalized_xml)?;
    multi_status.responses.into_iter().map(ListEntity::try_from).collect()
}

async fn collect_dir_entries(dir: PathBuf, prefix: &str) -> Result<Vec<(std::string::String, Vec<u8>)>, Error> {
    let mut collected = Vec::new();
    if let Ok(mut entries) = fs::read_dir(dir).await {
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                let file_name_os = entry.file_name();
                let file_name = file_name_os
                    .to_str()
                    .ok_or_else(|| anyhow::Error::msg("Invalid file name encoding"))?;
                let content = fs::read(&path).await?;
                collected.push((format!("{prefix}/{file_name}"), content));
            }
        }
    }
    Ok(collected)
}

pub async fn create_backup() -> Result<(String, PathBuf), Error> {
    let now = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let suffix = nanoid::nanoid!(8);
    let zip_file_name: String = format!("{OS}-backup-{now}-{suffix}.zip").into();
    let zip_path = temp_dir().join(zip_file_name.as_str());

    let (profile_entries, icon_entries, clash_bytes, verge_text, dns_bytes, profiles_bytes) = {
        let _profile_write = crate::config::profiles::PROFILE_WRITE_LOCK.lock().await;
        let _config_write = Config::lock_config_write().await;

        let profile_entries = collect_dir_entries(dirs::app_profiles_dir()?, "profiles").await?;
        let icon_entries = collect_dir_entries(dirs::app_icons_dir()?, "icons").await?;
        let clash_bytes = fs::read(dirs::clash_path()?).await?;
        let verge_text = fs::read_to_string(dirs::verge_path()?).await?;
        let dns_config_path = dirs::app_home_dir()?.join(DNS_CONFIG);
        let dns_bytes = if dns_config_path.exists() {
            Some(fs::read(&dns_config_path).await?)
        } else {
            None
        };
        let profiles_bytes = fs::read(dirs::profiles_path()?).await?;
        (
            profile_entries,
            icon_entries,
            clash_bytes,
            verge_text,
            dns_bytes,
            profiles_bytes,
        )
    };

    let mut verge_config: serde_json::Value = serde_yaml_ng::from_str(&verge_text)?;
    if let Some(obj) = verge_config.as_object_mut() {
        obj.remove("webdav_username");
        obj.remove("webdav_password");
        obj.remove("webdav_url");
    }
    let verge_yaml = serde_yaml_ng::to_string(&verge_config)?;

    let value = zip_path.clone();
    AsyncHandler::spawn_blocking(move || -> Result<(), Error> {
        let file = {
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&value)?
            }
            #[cfg(windows)]
            {
                crate::core::owner_identity::create_private_current_user_file(&value).map_err(std::io::Error::other)?
            }
            #[cfg(not(any(unix, windows)))]
            {
                std::fs::OpenOptions::new().write(true).create_new(true).open(&value)?
            }
        };
        let mut zip = zip::ZipWriter::new(file);
        zip.add_directory("profiles/", SimpleFileOptions::default())?;
        if !icon_entries.is_empty() {
            zip.add_directory("icons/", SimpleFileOptions::default())?;
        }
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        for (backup_path, content) in profile_entries {
            zip.start_file(backup_path, options)?;
            zip.write_all(&content)?;
        }
        for (backup_path, content) in icon_entries {
            zip.start_file(backup_path, options)?;
            zip.write_all(&content)?;
        }
        zip.start_file(dirs::CLASH_CONFIG, options)?;
        zip.write_all(&clash_bytes)?;
        zip.start_file(dirs::VERGE_CONFIG, options)?;
        zip.write_all(verge_yaml.as_bytes())?;
        if let Some(dns_bytes) = dns_bytes {
            zip.start_file(DNS_CONFIG, options)?;
            zip.write_all(&dns_bytes)?;
        }
        zip.start_file(dirs::PROFILE_YAML, options)?;
        zip.write_all(&profiles_bytes)?;
        zip.finish()?;
        Ok(())
    })
    .await??;

    Ok((zip_file_name, zip_path))
}
