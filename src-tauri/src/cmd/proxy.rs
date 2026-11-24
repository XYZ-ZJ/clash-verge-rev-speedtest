use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::Config,
    core::{
        handle::Handle,
        proxy_view::{GroupScope, NodeFeature, ProxyViewBuilder, ProxyViewInput, ProxyViewV1},
        tray::Tray,
    },
    process::AsyncHandler,
};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::Mapping;
use std::{
    collections::{BTreeMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

/// Merges one selection pair into fresh backend state to avoid stale-list overwrites.
#[tauri::command]
#[specta::specta]
pub async fn record_selected_node(group_name: String, node: String) -> CmdResult<()> {
    crate::config::profiles::record_selected_node(&group_name, &node)
        .await
        .stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn forget_selected_node(group_name: String) -> CmdResult<()> {
    crate::config::profiles::forget_selected_node(&group_name)
        .await
        .stringify_err()
}

static TRAY_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
static TRAY_SYNC_PENDING: AtomicBool = AtomicBool::new(false);

fn runtime_group_order(config: Option<&Mapping>) -> Vec<String> {
    let mut seen = HashSet::new();

    config
        .and_then(|config| config.get("proxy-groups"))
        .and_then(|groups| groups.as_sequence())
        .into_iter()
        .flatten()
        .filter_map(|group| group.get("name"))
        .filter_map(|name| name.as_str())
        .filter(|name| !name.is_empty() && *name != "GLOBAL")
        .filter(|name| seen.insert(*name))
        .map(str::to_owned)
        .collect()
}

/// Mirrors Mihomo: `include-all`/`include-all-providers` replace `use` with every provider, sorted.
fn runtime_group_scopes(config: Option<&Mapping>) -> BTreeMap<String, GroupScope> {
    let Some(config) = config else {
        return BTreeMap::new();
    };
    let mut all_providers = config
        .get("proxy-providers")
        .and_then(|providers| providers.as_mapping())
        .into_iter()
        .flat_map(|providers| providers.keys())
        .filter_map(|name| name.as_str())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    all_providers.sort();
    let flag = |group: &Mapping, key: &str| group.get(key).and_then(|value| value.as_bool()) == Some(true);

    config
        .get("proxy-groups")
        .and_then(|groups| groups.as_sequence())
        .into_iter()
        .flatten()
        .filter_map(|group| group.as_mapping())
        .filter_map(|group| {
            let name = group.get("name")?.as_str()?.to_owned();
            let providers = if flag(group, "include-all") || flag(group, "include-all-providers") {
                all_providers.clone()
            } else {
                group
                    .get("use")
                    .and_then(|providers| providers.as_sequence())
                    .into_iter()
                    .flatten()
                    .filter_map(|provider| provider.as_str())
                    .map(str::to_owned)
                    .collect()
            };
            let exclude_types = group
                .get("exclude-type")
                .and_then(|types| types.as_str())
                .filter(|types| !types.is_empty())
                .map(|types| types.split('|').map(str::to_owned).collect())
                .unwrap_or_default();
            Some((
                name,
                GroupScope {
                    providers,
                    exclude_types,
                },
            ))
        })
        .collect()
}

fn detect_node_feature(map: &Mapping) -> Option<NodeFeature> {
    let network = map.get("network").and_then(|v| v.as_str())?;
    if !network.eq_ignore_ascii_case("xhttp") {
        return None;
    }

    let xmux = if let Some(opts) = map.get("xhttp-opts").and_then(|v| v.as_mapping()) {
        opts.contains_key("reuse-settings") || opts.contains_key("xmux")
    } else {
        map.contains_key("reuse-settings") || map.contains_key("xmux")
    };

    Some(NodeFeature { xhttp: true, xmux })
}

fn scan_proxies_slice(proxies: &[Value], features: &mut BTreeMap<String, NodeFeature>) {
    for proxy in proxies.iter().filter_map(|v| v.as_mapping()) {
        if let Some(name) = proxy.get("name").and_then(|v| v.as_str()) {
            if let Some(feat) = detect_node_feature(proxy) {
                features.insert(name.to_owned(), feat);
            }
        }
    }
}

fn scan_provider_file(full_path: &std::path::Path, features: &mut BTreeMap<String, NodeFeature>) {
    if !full_path.is_file() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(full_path) else {
        return;
    };
    let Ok(serde_yaml_ng::Value::Mapping(pdoc)) =
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content)
    else {
        return;
    };
    if let Some(proxies) = pdoc.get("proxies").and_then(|v| v.as_sequence()) {
        scan_proxies_slice(proxies, features);
    }
}

fn scan_providers(providers: &Mapping, features: &mut BTreeMap<String, NodeFeature>) {
    let app_dir = crate::utils::dirs::app_home_dir().ok();
    for (_key, val) in providers {
        let Some(provider_map) = val.as_mapping() else {
            continue;
        };

        if let Some(payload) = provider_map.get("payload").and_then(|v| v.as_sequence()) {
            scan_proxies_slice(payload, features);
        }

        if let Some(raw_path) = provider_map.get("path").and_then(|v| v.as_str()) {
            let path = std::path::Path::new(raw_path);
            let full_path = if path.is_absolute() {
                path.to_path_buf()
            } else if let Some(ref dir) = app_dir {
                dir.join(path)
            } else {
                path.to_path_buf()
            };
            scan_provider_file(&full_path, features);
        }
    }
}

fn scan_current_profile(features: &mut BTreeMap<String, NodeFeature>) {
    let Ok(profiles_dir) = crate::utils::dirs::app_profiles_dir() else {
        return;
    };
    let profiles_yaml = profiles_dir.join(crate::utils::dirs::PROFILE_YAML);
    if !profiles_yaml.is_file() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&profiles_yaml) else {
        return;
    };
    let Ok(serde_yaml_ng::Value::Mapping(profiles_cfg)) =
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&content)
    else {
        return;
    };
    let Some(cur_uid) = profiles_cfg.get("current").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(items) = profiles_cfg.get("items").and_then(|v| v.as_sequence()) else {
        return;
    };
    let Some(file_name) = items.iter().filter_map(|i| i.as_mapping()).find_map(|item| {
        if item.get("uid").and_then(|u| u.as_str()) == Some(cur_uid) {
            item.get("file").and_then(|f| f.as_str())
        } else {
            None
        }
    }) else {
        return;
    };

    let profile_path = profiles_dir.join(file_name);
    scan_provider_file(&profile_path, features);
}

fn collect_node_features(config: Option<&Mapping>) -> BTreeMap<String, NodeFeature> {
    let mut features = BTreeMap::new();
    let Some(config) = config else {
        return features;
    };

    if let Some(proxies) = config.get("proxies").and_then(|v| v.as_sequence()) {
        scan_proxies_slice(proxies, &mut features);
    }

    if let Some(providers) = config.get("proxy-providers").and_then(|v| v.as_mapping()) {
        scan_providers(providers, &mut features);
    }

    scan_current_profile(&mut features);

    features
}

#[tauri::command]
#[specta::specta]
pub async fn get_proxy_view() -> CmdResult<ProxyViewV1> {
    let runtime = Config::runtime().await;
    let latest_runtime = runtime.latest_arc();
    let runtime_group_order = runtime_group_order(latest_runtime.config.as_ref());
    let group_scopes = runtime_group_scopes(latest_runtime.config.as_ref());
    let config_clone = latest_runtime.config.clone();

    let (node_features, (proxies, providers)) = tokio::join!(
        tokio::task::spawn_blocking(move || collect_node_features(config_clone.as_ref())),
        async {
            let mihomo = Handle::mihomo();
            tokio::join!(mihomo.get_proxies(), mihomo.get_proxy_providers())
        }
    );
    let node_features = node_features.unwrap_or_default();
    let proxies = proxies.stringify_err()?;

    Ok(ProxyViewBuilder::build(ProxyViewInput {
        runtime_group_order,
        group_scopes,
        proxies,
        providers: providers.ok(),
        node_features,
    }))
}

#[tauri::command]
#[specta::specta]
pub async fn sync_tray_proxy_selection() -> CmdResult<()> {
    if TRAY_SYNC_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        AsyncHandler::spawn(move || async move {
            run_tray_sync_loop().await;
        });
    } else {
        TRAY_SYNC_PENDING.store(true, Ordering::Release);
    }

    Ok(())
}

async fn run_tray_sync_loop() {
    // Permanent watcher: keeps syncing until a pass finds no pending sync request.
    loop {
        match Tray::global().update_menu().await {
            Ok(_) => {
                logging!(debug, Type::Cmd, "Tray proxy selection synced successfully");
            }
            Err(e) => {
                logging!(error, Type::Cmd, "Failed to sync tray proxy selection: {e:#}");
            }
        }

        if !TRAY_SYNC_PENDING.swap(false, Ordering::AcqRel) {
            TRAY_SYNC_RUNNING.store(false, Ordering::Release);

            if TRAY_SYNC_PENDING.swap(false, Ordering::AcqRel)
                && TRAY_SYNC_RUNNING
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                continue;
            }

            break;
        }
    }
}
