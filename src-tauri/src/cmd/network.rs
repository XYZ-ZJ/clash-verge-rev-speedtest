use super::CmdResult;
use crate::cmd::StringifyErr as _;
use crate::core::{proxy_control, sysopt::Sysopt};

use gethostname::gethostname;
use sysproxy::{Autoproxy, Sysproxy};
use tauri_plugin_clash_verge_sysinfo;

#[tauri::command]
#[specta::specta]
pub async fn get_sys_proxy() -> CmdResult<SystemProxy> {
    Sysopt::global().wait_idle().await;
    // With no network service there is no proxy configured anywhere, which reads as disabled.
    let sys_proxy = match Sysproxy::get_system_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Sysproxy::default(),
        other => other.stringify_err()?,
    };
    let Sysproxy {
        host,
        bypass,
        port,
        enable,
    } = sys_proxy;

    Ok(SystemProxy {
        enable,
        server: format!("{host}:{port}"),
        bypass,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_auto_proxy() -> CmdResult<AutoProxy> {
    Sysopt::global().wait_idle().await;
    let auto_proxy = match Autoproxy::get_auto_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Autoproxy::default(),
        other => other.stringify_err()?,
    };
    let Autoproxy { enable, url } = auto_proxy;

    Ok(AutoProxy { enable, url })
}

#[tauri::command]
#[specta::specta]
pub fn get_embedded_server_port() -> CmdResult<u16> {
    crate::utils::server::embedded_server_port().stringify_err()
}

#[tauri::command]
#[specta::specta]
pub fn get_system_hostname() -> String {
    match gethostname().into_string() {
        Ok(name) => name,
        Err(os_string) => {
            let fallback = format!("{os_string:?}");
            fallback.trim_matches('"').to_string()
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_network_interfaces() -> Vec<String> {
    tauri_plugin_clash_verge_sysinfo::list_network_interfaces()
}

#[tauri::command]
#[specta::specta]
pub fn get_network_interfaces_info() -> CmdResult<Vec<crate::ipc::NetworkInterfaceView>> {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};

    let names = get_network_interfaces();
    let interfaces = NetworkInterface::show().stringify_err()?;

    let mut result = Vec::new();

    for interface in interfaces {
        if names.contains(&interface.name) {
            result.push(interface.into());
        }
    }

    Ok(result)
}

#[derive(serde::Serialize, specta::Type)]
pub struct SystemProxy {
    pub enable: bool,
    pub server: String,
    pub bypass: String,
}

#[derive(serde::Serialize, specta::Type)]
pub struct AutoProxy {
    pub enable: bool,
    pub url: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SpeedTestProgress {
    pub stage: String,
    pub latency: Option<u32>,
    pub loss_rate: Option<f64>,
    pub download_speed: Option<f64>,
    pub upload_speed: Option<f64>,
    pub location: Option<String>,
    pub timestamp: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SpeedTestResult {
    pub latency: u32,
    pub loss_rate: f64,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub location: String,
    pub timestamp: String,
}

static SPEEDTEST_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn parse_server_timing_dur(header_val: &str) -> Option<f64> {
    for part in header_val.split(',') {
        let part = part.trim();
        if let Some(idx) = part.find("dur=") {
            let val_str = &part[idx + 4..];
            let end_idx = val_str.find(';').unwrap_or(val_str.len());
            if let Ok(dur) = val_str[..end_idx].trim().parse::<f64>() {
                return Some(dur);
            }
        }
    }
    None
}

fn calculate_median(samples: &[u32]) -> Option<u32> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        Some((sorted[mid - 1] + sorted[mid]) / 2)
    } else {
        Some(sorted[mid])
    }
}

fn calculate_rate_now(samples: &[(f64, u64)], window_secs: f64) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let &(t_latest, b_latest) = samples.last().unwrap();
    let mut i = samples.len() - 1;
    while i > 0 && (t_latest - samples[i - 1].0) <= window_secs {
        i -= 1;
    }
    let &(t_old, b_old) = &samples[if i == samples.len() - 1 { i - 1 } else { i }];
    let dt = t_latest - t_old;
    let db = b_latest.saturating_sub(b_old);
    if dt > 0.02 {
        let mb = db as f64 / (1024.0 * 1024.0);
        (mb / dt * 10.0).round() / 10.0
    } else {
        0.0
    }
}

fn calculate_steady_speed(samples: &[(f64, u64)]) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let &(t_end, b_end) = samples.last().unwrap();
    let cutoff_t = t_end * 0.3; // 剔除前 30% TCP Slow Start 阶段
    let start_sample = samples
        .iter()
        .find(|&&(t, _)| t >= cutoff_t)
        .unwrap_or(&samples[0]);

    let dt = t_end - start_sample.0;
    let db = b_end.saturating_sub(start_sample.1);
    if dt > 0.05 && db > 0 {
        let mb = db as f64 / (1024.0 * 1024.0);
        (mb / dt * 10.0).round() / 10.0
    } else if t_end > 0.05 && b_end > 0 {
        let mb = b_end as f64 / (1024.0 * 1024.0);
        (mb / t_end * 10.0).round() / 10.0
    } else {
        0.0
    }
}

fn is_settled(samples: &[(f64, u64)], min_secs: f64) -> bool {
    if samples.is_empty() {
        return false;
    }
    let t_end = samples.last().unwrap().0;
    if t_end < min_secs {
        return false;
    }
    let mut rates = Vec::new();
    let mut k = samples.len() as isize - 1;
    while k >= 0 && (t_end - samples[k as usize].0) <= 2.0 {
        let rate = calculate_rate_now(&samples[..=k as usize], 0.8);
        if rate > 0.0 {
            rates.push(rate);
        }
        k -= 3;
    }
    if rates.len() >= 4 {
        let min_r = rates.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_r = rates.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let avg_r = rates.iter().sum::<f64>() / rates.len() as f64;
        if avg_r > 0.0 && (max_r - min_r) / avg_r <= 0.08 {
            return true;
        }
    }
    false
}

fn next_chunk_size(current_mb_s: f64, streams: usize, lo: usize, hi: usize) -> usize {
    let bytes_per_sec = (current_mb_s * 1024.0 * 1024.0) as usize;
    let want = if bytes_per_sec > 0 {
        (bytes_per_sec / streams.max(1)).max(lo).min(hi)
    } else {
        lo
    };
    ((want + 65535) / 65536) * 65536
}

fn generate_random_payload_block(size: usize) -> Vec<u8> {
    let mut buf = vec![0u8; size];
    let mut state: u32 = 0x8a5b3c1d;
    for chunk in buf.chunks_exact_mut(4) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        chunk.copy_from_slice(&state.to_le_bytes());
    }
    buf
}

#[tauri::command]
#[specta::specta]
pub async fn test_network_speed(
    on_progress: tauri::ipc::Channel<SpeedTestProgress>,
) -> CmdResult<SpeedTestResult> {
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    if SPEEDTEST_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(super::CommandFailure::coded(
            "speedtest.busy",
            "a speed test is already running",
        ));
    }

    let _guard = scopeguard::guard((), |_| {
        SPEEDTEST_RUNNING.store(false, Ordering::SeqCst);
    });

    let port = crate::config::MixedPort::effective().await;
    if port == 0 {
        return Err(super::CommandFailure::coded(
            "speedtest.noPort",
            "core is not running or the proxy port is unavailable",
        ));
    }

    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|e| {
            super::CommandFailure::coded("speedtest.proxySetupFailed", format!("failed to create proxy: {e}"))
        })?;

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .tcp_keepalive(Duration::from_secs(30))
        .proxy(proxy)
        .build()
        .map_err(|e| {
            super::CommandFailure::coded("speedtest.clientSetupFailed", format!("failed to build http client: {e}"))
        })?;

    let _ = on_progress.send(SpeedTestProgress {
        stage: "start".to_string(),
        latency: None,
        loss_rate: None,
        download_speed: None,
        upload_speed: None,
        location: None,
        timestamp: None,
        error: None,
    });

    // Phase 1: Ping / Latency, packet loss, and location
    // First, 1 warm-up request to establish TLS tunnel and retrieve location metadata
    let mut location: Option<String> = None;
    if let Ok(Ok(resp)) = tokio::time::timeout(
        Duration::from_millis(3000),
        client.get("https://speed.cloudflare.com/__down?bytes=0").send(),
    )
    .await
    {
        if resp.status().is_success() {
            let headers = resp.headers();
            let city = headers
                .get("cf-meta-city")
                .or_else(|| headers.get("city"))
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let country = headers
                .get("cf-meta-country")
                .or_else(|| headers.get("country"))
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty());

            location = match (city, country) {
                (Some(c), Some(co)) => Some(format!("{c}, {co}")),
                (Some(c), None) => Some(c.to_string()),
                (None, Some(co)) => Some(co.to_string()),
                (None, None) => None,
            };
        }
    }

    let probe_count = 10;
    let mut delays = Vec::with_capacity(probe_count);
    let mut failed_probes = 0;

    for _ in 0..probe_count {
        let t0 = Instant::now();
        let resp = tokio::time::timeout(
            Duration::from_millis(2000),
            client.get("https://speed.cloudflare.com/__down?bytes=0").send(),
        )
        .await;

        match resp {
            Ok(Ok(response)) if response.status().is_success() => {
                let raw_rtt = t0.elapsed().as_millis() as u32;
                let dur = response
                    .headers()
                    .get("server-timing")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_server_timing_dur)
                    .unwrap_or(0.0) as u32;
                // Subtract Cloudflare Worker processing duration to get true network RTT
                let effective_rtt = raw_rtt.saturating_sub(dur).max(1);
                delays.push(effective_rtt);

                if location.is_none() {
                    let headers = response.headers();
                    let city = headers
                        .get("cf-meta-city")
                        .or_else(|| headers.get("city"))
                        .and_then(|v| v.to_str().ok())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let country = headers
                        .get("cf-meta-country")
                        .or_else(|| headers.get("country"))
                        .and_then(|v| v.to_str().ok())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());

                    location = match (city, country) {
                        (Some(c), Some(co)) => Some(format!("{c}, {co}")),
                        (Some(c), None) => Some(c.to_string()),
                        (None, Some(co)) => Some(co.to_string()),
                        (None, None) => None,
                    };
                }
            }
            _ => {
                failed_probes += 1;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    if delays.is_empty() {
        let err_msg = "all network probes timed out or failed";
        let _ = on_progress.send(SpeedTestProgress {
            stage: "error".to_string(),
            latency: None,
            loss_rate: Some(100.0),
            download_speed: None,
            upload_speed: None,
            location: None,
            timestamp: None,
            error: Some(err_msg.to_string()),
        });
        return Err(super::CommandFailure::coded(
            "speedtest.probeFailed",
            err_msg,
        ));
    }

    let median_latency = calculate_median(&delays).unwrap_or(0);
    let loss_rate = (failed_probes as f64 / probe_count as f64) * 100.0;
    let rounded_loss_rate = (loss_rate * 10.0).round() / 10.0;

    let _ = on_progress.send(SpeedTestProgress {
        stage: "ping".to_string(),
        latency: Some(median_latency),
        loss_rate: Some(rounded_loss_rate),
        download_speed: None,
        upload_speed: None,
        location: location.clone(),
        timestamp: None,
        error: None,
    });

    // Phase 2: Multi-stream download test
    const DOWNLOAD_STREAMS: usize = 4;
    const DOWNLOAD_MAX_DURATION: Duration = Duration::from_secs(8);
    const DOWNLOAD_MIN_DURATION: Duration = Duration::from_secs(4);

    let dl_start = Instant::now();
    let total_dl_bytes = Arc::new(AtomicU64::new(0));
    let stop_download = Arc::new(AtomicBool::new(false));
    let current_dl_chunk = Arc::new(AtomicUsize::new(512 * 1024)); // 512KB start

    let mut dl_handles = Vec::with_capacity(DOWNLOAD_STREAMS);
    for _ in 0..DOWNLOAD_STREAMS {
        let client = client.clone();
        let total_dl_bytes = total_dl_bytes.clone();
        let stop_download = stop_download.clone();
        let current_dl_chunk = current_dl_chunk.clone();

        dl_handles.push(tokio::spawn(async move {
            while !stop_download.load(Ordering::Relaxed) {
                let chunk_size = current_dl_chunk.load(Ordering::Relaxed);
                let url = format!("https://speed.cloudflare.com/__down?bytes={chunk_size}");
                let resp_res = tokio::time::timeout(
                    Duration::from_secs(6),
                    client.get(&url).send(),
                )
                .await;

                match resp_res {
                    Ok(Ok(mut resp)) if resp.status().is_success() => {
                        while let Ok(Ok(Some(chunk))) = tokio::time::timeout(Duration::from_secs(2), resp.chunk()).await {
                            total_dl_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                            if stop_download.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                    }
                    _ => {
                        if stop_download.load(Ordering::Relaxed) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
            }
        }));
    }

    let mut dl_samples: Vec<(f64, u64)> = Vec::with_capacity(100);
    dl_samples.push((0.0, 0));
    let mut last_dl_progress = Instant::now();

    while dl_start.elapsed() < DOWNLOAD_MAX_DURATION {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let elapsed_secs = dl_start.elapsed().as_secs_f64();
        let bytes = total_dl_bytes.load(Ordering::Relaxed);
        dl_samples.push((elapsed_secs, bytes));

        let current_rate = calculate_rate_now(&dl_samples, 1.0);
        let next_chunk = next_chunk_size(current_rate, DOWNLOAD_STREAMS, 256 * 1024, 25 * 1024 * 1024);
        current_dl_chunk.store(next_chunk, Ordering::Relaxed);

        if last_dl_progress.elapsed() >= Duration::from_millis(200) {
            let _ = on_progress.send(SpeedTestProgress {
                stage: "download".to_string(),
                latency: Some(median_latency),
                loss_rate: Some(rounded_loss_rate),
                download_speed: Some(current_rate),
                upload_speed: None,
                location: location.clone(),
                timestamp: None,
                error: None,
            });
            last_dl_progress = Instant::now();
        }

        if is_settled(&dl_samples, DOWNLOAD_MIN_DURATION.as_secs_f64()) {
            break;
        }
    }

    stop_download.store(true, Ordering::Relaxed);
    for h in dl_handles {
        let _ = h.await;
    }

    let final_dl_speed = calculate_steady_speed(&dl_samples);

    let _ = on_progress.send(SpeedTestProgress {
        stage: "upload_start".to_string(),
        latency: Some(median_latency),
        loss_rate: Some(rounded_loss_rate),
        download_speed: Some(final_dl_speed),
        upload_speed: Some(0.0),
        location: location.clone(),
        timestamp: None,
        error: None,
    });

    // Phase 3: Multi-stream upload test with incompressible random payload
    const UPLOAD_STREAMS: usize = 3;
    const UPLOAD_MAX_DURATION: Duration = Duration::from_secs(6);
    const UPLOAD_MIN_DURATION: Duration = Duration::from_secs(3);

    let ul_start = Instant::now();
    let total_ul_bytes = Arc::new(AtomicU64::new(0));
    let stop_upload = Arc::new(AtomicBool::new(false));
    let current_ul_chunk = Arc::new(AtomicUsize::new(256 * 1024));
    let random_seed_buffer = Arc::new(generate_random_payload_block(1024 * 1024));

    let mut ul_handles = Vec::with_capacity(UPLOAD_STREAMS);
    for _ in 0..UPLOAD_STREAMS {
        let client = client.clone();
        let total_ul_bytes = total_ul_bytes.clone();
        let stop_upload = stop_upload.clone();
        let current_ul_chunk = current_ul_chunk.clone();
        let random_buf = random_seed_buffer.clone();

        ul_handles.push(tokio::spawn(async move {
            while !stop_upload.load(Ordering::Relaxed) {
                let chunk_size = current_ul_chunk.load(Ordering::Relaxed);
                let payload = if chunk_size <= random_buf.len() {
                    random_buf[..chunk_size].to_vec()
                } else {
                    let mut data = Vec::with_capacity(chunk_size);
                    while data.len() < chunk_size {
                        let needed = chunk_size - data.len();
                        let take = needed.min(random_buf.len());
                        data.extend_from_slice(&random_buf[..take]);
                    }
                    data
                };

                let resp_res = tokio::time::timeout(
                    Duration::from_secs(6),
                    client
                        .post("https://speed.cloudflare.com/__up")
                        .body(payload)
                        .send(),
                )
                .await;

                match resp_res {
                    Ok(Ok(resp)) if resp.status().is_success() => {
                        total_ul_bytes.fetch_add(chunk_size as u64, Ordering::Relaxed);
                    }
                    _ => {
                        if stop_upload.load(Ordering::Relaxed) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
            }
        }));
    }

    let mut ul_samples: Vec<(f64, u64)> = Vec::with_capacity(100);
    ul_samples.push((0.0, 0));
    let mut last_ul_progress = Instant::now();

    while ul_start.elapsed() < UPLOAD_MAX_DURATION {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let elapsed_secs = ul_start.elapsed().as_secs_f64();
        let bytes = total_ul_bytes.load(Ordering::Relaxed);
        ul_samples.push((elapsed_secs, bytes));

        let current_rate = calculate_rate_now(&ul_samples, 1.0);
        let next_chunk = next_chunk_size(current_rate, UPLOAD_STREAMS, 256 * 1024, 4 * 1024 * 1024);
        current_ul_chunk.store(next_chunk, Ordering::Relaxed);

        if last_ul_progress.elapsed() >= Duration::from_millis(200) {
            let _ = on_progress.send(SpeedTestProgress {
                stage: "upload".to_string(),
                latency: Some(median_latency),
                loss_rate: Some(rounded_loss_rate),
                download_speed: Some(final_dl_speed),
                upload_speed: Some(current_rate),
                location: location.clone(),
                timestamp: None,
                error: None,
            });
            last_ul_progress = Instant::now();
        }

        if is_settled(&ul_samples, UPLOAD_MIN_DURATION.as_secs_f64()) {
            break;
        }
    }

    stop_upload.store(true, Ordering::Relaxed);
    for h in ul_handles {
        let _ = h.await;
    }

    let final_ul_speed = calculate_steady_speed(&ul_samples);

    let timestamp = chrono::Local::now().format("%Y/%m/%d %H:%M").to_string();
    let final_location = location.unwrap_or_else(|| "Unknown".to_string());

    let result = SpeedTestResult {
        latency: median_latency,
        loss_rate: rounded_loss_rate,
        download_speed: final_dl_speed,
        upload_speed: final_ul_speed,
        location: final_location.clone(),
        timestamp: timestamp.clone(),
    };

    let _ = on_progress.send(SpeedTestProgress {
        stage: "finished".to_string(),
        latency: Some(result.latency),
        loss_rate: Some(result.loss_rate),
        download_speed: Some(result.download_speed),
        upload_speed: Some(result.upload_speed),
        location: Some(result.location.clone()),
        timestamp: Some(result.timestamp.clone()),
        error: None,
    });

    Ok(result)
}



#[tauri::command]
#[specta::specta]
pub async fn test_dns_leak() -> CmdResult<std::string::String> {
    use std::time::Duration;

    let port = crate::config::MixedPort::effective().await;
    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(8));

    if port > 0 {
        if let Ok(proxy) = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")) {
            builder = builder.proxy(proxy);
        }
    }

    let client = builder.build().map_err(|e| {
        super::CommandFailure::coded("dnsleak.clientSetupFailed", format!("failed to build client: {e}"))
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let test_id = format!("{:x}{:x}", now, std::process::id());

    // 1. 触发请求：由于客户端配置了 HTTP 代理，reqwest 向 127.0.0.1:{port} 发送 CONNECT {test_id}.bash.ws:443
    // 客户端本地绝对不会调用操作系统的 getaddrinfo，从而完全杜绝物理网卡和路由器 DNS 的介入！
    let _ = client.get(format!("https://{test_id}.bash.ws")).send().await;

    // 2. 获取检测结果
    let res = client
        .get(format!("https://bash.ws/dnsleak/test/{test_id}?json"))
        .send()
        .await
        .map_err(|e| super::CommandFailure::coded("dnsleak.fetchFailed", format!("failed to fetch test result: {e}")))?;

    let text = res
        .text()
        .await
        .map_err(|e| super::CommandFailure::coded("dnsleak.decodeFailed", format!("failed to read response: {e}")))?;

    Ok(text)
}
