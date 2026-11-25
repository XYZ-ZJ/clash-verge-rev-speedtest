use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::Config,
    core::{
        handle::Handle,
        proxy_view::{GroupScope, NodeFeature, NodeFeatureScopes, ProxyViewBuilder, ProxyViewInput, ProxyViewV1},
        tray::Tray,
    },
    process::AsyncHandler,
};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Mutex, OnceLock},
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

fn has_non_empty_reuse_settings(mapping: &Mapping) -> bool {
    for key in ["reuse-settings", "xmux"] {
        if let Some(val) = mapping.get(key) {
            let non_empty = match val {
                Value::Mapping(m) => !m.is_empty(),
                Value::Sequence(s) => !s.is_empty(),
                Value::Bool(b) => *b,
                _ => false,
            };
            if non_empty {
                return true;
            }
        }
    }
    false
}

fn detect_node_feature(map: &Mapping) -> Option<NodeFeature> {
    let network = map.get("network").and_then(|v| v.as_str())?;
    if !network.eq_ignore_ascii_case("xhttp") {
        return None;
    }

    let xmux = if let Some(opts) = map.get("xhttp-opts").and_then(|v| v.as_mapping()) {
        has_non_empty_reuse_settings(opts)
            || opts
                .get("download-settings")
                .and_then(|v| v.as_mapping())
                .is_some_and(has_non_empty_reuse_settings)
    } else {
        has_non_empty_reuse_settings(map)
    };

    Some(NodeFeature { xhttp: true, xmux })
}

static FILE_FEATURE_CACHE: OnceLock<
    Mutex<HashMap<std::path::PathBuf, (Option<std::time::SystemTime>, BTreeMap<String, NodeFeature>)>>,
> = OnceLock::new();

fn scan_proxies_slice(proxies: &[Value], features: &mut BTreeMap<String, NodeFeature>) {
    for proxy in proxies.iter().filter_map(|v| v.as_mapping()) {
        if let (Some(name), Some(feat)) = (
            proxy.get("name").and_then(|v| v.as_str()),
            detect_node_feature(proxy),
        ) {
            features.insert(name.to_owned(), feat);
        }
    }
}

fn scan_provider_file(full_path: &std::path::Path, features: &mut BTreeMap<String, NodeFeature>) {
    if !full_path.is_file() {
        return;
    }
    let mtime = full_path.metadata().and_then(|m| m.modified()).ok();
    let cache_mutex = FILE_FEATURE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    let cached_feats = cache_mutex
        .lock()
        .ok()
        .and_then(|cache| cache.get(full_path).cloned())
        .and_then(|(cached_mtime, cached_feats)| {
            if cached_mtime == mtime && mtime.is_some() {
                Some(cached_feats)
            } else {
                None
            }
        });

    if let Some(cached_feats) = cached_feats {
        features.extend(cached_feats);
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

    let mut file_feats = BTreeMap::new();
    if let Some(proxies) = pdoc.get("proxies").and_then(|v| v.as_sequence()) {
        scan_proxies_slice(proxies, &mut file_feats);
    }

    if let Ok(mut cache) = cache_mutex.lock() {
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(full_path.to_path_buf(), (mtime, file_feats.clone()));
    }
    features.extend(file_feats);
}

fn scan_providers(
    providers: &Mapping,
    provider_features: &mut BTreeMap<String, BTreeMap<String, NodeFeature>>,
) {
    let app_dir = crate::utils::dirs::app_home_dir().ok();
    for (key, val) in providers {
        let Some(provider_name) = key.as_str() else {
            continue;
        };
        let Some(provider_map) = val.as_mapping() else {
            continue;
        };

        let entry = provider_features
            .entry(provider_name.to_owned())
            .or_default();

        if let Some(payload) = provider_map.get("payload").and_then(|v| v.as_sequence()) {
            scan_proxies_slice(payload, entry);
        }

        if let Some(raw_path) = provider_map.get("path").and_then(|v| v.as_str()) {
            if raw_path.contains("..") || raw_path.contains('\0') {
                continue;
            }
            let path = std::path::Path::new(raw_path);
            let is_unc_or_non_disk = matches!(
                path.components().next(),
                Some(std::path::Component::Prefix(prefix))
                    if !matches!(
                        prefix.kind(),
                        std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                    )
            );
            if is_unc_or_non_disk {
                continue;
            }
            let Some(ref dir) = app_dir else {
                continue;
            };
            let Ok(canonical_dir) = std::fs::canonicalize(dir) else {
                continue;
            };
            let candidate = if path.is_absolute() {
                path.to_path_buf()
            } else {
                dir.join(path)
            };
            let Ok(canonical_path) = std::fs::canonicalize(&candidate) else {
                continue;
            };
            if !canonical_path.starts_with(&canonical_dir) || !canonical_path.is_file() {
                continue;
            }
            scan_provider_file(&canonical_path, entry);
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

    if file_name.is_empty()
        || file_name.contains("..")
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
    {
        return;
    }

    let profile_path = profiles_dir.join(file_name);
    scan_provider_file(&profile_path, features);
}

fn collect_node_features(config: Option<&Mapping>) -> NodeFeatureScopes {
    let mut scopes = NodeFeatureScopes::default();
    let Some(config) = config else {
        return scopes;
    };

    if let Some(proxies) = config.get("proxies").and_then(|v| v.as_sequence()) {
        scan_proxies_slice(proxies, &mut scopes.core);
    }

    if let Some(providers) = config.get("proxy-providers").and_then(|v| v.as_mapping()) {
        scan_providers(providers, &mut scopes.providers);
    }

    scan_current_profile(&mut scopes.core);

    scopes
}

#[tauri::command]
#[specta::specta]
pub async fn get_proxy_view() -> CmdResult<ProxyViewV1> {
    let runtime = Config::runtime().await;
    let latest_runtime = runtime.latest_arc();
    let runtime_group_order = runtime_group_order(latest_runtime.config.as_ref());
    let group_scopes = runtime_group_scopes(latest_runtime.config.as_ref());
    let runtime_for_scan = std::sync::Arc::clone(&latest_runtime);

    let (node_features, (proxies, providers)) = tokio::join!(
        tokio::task::spawn_blocking(move || collect_node_features(runtime_for_scan.config.as_ref())),
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_yaml_ng::Mapping;

    use super::{detect_node_feature, scan_providers};

    #[test]
    fn detects_xhttp_xmux_and_nested_download_reuse_settings() -> anyhow::Result<()> {
        let plain: Mapping = serde_yaml_ng::from_str(concat!(
            "name: Plain\n",
            "network: xhttp\n",
            "xhttp-opts:\n",
            "  reuse-settings: {}\n",
        ))?;
        let feat = detect_node_feature(&plain);
        assert!(feat.as_ref().is_some_and(|f| f.xhttp && !f.xmux));

        let valid_xmux: Mapping = serde_yaml_ng::from_str(concat!(
            "name: Mux\n",
            "network: xhttp\n",
            "xhttp-opts:\n",
            "  reuse-settings:\n",
            "    max-concurrency: \"16-32\"\n",
        ))?;
        let feat = detect_node_feature(&valid_xmux);
        assert!(feat.as_ref().is_some_and(|f| f.xhttp && f.xmux));

        let nested_dl: Mapping = serde_yaml_ng::from_str(concat!(
            "name: NestedMux\n",
            "network: xhttp\n",
            "xhttp-opts:\n",
            "  download-settings:\n",
            "    reuse-settings:\n",
            "      max-connections: \"4\"\n",
        ))?;
        let feat = detect_node_feature(&nested_dl);
        assert!(feat.as_ref().is_some_and(|f| f.xhttp && f.xmux));

        let ws: Mapping = serde_yaml_ng::from_str("name: Ws\nnetwork: ws\n")?;
        assert!(detect_node_feature(&ws).is_none());
        Ok(())
    }

    #[test]
    fn provider_scan_isolates_duplicate_node_names_by_provider() -> anyhow::Result<()> {
        let providers: Mapping = serde_yaml_ng::from_str(concat!(
            "providerA:\n",
            "  payload:\n",
            "    - name: Relay\n",
            "      network: xhttp\n",
            "      xhttp-opts:\n",
            "        reuse-settings:\n",
            "          max-concurrency: \"8\"\n",
            "providerB:\n",
            "  payload:\n",
            "    - name: Relay\n",
            "      network: xhttp\n",
        ))?;
        let mut scoped = BTreeMap::new();
        scan_providers(&providers, &mut scoped);

        let a_feat = scoped.get("providerA").and_then(|m| m.get("Relay"));
        let b_feat = scoped.get("providerB").and_then(|m| m.get("Relay"));
        assert!(a_feat.is_some_and(|f| f.xhttp && f.xmux));
        assert!(b_feat.is_some_and(|f| f.xhttp && !f.xmux));
        Ok(())
    }
}
