use crate::core::notify::NoticeStatus;
use anyhow::Result;
use percent_encoding::percent_decode_str;
use smartstring::alias::String;
use tauri::Url;
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};

use crate::{
    config::{Config, PrfItem, profiles},
    core::{handle, timer::Timer},
    utils::help,
};
use clash_verge_logging::{Type, logging, logging_error};

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
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_disallowed_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

fn validate_subscription_url(raw_url: &str) -> Result<(Url, bool)> {
    let parsed = Url::parse(raw_url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!("Unsupported subscription URL scheme: {}", parsed.scheme());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Subscription URL missing host"))?;
    let lower_host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let is_local_or_private = lower_host == "localhost"
        || lower_host.ends_with(".localhost")
        || lower_host.ends_with(".local")
        || lower_host.ends_with(".internal")
        || lower_host.parse::<std::net::IpAddr>().is_ok_and(is_disallowed_ip);
    Ok((parsed, is_local_or_private))
}

pub(super) async fn resolve_scheme(param: &str) -> Result<()> {
    let param_str = if param.starts_with("[") && param.len() > 4 {
        param
            .get(2..param.len() - 2)
            .ok_or_else(|| anyhow::anyhow!("Invalid string slice boundaries"))?
    } else {
        param
    };
    let masked_deep_link = help::mask_url(param_str);

    logging!(debug, Type::Config, "received deep link: {masked_deep_link}");

    let link_parsed = Url::parse(param_str)
        .map_err(|e| anyhow::anyhow!("failed to parse deep link: {e:?}, param: {masked_deep_link}"))?;

    let Some((url, name)) = extract_subscription_info(&link_parsed) else {
        logging!(
            warn,
            Type::Config,
            "missing url parameter in deep link: {masked_deep_link}"
        );
        return Ok(());
    };

    let is_local_or_private = match validate_subscription_url(&url) {
        Ok((_, is_private)) => is_private,
        Err(err) => {
            logging!(warn, Type::Config, "rejected deep link url: {err:#}");
            handle::Handle::notice(NoticeStatus::ImportSubUrlError, err.to_string());
            return Ok(());
        }
    };

    let display_name = name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("(unnamed)");
    let warning_prefix = if is_local_or_private {
        "Warning: This URL points to a local or private network address.\n\n"
    } else {
        ""
    };
    let description = format!(
        "{warning_prefix}An external link requested to import a subscription profile:\n\n\
         Name: {display_name}\n\
         URL: {url}\n\n\
         Do you want to import it?"
    );
    let confirmed = confirm_deep_link_import(description).await;

    if !confirmed {
        logging!(info, Type::Config, "Deep link import cancelled by user");
        return Ok(());
    }

    import_subscription(&url, name.as_ref()).await;
    Ok(())
}

async fn confirm_deep_link_import(description: std::string::String) -> bool {
    if let Some(app_handle) = crate::APP_HANDLE.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app_handle
            .dialog()
            .message(description)
            .title("Import Profile Confirmation")
            .buttons(MessageDialogButtons::YesNo)
            .kind(MessageDialogKind::Info)
            .show(move |confirmed| {
                let _ = tx.send(confirmed);
            });
        tokio::time::timeout(std::time::Duration::from_secs(120), rx)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false)
    } else {
        false
    }
}

fn extract_subscription_info(link_parsed: &Url) -> Option<(std::string::String, Option<String>)> {
    if !matches!(link_parsed.scheme(), "clash" | "clash-verge") {
        return None;
    }

    let name = link_parsed
        .query_pairs()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.into_owned().into());
    let url = extract_subscription_url(link_parsed)?;
    Some((url, name))
}

fn extract_subscription_url(link_parsed: &Url) -> Option<std::string::String> {
    if let Some(query) = link_parsed.query() {
        let start = if let Some(rest) = query.strip_prefix("url=") {
            Some(rest)
        } else {
            query.find("&url=").map(|pos| &query[pos + 5..])
        };
        if let Some(start) = start {
            let trimmed_start = start.trim_start();
            // When the nested URL is unencoded (starts with http:// or https://),
            // query_pairs() would truncate at the first '&' inside the nested URL.
            if (trimmed_start.len() >= 7 && trimmed_start[..7].eq_ignore_ascii_case("http://"))
                || (trimmed_start.len() >= 8 && trimmed_start[..8].eq_ignore_ascii_case("https://"))
            {
                let end = trimmed_start.find("&name=").unwrap_or(trimmed_start.len());
                let raw_url = trimmed_start[..end].trim();
                if !raw_url.is_empty() {
                    return Some(decode_subscription_url(raw_url));
                }
            }
        }
    }
    if let Some((_, value)) = link_parsed.query_pairs().find(|(key, _)| key == "url") {
        let trimmed = value.trim();
        if !trimmed.is_empty() && Url::parse(trimmed).is_ok() {
            return Some(decode_subscription_url(trimmed));
        }
    }
    let query = link_parsed.query()?;
    let start = if let Some(rest) = query.strip_prefix("url=") {
        rest
    } else {
        let pos = query.find("&url=")?;
        &query[pos + 5..]
    };
    let end = start.find("&name=").unwrap_or(start.len());
    let raw_url = start[..end].trim();
    if raw_url.is_empty() {
        return None;
    }
    Some(decode_subscription_url(raw_url))
}

fn decode_subscription_url(raw_url: &str) -> std::string::String {
    // Avoid double-decoding nested subscription URLs; decode only when needed.
    if Url::parse(raw_url).is_ok() {
        return raw_url.to_string();
    }

    let mut candidate = raw_url.to_string();
    for _ in 0..2 {
        let next = percent_decode_str(&candidate).decode_utf8_lossy().to_string();
        if next == candidate {
            break;
        }
        candidate = next;
        if Url::parse(&candidate).is_ok() {
            break;
        }
    }
    candidate
}

async fn import_subscription(url: &str, name: Option<&String>) {
    let Some(mut item) = fetch_profile_item(url, name).await else {
        return;
    };

    let had_current = Config::profiles().await.latest_arc().current.is_some();
    let uid = item.uid.clone().unwrap_or_default();
    if let Err(e) = profiles::profiles_append_item_safe(&mut item).await {
        logging!(error, Type::Config, "failed to import subscription url: {:?}", e);
        Config::profiles().await.discard();
        handle::Handle::notice(NoticeStatus::ImportSubUrlError, e.to_string());
        return;
    }

    if let Err(e) = profiles::profiles_save_file_safe().await {
        logging!(error, Type::Config, "failed to save imported subscription: {e:#}");
        handle::Handle::notice(NoticeStatus::ImportSubUrlError, e.to_string());
        return;
    }
    if !had_current && !uid.is_empty() {
        match crate::core::CoreManager::global().update_config_forced().await {
            Ok(outcome) if outcome.is_valid() => handle::Handle::refresh_clash(),
            Ok(outcome) => {
                let message = outcome.to_string();
                logging!(
                    warn,
                    Type::Config,
                    "failed to activate initial deep-link profile: {message}"
                );
                handle::Handle::notice(NoticeStatus::ConfigValidateError, message);
            }
            Err(e) => {
                logging!(
                    warn,
                    Type::Config,
                    "failed to activate initial deep-link profile: {e:#}"
                );
                handle::Handle::notice(NoticeStatus::ConfigValidateError, e.to_string());
            }
        }
    }
    logging_error!(Type::Timer, Timer::global().refresh().await);
    handle::Handle::notice(
        NoticeStatus::ImportSubUrlOk,
        "", // 空 msg 传入，我们不希望导致 后端-前端-后端 死循环，这里只做提醒。
    );

    post_import_updates(&uid);
}

async fn fetch_profile_item(url: &str, name: Option<&String>) -> Option<PrfItem> {
    match PrfItem::from_url(url, name, None, None).await {
        Ok(item) => Some(item),
        Err(e) => {
            logging!(error, Type::Config, "failed to parse profile from url: {:?}", e);
            handle::Handle::notice(NoticeStatus::ImportSubUrlError, e.to_string());
            None
        }
    }
}

fn post_import_updates(uid: &String) {
    handle::Handle::refresh_verge();
    handle::Handle::notify_profile_changed(uid);
}
