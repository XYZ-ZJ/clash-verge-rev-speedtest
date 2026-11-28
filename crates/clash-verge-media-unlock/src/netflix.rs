use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::Deserialize;

use clash_verge_logging::{Type, logging};

use super::UnlockItem;

pub(crate) const NETFLIX_NAME: &str = "Netflix";

// lib.rs wraps every checker in a 15s budget (`CHECK_BUDGET`); a per-request
// timeout above that ceiling is dead configuration, so stay just under it.
const TIMEOUT: Duration = Duration::from_secs(14);

#[derive(Deserialize)]
struct FastResponse {
    targets: Vec<FastTarget>,
}

#[derive(Deserialize)]
struct FastTarget {
    location: FastLocation,
}

#[derive(Deserialize)]
struct FastLocation {
    country: String,
}

fn item(status: impl Into<String>) -> UnlockItem {
    UnlockItem::checked(NETFLIX_NAME, status, None)
}

pub(super) async fn check_netflix(client: &Client) -> UnlockItem {
    let cdn = check_netflix_cdn(client).await;
    if cdn.status == "Yes" || cdn.status.starts_with("No") {
        return cdn;
    }

    let (r1, r2) = tokio::join!(check_title(client, "81280792"), check_title(client, "70143836"));
    let s1 = r1.ok();
    let s2 = r2.ok();

    if s1 == Some(StatusCode::FORBIDDEN) || s2 == Some(StatusCode::FORBIDDEN) {
        return item("No");
    }

    if [s1, s2]
        .into_iter()
        .flatten()
        .any(|s| matches!(s, StatusCode::OK | StatusCode::MOVED_PERMANENTLY))
    {
        return check_region(client).await;
    }

    if s1 == Some(StatusCode::NOT_FOUND) && s2 == Some(StatusCode::NOT_FOUND) {
        return item("Originals Only");
    }

    match (s1, s2) {
        (Some(status1), Some(status2)) => item(format!("Failed (状态码: {status1}_{status2})")),
        _ => item("Failed"),
    }
}

async fn check_title(client: &Client, id: &str) -> reqwest::Result<StatusCode> {
    client
        .get(format!("https://www.netflix.com/title/{id}"))
        .timeout(TIMEOUT)
        .send()
        .await
        .map(|res| res.status())
}

fn parse_country_segment(candidate: &str) -> Option<&str> {
    let code = candidate.split('-').next()?;
    if code.len() == 2
        && code.chars().all(|c| c.is_ascii_alphabetic())
        && rust_iso3166::from_alpha2(&code.to_ascii_uppercase()).is_some()
    {
        Some(code)
    } else {
        None
    }
}

async fn check_region(client: &Client) -> UnlockItem {
    let response = match client
        .get("https://www.netflix.com/title/80018499")
        .timeout(TIMEOUT)
        .send()
        .await
    {
        Ok(res) => res,
        Err(e) => {
            logging!(error, Type::Network, "获取 Netflix 区域信息失败: {e}");
            return item("Yes (但无法获取区域)");
        }
    };

    let region = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .and_then(|location| {
            location
                .split('/')
                .nth(3)
                .and_then(parse_country_segment)
                .or_else(|| location.split('/').nth(1).and_then(parse_country_segment))
        })
        .or_else(|| response.url().path().split('/').nth(1).and_then(parse_country_segment));

    match region {
        Some(code) => UnlockItem::checked_region(NETFLIX_NAME, "Yes", code),
        None => item("Yes"),
    }
}

async fn check_netflix_cdn(client: &Client) -> UnlockItem {
    let response = match client
        .get("https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5")
        .timeout(TIMEOUT)
        .send()
        .await
    {
        Ok(res) => res,
        Err(e) => {
            logging!(error, Type::Network, "Fast.com API 请求失败: {e}");
            return item("Failed (CDN API)");
        }
    };

    if response.status() == StatusCode::FORBIDDEN {
        return item("No (IP Banned By Netflix)");
    }

    match response.json::<FastResponse>().await {
        Ok(data) => data
            .targets
            .first()
            .map(|target| UnlockItem::checked_region(NETFLIX_NAME, "Yes", &target.location.country))
            .unwrap_or_else(|| item("Unknown")),
        Err(e) => {
            logging!(error, Type::Network, "解析 Fast.com API 响应失败: {e}");
            item("Failed (解析错误)")
        }
    }
}
