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

#[tauri::command]
#[specta::specta]
pub async fn test_network_speed(
    on_progress: tauri::ipc::Channel<SpeedTestProgress>,
) -> CmdResult<SpeedTestResult> {
    use std::sync::atomic::Ordering;
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
    let probe_count = 8;
    let mut delays = Vec::with_capacity(probe_count);
    let mut failed_probes = 0;
    let mut location: Option<String> = None;

    for _ in 0..probe_count {
        let t0 = Instant::now();
        let resp = tokio::time::timeout(
            Duration::from_millis(2500),
            client.get("https://speed.cloudflare.com/__down?bytes=0").send(),
        )
        .await;

        match resp {
            Ok(Ok(response)) if response.status().is_success() => {
                let rtt = t0.elapsed().as_millis() as u32;
                delays.push(rtt);

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
        tokio::time::sleep(Duration::from_millis(40)).await;
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

    // The first probe pays for DNS + TCP + TLS through the proxy tunnel; drop the
    // slowest sample so one handshake cannot skew the average.
    let avg_latency = if delays.len() >= 3 {
        let max = *delays.iter().max().unwrap();
        (delays.iter().sum::<u32>() - max) / ((delays.len() - 1) as u32)
    } else {
        delays.iter().sum::<u32>() / (delays.len() as u32)
    };
    let loss_rate = (failed_probes as f64 / probe_count as f64) * 100.0;
    let rounded_loss_rate = (loss_rate * 10.0).round() / 10.0;

    let _ = on_progress.send(SpeedTestProgress {
        stage: "ping".to_string(),
        latency: Some(avg_latency),
        loss_rate: Some(rounded_loss_rate),
        download_speed: None,
        upload_speed: None,
        location: location.clone(),
        timestamp: None,
        error: None,
    });

    // Phase 2: Download test
    let dl_start = Instant::now();
    let max_dl_duration = Duration::from_secs(8);
    let mut total_dl_bytes = 0u64;
    let mut last_progress = Instant::now();
    // Sliding window of recent samples for the early-exit stability check.
    let mut window: std::collections::VecDeque<(f64, u64)> =
        std::collections::VecDeque::with_capacity(8);
    let mut stable_ticks = 0u32;

    if let Ok(Ok(mut resp)) = tokio::time::timeout(
        Duration::from_secs(10),
        client.get("https://speed.cloudflare.com/__down?bytes=25000000").send(),
    )
    .await
    {
        if resp.status().is_success() {
            while let Ok(Ok(Some(chunk))) = tokio::time::timeout(Duration::from_secs(2), resp.chunk()).await {
                total_dl_bytes += chunk.len() as u64;
                let elapsed = dl_start.elapsed();
                let elapsed_secs = elapsed.as_secs_f64();

                if last_progress.elapsed() >= Duration::from_millis(200) {
                    let secs = elapsed_secs;
                    if secs > 0.05 {
                        let mb = (total_dl_bytes as f64) / (1024.0 * 1024.0);
                        let spd = (mb / secs * 10.0).round() / 10.0;
                        let _ = on_progress.send(SpeedTestProgress {
                            stage: "download".to_string(),
                            latency: Some(avg_latency),
                            loss_rate: Some(rounded_loss_rate),
                            download_speed: Some(spd),
                            upload_speed: None,
                            location: location.clone(),
                            timestamp: None,
                            error: None,
                        });
                    }

                    window.push_back((secs, total_dl_bytes));
                    while window.len() > 6 {
                        window.pop_front();
                    }
                    // After the ramp-up, stop early once the recent rate stays
                    // within 10% of the overall rate for about a second; this
                    // avoids pulling the remaining ~20MB on metered links.
                    if elapsed_secs >= 4.0 && window.len() >= 6 {
                        let (old_t, old_b) = *window.front().expect("window is non-empty");
                        let overall = total_dl_bytes as f64 / elapsed_secs;
                        let recent =
                            (total_dl_bytes - old_b) as f64 / (elapsed_secs - old_t);
                        if overall > 0.0 && (recent / overall - 1.0).abs() <= 0.10 {
                            stable_ticks += 1;
                        } else {
                            stable_ticks = 0;
                        }
                        if stable_ticks >= 5 {
                            break;
                        }
                    }

                    last_progress = Instant::now();
                }

                if elapsed >= max_dl_duration {
                    break;
                }
            }
        }
    }

    let dl_secs = dl_start.elapsed().as_secs_f64();
    let final_dl_speed = if dl_secs > 0.05 && total_dl_bytes > 0 {
        let mb = (total_dl_bytes as f64) / (1024.0 * 1024.0);
        (mb / dl_secs * 10.0).round() / 10.0
    } else {
        0.0
    };

    let _ = on_progress.send(SpeedTestProgress {
        stage: "upload_start".to_string(),
        latency: Some(avg_latency),
        loss_rate: Some(rounded_loss_rate),
        download_speed: Some(final_dl_speed),
        upload_speed: Some(0.0),
        location: location.clone(),
        timestamp: None,
        error: None,
    });

    // Phase 3: Upload test
    let ul_start = Instant::now();
    let mut final_ul_speed = 0.0;
    let payload_size = 5 * 1024 * 1024; // 5MB
    let payload = vec![0u8; payload_size];

    let ul_result = tokio::time::timeout(
        Duration::from_secs(8),
        client
            .post("https://speed.cloudflare.com/__up")
            .body(payload)
            .send(),
    )
    .await;

    match ul_result {
        Ok(Ok(resp)) if resp.status().is_success() => {
            let ul_secs = ul_start.elapsed().as_secs_f64();
            // Fast links finish 5MB in under 50ms; keep a low floor so they
            // still report a speed instead of a silent 0.
            if ul_secs > 0.005 {
                let mb = (payload_size as f64) / (1024.0 * 1024.0);
                final_ul_speed = (mb / ul_secs * 10.0).round() / 10.0;
            }
        }
        _ => {
            // Fallback with 1MB payload
            let small_payload_size = 1024 * 1024;
            let small_payload = vec![0u8; small_payload_size];
            let small_start = Instant::now();
            if let Ok(Ok(resp)) = tokio::time::timeout(
                Duration::from_secs(4),
                client
                    .post("https://speed.cloudflare.com/__up")
                    .body(small_payload)
                    .send(),
            )
            .await
            {
                if resp.status().is_success() {
                    let small_secs = small_start.elapsed().as_secs_f64();
                    if small_secs > 0.005 {
                        let mb = (small_payload_size as f64) / (1024.0 * 1024.0);
                        final_ul_speed = (mb / small_secs * 10.0).round() / 10.0;
                    }
                }
            }
        }
    }

    let timestamp = chrono::Local::now().format("%Y/%m/%d %H:%M").to_string();
    let final_location = location.unwrap_or_else(|| "Unknown".to_string());

    let result = SpeedTestResult {
        latency: avg_latency,
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

