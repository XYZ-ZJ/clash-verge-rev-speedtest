mod backup;
mod clash;
mod config;
mod core_upgrade;
mod dns;
mod effects;
mod executor;
mod icon;
mod listener;
mod profile;
mod proxy;
mod tun;
mod window;

// Re-export all functions from modules
pub use backup::*;
pub use clash::*;
pub use config::*;
pub use core_upgrade::*;
pub use dns::*;
pub use icon::*;
pub use listener::*;
pub use profile::*;
pub use proxy::*;
pub use tun::*;
pub use window::*;

pub(super) async fn close_connections_if_enabled(context: &str) {
    if crate::config::Config::verge()
        .await
        .latest_arc()
        .auto_close_connection
        .unwrap_or(false)
        && let Err(err) = crate::core::handle::Handle::mihomo().close_all_connections().await
    {
        clash_verge_logging::logging!(
            error,
            clash_verge_logging::Type::Config,
            "{context}: failed to close all connections: {err}"
        );
    }
}
