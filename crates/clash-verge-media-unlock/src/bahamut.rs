use reqwest::{Client, header::USER_AGENT};
use serde::Deserialize;

use super::UnlockItem;

pub(crate) const BAHAMUT_ANIME_NAME: &str = "Bahamut Anime";
const BAHAMUT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
                                  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

#[derive(Deserialize)]
struct DeviceResponse {
    deviceid: String,
}

fn encode_query_component(input: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub(super) async fn check_bahamut_anime(client: &Client) -> UnlockItem {
    let get = |url: &str| client.get(url).header(USER_AGENT, BAHAMUT_USER_AGENT);
    let device = get("https://ani.gamer.com.tw/ajax/getdeviceid.php").send().await.ok();

    let device = match device {
        Some(res) => res.json::<DeviceResponse>().await.ok(),
        None => None,
    };

    let Some(device) = device else {
        return UnlockItem::checked(BAHAMUT_ANIME_NAME, "Failed", None);
    };
    let device_id = device.deviceid.trim();
    if device_id.is_empty() {
        return UnlockItem::checked(BAHAMUT_ANIME_NAME, "Failed", None);
    }

    let token_url = format!(
        "https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=37783&device={}",
        encode_query_component(device_id)
    );

    let unlocked = match get(&token_url).send().await {
        Ok(res) => res.text().await.is_ok_and(|body| body.contains("animeSn")),
        Err(_) => false,
    };

    if !unlocked {
        return UnlockItem::checked(BAHAMUT_ANIME_NAME, "No", None);
    }

    let region = match get("https://ani.gamer.com.tw/").send().await {
        Ok(res) => res.text().await.ok().and_then(|body| {
            body.split_once("data-geo=\"")
                .and_then(|(_, rest)| rest.split_once('"'))
                .map(|(code, _)| UnlockItem::region_label(code))
        }),
        Err(_) => None,
    };

    UnlockItem::checked(BAHAMUT_ANIME_NAME, "Yes", region)
}
