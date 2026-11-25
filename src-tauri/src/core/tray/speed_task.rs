use crate::core::handle;
use crate::process::AsyncHandler;
use crate::utils::{connections_stream, tray_speed};
use crate::{Type, logging};
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri_plugin_mihomo::models::WsConnectionId;

const TRAY_SPEED_RETRY_DELAY: Duration = Duration::from_secs(1);
const TRAY_SPEED_STALE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct TraySpeedController {
    speed_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    speed_connection_id: Arc<Mutex<Option<(u64, WsConnectionId)>>>,
    generation: Arc<AtomicU64>,
}

impl Default for TraySpeedController {
    fn default() -> Self {
        Self {
            speed_task: Arc::new(Mutex::new(None)),
            speed_connection_id: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl TraySpeedController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update_task(&self, enable_tray_speed: bool) {
        if enable_tray_speed {
            self.start_task();
        } else {
            self.stop_task();
        }
    }

    fn start_task(&self) {
        if handle::Handle::global().is_exiting() {
            return;
        }

        if !Self::has_main_tray() {
            logging!(warn, Type::Tray, "托盘不可用，跳过启动托盘速率任务");
            return;
        }

        let mut guard = self.speed_task.lock();
        if guard.as_ref().is_some_and(|task| !task.inner().is_finished()) {
            return;
        }

        let task_gen = self.generation.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        let generation = Arc::clone(&self.generation);
        let speed_connection_id = Arc::clone(&self.speed_connection_id);
        let task = AsyncHandler::spawn(move || Self::run_speed_stream_loop(task_gen, generation, speed_connection_id));

        *guard = Some(task);
    }

    async fn run_speed_stream_loop(
        task_generation: u64,
        generation: Arc<AtomicU64>,
        speed_connection_id: Arc<Mutex<Option<(u64, WsConnectionId)>>>,
    ) {
        loop {
            if handle::Handle::global().is_exiting() || generation.load(Ordering::Acquire) != task_generation {
                break;
            }

            if !Self::has_main_tray() {
                logging!(warn, Type::Tray, "托盘已不可用，停止托盘速率任务");
                break;
            }

            let stream_connect_result = connections_stream::connect_traffic_stream().await;
            let mut speed_stream = match stream_connect_result {
                Ok(stream) => stream,
                Err(err) => {
                    logging!(debug, Type::Tray, "托盘速率流连接失败，稍后重试: {err}");
                    Self::apply_tray_speed(0, 0);
                    tokio::time::sleep(TRAY_SPEED_RETRY_DELAY).await;
                    continue;
                }
            };

            if generation.load(Ordering::Acquire) != task_generation {
                connections_stream::disconnect_connection(speed_stream.connection_id).await;
                break;
            }

            Self::set_speed_connection_id(
                &speed_connection_id,
                Some((task_generation, speed_stream.connection_id)),
            );

            Self::consume_speed_stream(&mut speed_stream, task_generation, &generation).await;

            Self::disconnect_speed_connection(&speed_connection_id, Some(task_generation)).await;

            if handle::Handle::global().is_exiting()
                || !Self::has_main_tray()
                || generation.load(Ordering::Acquire) != task_generation
            {
                break;
            }

            // `Stale` already reset the display; this covers remote close.
            Self::apply_tray_speed(0, 0);
            tokio::time::sleep(TRAY_SPEED_RETRY_DELAY).await;
        }

        Self::clear_connection_for_generation(&speed_connection_id, task_generation);
    }

    async fn consume_speed_stream(
        speed_stream: &mut connections_stream::MihomoWsEventStream<connections_stream::TrafficSpeedEvent>,
        task_generation: u64,
        generation: &Arc<AtomicU64>,
    ) {
        loop {
            let next_state = speed_stream
                .next_event(TRAY_SPEED_STALE_TIMEOUT, || {
                    handle::Handle::global().is_exiting() || generation.load(Ordering::Acquire) != task_generation
                })
                .await;

            match next_state {
                connections_stream::StreamConsumeState::Event(speed_event) => {
                    Self::apply_tray_speed(speed_event.up, speed_event.down);
                }
                connections_stream::StreamConsumeState::Stale => {
                    logging!(debug, Type::Tray, "托盘速率流长时间未收到有效数据，触发重连");
                    Self::apply_tray_speed(0, 0);
                    break;
                }
                connections_stream::StreamConsumeState::Closed
                | connections_stream::StreamConsumeState::ExitRequested => {
                    break;
                }
            }
        }
    }

    fn stop_task(&self) {
        let stop_generation = self.generation.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        let task = self.speed_task.lock().take();
        let speed_connection_id = Arc::clone(&self.speed_connection_id);

        AsyncHandler::spawn(move || async move {
            // Await abort before disconnect so the task cannot consume and lose the connection ID.
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
            Self::disconnect_speed_connection(&speed_connection_id, Some(stop_generation)).await;
        });

        let app_handle = handle::Handle::app_handle();
        if let Some(tray) = app_handle.tray_by_id(super::TRAY_ID) {
            let result = tray.with_inner_tray_icon(|inner| {
                if let Some(status_item) = inner.ns_status_item() {
                    tray_speed::clear_speed_attributed_title(&status_item);
                }
            });
            if let Err(err) = result {
                logging!(warn, Type::Tray, "清除富文本速率失败: {err}");
            }
        }
    }

    fn has_main_tray() -> bool {
        handle::Handle::app_handle().tray_by_id(super::TRAY_ID).is_some()
    }

    fn set_speed_connection_id(
        speed_connection_id: &Arc<Mutex<Option<(u64, WsConnectionId)>>>,
        entry: Option<(u64, WsConnectionId)>,
    ) {
        *speed_connection_id.lock() = entry;
    }

    fn clear_connection_for_generation(
        speed_connection_id: &Arc<Mutex<Option<(u64, WsConnectionId)>>>,
        target_generation: u64,
    ) {
        let mut guard = speed_connection_id.lock();
        if guard.is_some_and(|(gen_id, _)| gen_id <= target_generation) {
            *guard = None;
        }
    }

    fn take_speed_connection_id(
        speed_connection_id: &Arc<Mutex<Option<(u64, WsConnectionId)>>>,
        max_generation: Option<u64>,
    ) -> Option<WsConnectionId> {
        let mut guard = speed_connection_id.lock();
        let should_take = match (*guard, max_generation) {
            (Some((gen_id, _)), Some(limit)) => gen_id <= limit,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if should_take {
            guard.take().map(|(_, connection_id)| connection_id)
        } else {
            None
        }
    }

    async fn disconnect_speed_connection(
        speed_connection_id: &Arc<Mutex<Option<(u64, WsConnectionId)>>>,
        max_generation: Option<u64>,
    ) {
        if let Some(connection_id) = Self::take_speed_connection_id(speed_connection_id, max_generation) {
            connections_stream::disconnect_connection(connection_id).await;
        }
    }

    fn apply_tray_speed(up: u64, down: u64) {
        let app_handle = handle::Handle::app_handle();
        if let Some(tray) = app_handle.tray_by_id(super::TRAY_ID) {
            let result = tray.with_inner_tray_icon(move |inner| {
                if let Some(status_item) = inner.ns_status_item() {
                    tray_speed::set_speed_attributed_title(&status_item, up, down);
                }
            });
            if let Err(err) = result {
                logging!(warn, Type::Tray, "设置富文本速率失败: {err}");
            }
        }
    }
}
