use super::CmdResult;
use crate::cmd::StringifyErr as _;
use crate::core::{proxy_control, sysopt::Sysopt};
use clash_verge_logging::{Type, logging};

use gethostname::gethostname;
use sysproxy::{Autoproxy, Sysproxy};
use tauri_plugin_clash_verge_sysinfo;

#[tauri::command]
#[specta::specta]
pub async fn get_sys_proxy() -> CmdResult<SystemProxy> {
    Sysopt::global().wait_idle().await;
    // With no network service there is no proxy configured anywhere, which reads as disabled.
    let sys_proxy = crate::process::AsyncHandler::spawn_blocking(|| match Sysproxy::get_system_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Ok(Sysproxy::default()),
        other => other,
    })
    .await
    .stringify_err()?
    .stringify_err()?;
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
    let auto_proxy = crate::process::AsyncHandler::spawn_blocking(|| match Autoproxy::get_auto_proxy() {
        Err(error) if proxy_control::is_missing_network_service(&error) => Ok(Autoproxy::default()),
        other => other,
    })
    .await
    .stringify_err()?
    .stringify_err()?;
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
    if sorted.len().is_multiple_of(2) {
        Some((sorted[mid - 1] + sorted[mid]) / 2)
    } else {
        Some(sorted[mid])
    }
}

fn calculate_rate_now(samples: &[(f64, u64)], window_secs: f64) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let Some(&(t_latest, b_latest)) = samples.last() else {
        return 0.0;
    };
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

fn calculate_steady_speed(samples: &[(f64, u64)], warmup_ratio: f64) -> f64 {
    if samples.len() < 2 {
        return 0.0;
    }
    let Some(&(t_end, b_end)) = samples.last() else {
        return 0.0;
    };
    let cutoff_t = t_end * warmup_ratio;
    let start_sample = samples.iter().find(|&&(t, _)| t >= cutoff_t).unwrap_or(&samples[0]);

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

// Compute throughput strictly between byte-completion timestamps so in-flight
// uploads aborted at the deadline do not inflate the time denominator.
fn calculate_steady_speed_discrete(steps: &[(f64, u64)]) -> f64 {
    let Some(&(t_last, b_last)) = steps.last() else {
        return 0.0;
    };
    if t_last <= 0.05 || b_last == 0 {
        return 0.0;
    }

    let cutoff_t = t_last * 0.3;
    let start = steps
        .iter()
        .find(|&&(t, _)| t >= cutoff_t && t < t_last)
        .or_else(|| steps.iter().rev().find(|&&(t, _)| t < t_last));

    if let Some(&(t_start, b_start)) = start {
        let dt = t_last - t_start;
        let db = b_last.saturating_sub(b_start);
        if dt > 0.05 && db > 0 {
            let mb = db as f64 / (1024.0 * 1024.0);
            return (mb / dt * 10.0).round() / 10.0;
        }
    }

    let mb = b_last as f64 / (1024.0 * 1024.0);
    (mb / t_last * 10.0).round() / 10.0
}

fn is_settled(samples: &[(f64, u64)], min_secs: f64) -> bool {
    let Some(&(t_end, _)) = samples.last() else {
        return false;
    };
    if t_end < min_secs {
        return false;
    }
    let mut rates = Vec::new();
    let mut k = samples.len() as isize - 1;
    while k >= 0 && (t_end - samples[k as usize].0) <= 2.5 {
        let rate = calculate_rate_now(&samples[..=k as usize], 1.0);
        if rate > 0.0 {
            rates.push(rate);
        }
        k -= 3;
    }
    if rates.len() >= 5 {
        let min_r = rates.iter().copied().fold(f64::INFINITY, f64::min);
        let max_r = rates.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let avg_r = rates.iter().sum::<f64>() / rates.len() as f64;
        if avg_r > 0.0 && (max_r - min_r) / avg_r <= 0.06 {
            return true;
        }
    }
    false
}

fn next_chunk_size(current_mb_s: f64, streams: usize, lo: usize, hi: usize) -> usize {
    let bytes_per_sec = (current_mb_s * 1024.0 * 1024.0) as usize;
    let want = if bytes_per_sec > 0 {
        (bytes_per_sec / streams.max(1)).clamp(lo, hi)
    } else {
        lo
    };
    want.div_ceil(32768) * 32768
}

fn generate_random_payload_block(size: usize) -> Vec<u8> {
    let mut buf = vec![0u8; size];
    let mut state: u32 = 0x8a5b3c1d;
    for chunk in buf.as_chunks_mut::<4>().0 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        chunk.copy_from_slice(&state.to_le_bytes());
    }
    buf
}

fn extract_cf_location(headers: &reqwest::header::HeaderMap) -> Option<String> {
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

    match (city, country) {
        (Some(c), Some(co)) => Some(format!("{c}, {co}")),
        (Some(c), None) => Some(c.to_string()),
        (None, Some(co)) => Some(co.to_string()),
        (None, None) => None,
    }
}

fn build_speedtest_client(port: u16, max_idle_per_host: usize) -> CmdResult<reqwest::Client> {
    use std::time::Duration;

    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| {
        super::CommandFailure::coded("speedtest.proxySetupFailed", format!("failed to create proxy: {e}"))
    })?;

    reqwest::Client::builder()
        .use_rustls_tls()
        // Force HTTP/1.1 so concurrent streams open independent TCP tunnels instead of
        // multiplexing over a single HTTP/2 connection throttled by static flow-control windows.
        .http1_only()
        .no_gzip()
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(30))
        .pool_max_idle_per_host(max_idle_per_host)
        .proxy(proxy)
        .build()
        .map_err(|e| {
            super::CommandFailure::coded(
                "speedtest.clientSetupFailed",
                format!("failed to build http client: {e}"),
            )
        })
}

async fn run_latency_probes(client: &reqwest::Client) -> CmdResult<(u32, f64, Option<String>)> {
    use std::time::{Duration, Instant};

    let mut location = match tokio::time::timeout(
        Duration::from_millis(3000),
        client.get("https://speed.cloudflare.com/__down?bytes=0").send(),
    )
    .await
    {
        Ok(Ok(resp)) if resp.status().is_success() => {
            let loc = extract_cf_location(resp.headers());
            // Drain the empty body so HTTP/1.1 keep-alive returns the connection to the pool.
            let _ = resp.bytes().await;
            loc
        }
        _ => None,
    };

    const PROBE_COUNT: usize = 10;
    let mut delays = Vec::with_capacity(PROBE_COUNT);
    let mut failed_probes = 0usize;

    for _ in 0..PROBE_COUNT {
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
                let effective_rtt = raw_rtt.saturating_sub(dur).max(1);
                delays.push(effective_rtt);

                if location.is_none() {
                    location = extract_cf_location(response.headers());
                }
                let _ = response.bytes().await;
            }
            _ => {
                failed_probes += 1;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    if delays.is_empty() {
        return Err(super::CommandFailure::coded(
            "speedtest.probeFailed",
            "all network probes timed out or failed",
        ));
    }

    let median_latency = calculate_median(&delays).unwrap_or(0);
    let loss_rate = (failed_probes as f64 / PROBE_COUNT as f64) * 100.0;
    let rounded_loss_rate = (loss_rate * 10.0).round() / 10.0;

    Ok((median_latency, rounded_loss_rate, location))
}

async fn download_stream_worker(
    client: reqwest::Client,
    stream_id: usize,
    total_dl_bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
    stop_download: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    const DOWNLOAD_STREAM_BYTES: usize = 25_000_000;
    let mut seq: u32 = 0;

    while !stop_download.load(Ordering::Relaxed) {
        let url = format!("https://speed.cloudflare.com/__down?bytes={DOWNLOAD_STREAM_BYTES}&s={stream_id}&n={seq}");
        seq = seq.wrapping_add(1);

        let resp_res = tokio::time::timeout(Duration::from_secs(8), client.get(&url).send()).await;
        if let Ok(Ok(mut resp)) = resp_res
            && resp.status().is_success()
        {
            while let Ok(Ok(Some(chunk))) = tokio::time::timeout(Duration::from_secs(3), resp.chunk()).await {
                total_dl_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                if stop_download.load(Ordering::Relaxed) {
                    break;
                }
            }
        } else if !stop_download.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

fn spawn_download_workers(
    client: &reqwest::Client,
    streams: usize,
    total_dl_bytes: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    stop_download: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Vec<tokio::task::JoinHandle<()>> {
    use std::sync::Arc;

    let mut handles = Vec::with_capacity(streams);
    for stream_id in 0..streams {
        handles.push(tokio::spawn(download_stream_worker(
            client.clone(),
            stream_id,
            Arc::clone(total_dl_bytes),
            Arc::clone(stop_download),
        )));
    }
    handles
}

async fn run_download_test(
    client: &reqwest::Client,
    on_progress: &tauri::ipc::Channel<SpeedTestProgress>,
    median_latency: u32,
    rounded_loss_rate: f64,
    location: Option<&str>,
) -> f64 {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    const DOWNLOAD_STREAMS: usize = 8;
    // Cloudflare limits single __down request to 50MB (larger requests return 403 Forbidden).
    // 25MB per stream across 8 concurrent streams generates an initial 200MB download pool.
    const DOWNLOAD_MIN_SETTLE_BYTES: u64 = 60 * 1024 * 1024;
    const DOWNLOAD_MAX_BYTES: u64 = 180 * 1024 * 1024;
    const DOWNLOAD_MIN_DURATION: Duration = Duration::from_secs(5);
    const DOWNLOAD_FALLBACK_SETTLE_DURATION: Duration = Duration::from_secs(7);
    const DOWNLOAD_MIN_CAP_DURATION: Duration = Duration::from_secs(3);
    const DOWNLOAD_MAX_DURATION: Duration = Duration::from_secs(10);
    const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(6);

    let total_dl_bytes = Arc::new(AtomicU64::new(0));
    let stop_download = Arc::new(AtomicBool::new(false));
    let dl_handles = spawn_download_workers(client, DOWNLOAD_STREAMS, &total_dl_bytes, &stop_download);

    // Wait for initial packets to flow so proxy CONNECT + TLS handshakes
    // do not artificially depress initial steady-state throughput.
    let wait_start = Instant::now();
    while total_dl_bytes.load(Ordering::Relaxed) == 0 && wait_start.elapsed() < FIRST_BYTE_TIMEOUT {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let dl_start = Instant::now();
    let base_bytes = total_dl_bytes.load(Ordering::Relaxed);
    let mut dl_samples: Vec<(f64, u64)> = Vec::with_capacity(120);
    dl_samples.push((0.0, 0));
    let mut last_dl_progress = Instant::now();

    while dl_start.elapsed() < DOWNLOAD_MAX_DURATION {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let elapsed_secs = dl_start.elapsed().as_secs_f64();
        let bytes = total_dl_bytes.load(Ordering::Relaxed).saturating_sub(base_bytes);
        dl_samples.push((elapsed_secs, bytes));

        let current_rate = calculate_rate_now(&dl_samples, 1.5);

        if last_dl_progress.elapsed() >= Duration::from_millis(200) {
            if on_progress
                .send(SpeedTestProgress {
                    stage: "download".to_string(),
                    latency: Some(median_latency),
                    loss_rate: Some(rounded_loss_rate),
                    download_speed: Some(current_rate),
                    upload_speed: None,
                    location: location.map(str::to_string),
                    timestamp: None,
                    error: None,
                })
                .is_err()
            {
                break;
            }
            last_dl_progress = Instant::now();
        }

        let elapsed = dl_start.elapsed();
        if bytes >= DOWNLOAD_MAX_BYTES && elapsed >= DOWNLOAD_MIN_CAP_DURATION {
            break;
        }

        let can_early_settle = bytes >= DOWNLOAD_MIN_SETTLE_BYTES || elapsed >= DOWNLOAD_FALLBACK_SETTLE_DURATION;
        if can_early_settle && is_settled(&dl_samples, DOWNLOAD_MIN_DURATION.as_secs_f64()) {
            break;
        }
    }

    stop_download.store(true, Ordering::Relaxed);
    for h in dl_handles {
        h.abort();
        let _ = h.await;
    }

    calculate_steady_speed(&dl_samples, 0.35)
}

async fn upload_stream_worker(
    client: reqwest::Client,
    total_ul_bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
    stop_upload: std::sync::Arc<std::sync::atomic::AtomicBool>,
    current_ul_chunk: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    random_payload: bytes::Bytes,
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    while !stop_upload.load(Ordering::Relaxed) {
        let chunk_size = current_ul_chunk.load(Ordering::Relaxed).min(random_payload.len());
        let payload = random_payload.slice(..chunk_size);

        let resp_res = tokio::time::timeout(
            Duration::from_secs(12),
            client.post("https://speed.cloudflare.com/__up").body(payload).send(),
        )
        .await;

        if let Ok(Ok(resp)) = resp_res
            && resp.status().is_success()
        {
            let _ = resp.bytes().await;
            total_ul_bytes.fetch_add(chunk_size as u64, Ordering::Relaxed);
        } else if !stop_upload.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

fn spawn_upload_workers(
    client: &reqwest::Client,
    streams: usize,
    total_ul_bytes: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    stop_upload: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    current_ul_chunk: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    random_payload: &bytes::Bytes,
) -> Vec<tokio::task::JoinHandle<()>> {
    use std::sync::Arc;

    let mut handles = Vec::with_capacity(streams);
    for _ in 0..streams {
        handles.push(tokio::spawn(upload_stream_worker(
            client.clone(),
            Arc::clone(total_ul_bytes),
            Arc::clone(stop_upload),
            Arc::clone(current_ul_chunk),
            random_payload.clone(),
        )));
    }
    handles
}

async fn run_upload_test(
    client: &reqwest::Client,
    on_progress: &tauri::ipc::Channel<SpeedTestProgress>,
    median_latency: u32,
    rounded_loss_rate: f64,
    final_dl_speed: f64,
    location: Option<&str>,
) -> f64 {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    const UPLOAD_STREAMS: usize = 6;
    const UPLOAD_MIN_CHUNK: usize = 32 * 1024;
    const UPLOAD_MAX_CHUNK: usize = 8 * 1024 * 1024;
    const UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
    const UPLOAD_MIN_CAP_DURATION: Duration = Duration::from_secs(3);
    const UPLOAD_MAX_DURATION: Duration = Duration::from_secs(10);
    const UPLOAD_MIN_DURATION: Duration = Duration::from_secs(5);

    let ul_start = Instant::now();
    let total_ul_bytes = Arc::new(AtomicU64::new(0));
    let stop_upload = Arc::new(AtomicBool::new(false));
    let current_ul_chunk = Arc::new(AtomicUsize::new(UPLOAD_MIN_CHUNK));
    let random_payload = bytes::Bytes::from(generate_random_payload_block(UPLOAD_MAX_CHUNK));
    let ul_handles = spawn_upload_workers(
        client,
        UPLOAD_STREAMS,
        &total_ul_bytes,
        &stop_upload,
        &current_ul_chunk,
        &random_payload,
    );

    let mut ul_samples: Vec<(f64, u64)> = Vec::with_capacity(100);
    let mut ul_steps: Vec<(f64, u64)> = Vec::with_capacity(100);
    ul_samples.push((0.0, 0));
    let mut prev_bytes = 0u64;
    let mut last_ul_progress = Instant::now();

    while ul_start.elapsed() < UPLOAD_MAX_DURATION {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let elapsed_secs = ul_start.elapsed().as_secs_f64();
        let bytes = total_ul_bytes.load(Ordering::Relaxed);
        ul_samples.push((elapsed_secs, bytes));

        if bytes > prev_bytes {
            ul_steps.push((elapsed_secs, bytes));
            prev_bytes = bytes;
        }

        let current_rate = calculate_rate_now(&ul_samples, 1.5);
        let next_chunk = next_chunk_size(current_rate, UPLOAD_STREAMS, UPLOAD_MIN_CHUNK, UPLOAD_MAX_CHUNK);
        current_ul_chunk.store(next_chunk, Ordering::Relaxed);

        if last_ul_progress.elapsed() >= Duration::from_millis(200) {
            if on_progress
                .send(SpeedTestProgress {
                    stage: "upload".to_string(),
                    latency: Some(median_latency),
                    loss_rate: Some(rounded_loss_rate),
                    download_speed: Some(final_dl_speed),
                    upload_speed: Some(current_rate),
                    location: location.map(str::to_string),
                    timestamp: None,
                    error: None,
                })
                .is_err()
            {
                break;
            }
            last_ul_progress = Instant::now();
        }

        let elapsed = ul_start.elapsed();
        if bytes >= UPLOAD_MAX_BYTES && elapsed >= UPLOAD_MIN_CAP_DURATION {
            break;
        }

        if is_settled(&ul_samples, UPLOAD_MIN_DURATION.as_secs_f64()) {
            break;
        }
    }

    stop_upload.store(true, Ordering::Relaxed);
    for h in ul_handles {
        h.abort();
        let _ = h.await;
    }

    calculate_steady_speed_discrete(&ul_steps)
}

#[tauri::command]
#[specta::specta]
pub async fn test_network_speed(on_progress: tauri::ipc::Channel<SpeedTestProgress>) -> CmdResult<SpeedTestResult> {
    use std::sync::atomic::Ordering;

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

    let dl_client = build_speedtest_client(port, 8)?;

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

    let (median_latency, rounded_loss_rate, location) = match run_latency_probes(&dl_client).await {
        Ok(res) => res,
        Err(err) => {
            let _ = on_progress.send(SpeedTestProgress {
                stage: "error".to_string(),
                latency: None,
                loss_rate: Some(100.0),
                download_speed: None,
                upload_speed: None,
                location: None,
                timestamp: None,
                error: Some(err.detail.clone()),
            });
            return Err(err);
        }
    };

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

    let final_dl_speed = run_download_test(
        &dl_client,
        &on_progress,
        median_latency,
        rounded_loss_rate,
        location.as_deref(),
    )
    .await;

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

    // Use a fresh client so connections aborted mid-body during download cannot interfere with uploads.
    let ul_client = build_speedtest_client(port, 6)?;
    let final_ul_speed = run_upload_test(
        &ul_client,
        &on_progress,
        median_latency,
        rounded_loss_rate,
        final_dl_speed,
        location.as_deref(),
    )
    .await;

    let timestamp = chrono::Local::now().format("%Y/%m/%d %H:%M").to_string();
    let final_location = location.unwrap_or_else(|| "Unknown".to_string());

    let result = SpeedTestResult {
        latency: median_latency,
        loss_rate: rounded_loss_rate,
        download_speed: final_dl_speed,
        upload_speed: final_ul_speed,
        location: final_location,
        timestamp,
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
    if port == 0 {
        return Err(super::CommandFailure::coded(
            "dnsleak.portUnavailable",
            "proxy port is unavailable; aborted DNS leak probe to prevent physical leak",
        ));
    }

    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| {
        super::CommandFailure::coded("dnsleak.proxyConfigFailed", format!("invalid proxy configuration: {e}"))
    })?;

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(8))
        .proxy(proxy)
        .build()
        .map_err(|e| {
            super::CommandFailure::coded("dnsleak.clientSetupFailed", format!("failed to build client: {e}"))
        })?;

    // RFC 952/1123 合规：DNS 标签只允许小写字母和数字，严禁包含下划线或以连字符开头
    #[rustfmt::skip]
    const DNS_ID_ALPHABET: [char; 36] = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
        'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't',
        'u', 'v', 'w', 'x', 'y', 'z',
    ];
    let test_id = nanoid::nanoid!(16, &DNS_ID_ALPHABET);

    // 1. 触发请求：由于客户端配置了 HTTP 代理，reqwest 向 127.0.0.1:{port} 发送 CONNECT {test_id}.bash.ws:443
    // 客户端本地绝对不会调用操作系统的 getaddrinfo，从而完全杜绝物理网卡和路由器 DNS 的介入！
    let trigger_res = client.get(format!("https://{test_id}.bash.ws")).send().await;
    if let Err(ref e) = trigger_res {
        logging!(debug, Type::Cmd, "DNS leak trigger request probe result: {e}");
    }

    // 2. 获取检测结果
    let res = client
        .get(format!("https://bash.ws/dnsleak/test/{test_id}?json"))
        .send()
        .await
        .map_err(|e| {
            super::CommandFailure::coded("dnsleak.fetchFailed", format!("failed to fetch test result: {e}"))
        })?;

    let text = res
        .text()
        .await
        .map_err(|e| super::CommandFailure::coded("dnsleak.decodeFailed", format!("failed to read response: {e}")))?;

    Ok(text)
}
