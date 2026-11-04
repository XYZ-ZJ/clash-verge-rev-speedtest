use super::SeqMap;
use crate::{
    config::PrfItem,
    utils::{dirs, help},
};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::Mapping;
use smartstring::alias::String;
use tokio::fs;

#[derive(Debug, Clone)]
pub struct ChainItem {
    pub uid: String,
    pub data: ChainType,
}

#[derive(Debug, Clone)]
pub enum ChainType {
    Merge(Mapping),
    Script(String),
    Rules(SeqMap),
    Proxies(SeqMap),
    Groups(SeqMap),
}

// Helper trait to allow async conversion
pub trait AsyncChainItemFrom {
    async fn from_async(item: &PrfItem) -> Option<ChainItem>;
}

impl AsyncChainItemFrom for Option<ChainItem> {
    async fn from_async(item: &PrfItem) -> Self {
        let itype = item.itype.as_ref()?.as_str();
        let file = item.file.clone()?;
        let uid = item.uid.clone().unwrap_or_else(|| "".into());
        let path = dirs::app_profiles_dir().ok()?.join(file.as_str());

        if !path.exists() {
            return None;
        }

        // 读取/解析失败必须可见：静默返回 None 会让 enhance 用空默认值继续，
        // 用户的 rules/proxies/groups 增量无声丢失（merge 路径在 read_mapping
        // 内已有日志，其余类型在这里补齐）。
        let log_skip = |itype: &str, err: &dyn std::fmt::Display| {
            logging!(
                error,
                Type::Config,
                "enhance chain: failed to load {itype} item \"{uid}\" ({}): {err}",
                path.display()
            );
        };

        match itype {
            "script" => Some(ChainItem {
                uid: uid.clone(),
                data: ChainType::Script(
                    match fs::read_to_string(&path).await {
                        Ok(content) => content.into(),
                        Err(err) => {
                            log_skip(itype, &err);
                            return None;
                        }
                    },
                ),
            }),
            "merge" => Some(ChainItem {
                uid: uid.clone(),
                data: ChainType::Merge(
                    match help::read_mapping(&path).await {
                        Ok(mapping) => mapping,
                        Err(err) => {
                            log_skip(itype, &err);
                            return None;
                        }
                    },
                ),
            }),
            "rules" | "proxies" | "groups" => {
                let seq_map = match help::read_yaml::<SeqMap>(&path).await {
                    Ok(seq_map) => seq_map,
                    Err(err) => {
                        log_skip(itype, &err);
                        return None;
                    }
                };
                let data = match itype {
                    "rules" => ChainType::Rules(seq_map),
                    "proxies" => ChainType::Proxies(seq_map),
                    _ => ChainType::Groups(seq_map),
                };
                Some(ChainItem { uid: uid.clone(), data })
            }
            _ => None,
        }
    }
}
