use crate::{
    cmd::{CmdResult, StringifyErr as _},
    utils::dirs::{self, PathBufExec as _},
};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use std::path::{Component, Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt as _;

#[derive(Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IconInfo {
    #[specta(type = std::string::String)]
    name: String,
    #[specta(type = std::string::String)]
    previous_t: String,
    #[specta(type = std::string::String)]
    current_t: String,
}

fn normalize_icon_segment(name: &str) -> CmdResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("invalid icon cache file name".into());
    }

    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(trimmed.into()),
        _ => Err("invalid icon cache file name".into()),
    }
}

fn ensure_icon_cache_target(icon_cache_dir: &Path, file_name: &str) -> CmdResult<PathBuf> {
    let icon_path = icon_cache_dir.join(file_name);
    let is_direct_child =
        icon_path.parent().is_some_and(|parent| parent == icon_cache_dir) && icon_path.starts_with(icon_cache_dir);

    if !is_direct_child {
        return Err("invalid icon cache file name".into());
    }

    Ok(icon_path)
}

fn normalized_text_prefix(content: &[u8]) -> std::string::String {
    let content = content.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(content);
    let start = content
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or_else(|| content.len());
    let end = content.len().min(start.saturating_add(2048));
    let prefix = &content[start..end];
    std::string::String::from_utf8_lossy(prefix).to_ascii_lowercase()
}

fn looks_like_html(content: &[u8]) -> bool {
    let prefix = normalized_text_prefix(content);
    prefix.starts_with("<!doctype html") || prefix.starts_with("<html") || prefix.starts_with("<head")
}

fn looks_like_svg(content: &[u8]) -> bool {
    let prefix = normalized_text_prefix(content);
    prefix.starts_with("<svg")
        || ((prefix.starts_with("<?xml") || prefix.starts_with("<!doctype svg")) && prefix.contains("<svg"))
}

const MAX_ICON_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_ICON_EXTS: &[&str] = &["png", "ico", "jpg", "jpeg", "webp", "bmp", "icns", "svg"];

fn is_disallowed_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 0b0100_0000)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || v6.to_ipv4_mapped().is_some_and(|v4| is_disallowed_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

fn validate_external_icon_url(raw_url: &str) -> CmdResult<tauri::Url> {
    let parsed = tauri::Url::parse(raw_url).map_err(|_| "invalid icon url")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("unsupported icon url scheme".into());
    }
    let Some(host) = parsed.host_str() else {
        return Err("icon url missing host".into());
    };
    let lower_host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if lower_host == "localhost"
        || lower_host.ends_with(".localhost")
        || lower_host.ends_with(".local")
        || lower_host.ends_with(".internal")
    {
        return Err("refusing local or internal icon host".into());
    }
    if let Ok(ip) = lower_host.parse::<std::net::IpAddr>()
        && is_disallowed_ip(ip)
    {
        return Err("refusing private or loopback icon IP".into());
    }
    Ok(parsed)
}

fn is_safe_svg(content: &[u8]) -> bool {
    let text = std::string::String::from_utf8_lossy(content).to_ascii_lowercase();
    !(text.contains("<script")
        || text.contains("</script")
        || text.contains("javascript:")
        || text.contains("vbscript:")
        || text.contains("<foreignobject")
        || text.contains("<iframe")
        || text.contains("<object")
        || text.contains("<embed")
        || text.contains("onload=")
        || text.contains("onerror=")
        || text.contains("onclick=")
        || text.contains("onmouseover="))
}

fn is_supported_icon_content(content: &[u8]) -> bool {
    if content.is_empty() || content.len() > MAX_ICON_BYTES || looks_like_html(content) {
        return false;
    }

    tauri::image::Image::from_bytes(content).is_ok() || (looks_like_svg(content) && is_safe_svg(content))
}

pub async fn download_icon_cache(url: String, name: String) -> CmdResult<String> {
    let parsed_url = validate_external_icon_url(url.as_str())?;
    let icon_cache_dir = dirs::app_home_dir().stringify_err()?.join("icons").join("cache");
    let icon_name = normalize_icon_segment(name.as_str())?;
    let icon_path = ensure_icon_cache_target(&icon_cache_dir, icon_name.as_str())?;

    if icon_path.exists() {
        return Ok(icon_path.to_string_lossy().into());
    }

    if !icon_cache_dir.exists() {
        fs::create_dir_all(&icon_cache_dir).await.stringify_err()?;
    }

    let temp_name = format!("{icon_name}.downloading");
    let temp_path = ensure_icon_cache_target(&icon_cache_dir, temp_name.as_str())?;

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .stringify_err()?;
    let response = client.get(parsed_url).send().await.stringify_err()?;
    validate_external_icon_url(response.url().as_str())?;
    let response = response.error_for_status().stringify_err()?;
    if response.content_length().is_some_and(|len| len > MAX_ICON_BYTES as u64) {
        return Err("Icon download exceeds maximum allowed size".into());
    }
    let content = response.bytes().await.stringify_err()?;

    if !is_supported_icon_content(&content) {
        let _ = temp_path.remove_if_exists().await;
        return Err("Downloaded content is not a valid or safe image".into());
    }

    {
        let mut file = match fs::File::create(&temp_path).await {
            Ok(file) => file,
            Err(_) => {
                if icon_path.exists() {
                    return Ok(icon_path.to_string_lossy().into());
                }
                return Err("Failed to create temporary file".into());
            }
        };
        file.write_all(content.as_ref()).await.stringify_err()?;
        file.flush().await.stringify_err()?;
    }

    if !icon_path.exists() {
        match fs::rename(&temp_path, &icon_path).await {
            Ok(_) => {}
            Err(_) => {
                let _ = temp_path.remove_if_exists().await;
                if icon_path.exists() {
                    return Ok(icon_path.to_string_lossy().into());
                }
            }
        }
    } else {
        let _ = temp_path.remove_if_exists().await;
    }

    Ok(icon_path.to_string_lossy().into())
}

pub async fn copy_icon_file(path: String, icon_info: IconInfo) -> CmdResult<String> {
    let file_path = Path::new(path.as_str());
    let icon_name = normalize_icon_segment(icon_info.name.as_str())?;
    let current_t = normalize_icon_segment(icon_info.current_t.as_str())?;
    let previous_t = if icon_info.previous_t.trim().is_empty() {
        None
    } else {
        Some(normalize_icon_segment(icon_info.previous_t.as_str())?)
    };

    let icon_dir = dirs::app_home_dir().stringify_err()?.join("icons");
    if !icon_dir.exists() {
        fs::create_dir_all(&icon_dir).await.stringify_err()?;
    }

    if matches!(
        file_path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::UNC(_) | std::path::Prefix::VerbatimUNC(_))
    ) {
        return Err("refusing UNC icon path".into());
    }

    let ext: String = match file_path.extension() {
        Some(e) => e.to_string_lossy().to_ascii_lowercase().into(),
        None => "ico".into(),
    };
    if !ALLOWED_ICON_EXTS.contains(&ext.as_str()) {
        return Err("unsupported icon file extension".into());
    }

    let dest_file_name = format!("{icon_name}-{current_t}.{ext}");
    let dest_path = ensure_icon_cache_target(&icon_dir, dest_file_name.as_str())?;

    if file_path.exists() {
        if ext == "svg" {
            let bytes = fs::read(file_path).await.stringify_err()?;
            if !is_supported_icon_content(&bytes) {
                return Err("refusing unsafe svg icon file".into());
            }
        }
        if let Some(previous_t) = previous_t {
            let previous_png = ensure_icon_cache_target(&icon_dir, format!("{icon_name}-{previous_t}.png").as_str())?;
            previous_png.remove_if_exists().await.unwrap_or_default();
            let previous_ico = ensure_icon_cache_target(&icon_dir, format!("{icon_name}-{previous_t}.ico").as_str())?;
            previous_ico.remove_if_exists().await.unwrap_or_default();
        }

        logging!(debug, Type::Cmd, "copying icon file: {path} -> {}", dest_path.display());

        match fs::copy(file_path, &dest_path).await {
            Ok(_) => Ok(dest_path.to_string_lossy().into()),
            Err(err) => Err(err.to_string().into()),
        }
    } else {
        Err("file not found".into())
    }
}
