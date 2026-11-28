use super::CmdResult;
use crate::{cmd::StringifyErr as _, config::Config, core::CoreManager, utils::yaml_emitter};
use anyhow::{Context as _, anyhow};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

#[tauri::command]
#[specta::specta]
pub async fn get_runtime_config() -> CmdResult<Option<crate::ipc::YamlMapping>> {
    Ok(Config::runtime()
        .await
        .latest_arc()
        .config
        .clone()
        .map(crate::ipc::YamlMapping))
}

#[tauri::command]
#[specta::specta]
pub async fn get_runtime_yaml() -> CmdResult<std::string::String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime.config.as_ref();
    config
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .and_then(|config| yaml_emitter::to_mihomo_config_string(config).context("failed to convert config to yaml"))
        .stringify_err()
}

#[tauri::command]
#[specta::specta]
pub async fn get_runtime_logs() -> CmdResult<RuntimeLogs> {
    Ok(RuntimeLogs(Config::runtime().await.latest_arc().chain_logs.clone()))
}

#[derive(serde::Serialize, specta::Type)]
#[serde(transparent)]
pub struct RuntimeLogs(
    #[specta(type = HashMap<std::string::String, Vec<(std::string::String, std::string::String)>>)]
    HashMap<String, Vec<(String, String)>>,
);

#[tauri::command]
#[specta::specta]
pub fn take_discarded_keys_notice() -> Option<std::string::String> {
    crate::enhance::take_discarded_keys_notice().map(Into::into)
}

#[tauri::command]
#[specta::specta]
pub async fn get_runtime_proxy_chain_config(
    proxy_chain_exit_node: std::string::String,
) -> CmdResult<std::string::String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime
        .config
        .as_ref()
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .stringify_err()?;

    if let Some(serde_yaml_ng::Value::Sequence(proxies)) = config.get("proxies") {
        let mut proxy_name = Some(proxy_chain_exit_node.as_str());
        let mut proxies_chain = Vec::new();
        let mut visited = HashSet::from([proxy_chain_exit_node.as_str()]);

        while let Some(current_name) = proxy_name
            && let Some(proxy) = proxies.iter().find(|proxy| {
                proxy.as_mapping().is_some_and(|proxy_map| {
                    proxy_map.get("name").and_then(|x| x.as_str()) == Some(current_name)
                        && proxy_map.get("dialer-proxy").is_some()
                })
            })
        {
            proxies_chain.push(proxy);
            let next_name = proxy.get("dialer-proxy").and_then(|x| x.as_str());
            if let Some(next_name) = next_name
                && !visited.insert(next_name)
            {
                return Err("circular dialer-proxy reference detected".into());
            }
            proxy_name = next_name;
        }

        if let Some(current_name) = proxy_name
            && let Some(entry_proxy) = proxies
                .iter()
                .find(|proxy| proxy.get("name").and_then(|x| x.as_str()) == Some(current_name))
            && !proxies_chain.is_empty()
        {
            proxies_chain.push(entry_proxy);
        }

        proxies_chain.reverse();

        let mut config: HashMap<String, Vec<&serde_yaml_ng::Value>> = HashMap::new();

        config.insert("proxies".into(), proxies_chain);

        yaml_emitter::to_mihomo_config_string(&config)
            .context("YAML generation failed")
            .stringify_err()
    } else {
        Err("failed to get proxies or proxy-groups".into())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn update_proxy_chain_config_in_runtime(
    proxy_chain_config: Option<crate::ipc::YamlValue>,
) -> CmdResult<crate::core::validate::ValidationOutcome> {
    let proxy_chain_config = proxy_chain_config.map(|value| value.0);
    CoreManager::global()
        .update_runtime_config(|d| d.update_proxy_chain_config(proxy_chain_config))
        .await
        .stringify_err()
}
