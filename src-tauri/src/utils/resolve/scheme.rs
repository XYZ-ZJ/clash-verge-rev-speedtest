use crate::core::notify::NoticeStatus;
use anyhow::Result;
use percent_encoding::percent_decode_str;
use smartstring::alias::String;
use tauri::Url;

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
                || v6.to_ipv4_mapped().is_some_and(|v4| is_disallowed_ip(std::net::IpAddr::V4(v4)))
        }
    }
}

fn validate_subscription_url(raw_url: &str) -> Result<Url> {
    let parsed = Url::parse(raw_url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!("Unsupported subscription URL scheme: {}", parsed.scheme());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Subscription URL missing host"))?;
    let lower_host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if lower_host == "localhost"
        || lower_host.ends_with(".localhost")
        || lower_host.ends_with(".local")
        || lower_host.ends_with(".internal")
    {
        anyhow::bail!("Refusing private or local subscription host");
    }
    if let Ok(ip) = lower_host.parse::<std::net::IpAddr>()
        && is_disallowed_ip(ip)
    {
        anyhow::bail!("Refusing private or loopback subscription IP");
    }
    Ok(parsed)
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

    if let Err(err) = validate_subscription_url(&url) {
        logging!(warn, Type::Config, "rejected deep link url: {err:#}");
        handle::Handle::notice(NoticeStatus::ImportSubUrlError, err.to_string());
        return Ok(());
    }

    let display_name = name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("(unnamed)");
    let description = format!(
        "An external link requested to import a subscription profile:\n\n\
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

fn show_deep_link_confirm_dialog(description: std::string::String) -> bool {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Info)
        .set_title("Import Profile Confirmation")
        .set_description(description)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
}

async fn confirm_deep_link_import(description: std::string::String) -> bool {
    if let Some(app_handle) = crate::APP_HANDLE.get() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if app_handle
            .run_on_main_thread(move || {
                let _ = tx.send(show_deep_link_confirm_dialog(description));
            })
            .is_err()
        {
            return false;
        }
        rx.await.unwrap_or(false)
    } else {
        crate::process::AsyncHandler::spawn_blocking(move || show_deep_link_confirm_dialog(description))
            .await
            .unwrap_or(false)
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
    let query = link_parsed.query()?;
    let prefix = "url=";
    let pos = query.find(prefix)?;
    let raw_url = query[pos + prefix.len()..].trim();
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
    logging_error!(Type::Timer, Timer::global().refresh().await);
    handle::Handle::notice(
        NoticeStatus::ImportSubUrlOk,
        "", // 空 msg 传入，我们不希望导致 后端-前端-后端 死循环，这里只做提醒。
    );

    post_import_updates(&uid).await;
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

async fn post_import_updates(uid: &String) {
    handle::Handle::refresh_verge();
    handle::Handle::notify_profile_changed(uid);
}
