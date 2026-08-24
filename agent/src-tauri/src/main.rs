#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Timelike, Utc};
use reqwest::blocking::Client;
use reqwest::Proxy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use uuid::Uuid;

const AGENT_VERSION: &str = "0.1.15";
const KEYRING_SERVICE: &str = "ai-jinyiwei-agent";
const LOCAL_QUEUE_KEY_ACCOUNT: &str = "__local-queue-key";
const MAX_PENDING_EVENTS: i64 = 10_000;
// A resumed/sleeping Windows session must not create a full-day idle span
// that extends History into the future. The service keeps the last 12 hours
// at most; all policy clock comparisons use China Standard Time (UTC+8).
const MAX_EVENT_DURATION_SECONDS: i64 = 12 * 3600;
const DEFAULT_ACTIVITY_CHECKPOINT_SECONDS: u64 = 15;

fn default_activity_checkpoint_seconds() -> u64 {
    DEFAULT_ACTIVITY_CHECKPOINT_SECONDS
}

fn default_collect_policy_flag() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Policy {
    idle_threshold_seconds: u64,
    #[serde(default = "default_activity_checkpoint_seconds")]
    activity_checkpoint_seconds: u64,
    heartbeat_interval_seconds: u64,
    #[serde(default = "default_collect_policy_flag")]
    collect_app_activity: bool,
    #[serde(default = "default_collect_policy_flag")]
    collect_idle_status: bool,
    #[serde(default = "default_collect_policy_flag")]
    collect_web_domains: bool,
    #[serde(default = "default_collect_policy_flag")]
    collect_file_metadata: bool,
    work_hours_start: String,
    work_hours_end: String,
    #[serde(default)]
    excluded_processes: Vec<String>,
    #[serde(default)]
    excluded_domains: Vec<String>,
    version: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            idle_threshold_seconds: 300,
            activity_checkpoint_seconds: DEFAULT_ACTIVITY_CHECKPOINT_SECONDS,
            heartbeat_interval_seconds: 60,
            collect_app_activity: true,
            collect_idle_status: true,
            collect_web_domains: true,
            collect_file_metadata: true,
            work_hours_start: "09:00".into(),
            work_hours_end: "18:00".into(),
            excluded_processes: Vec::new(),
            excluded_domains: Vec::new(),
            version: 1,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentStatus {
    state: String,
    server_url: Option<String>,
    device_id: Option<String>,
    employee_name: Option<String>,
    employee_team: Option<String>,
    last_sync_at: Option<String>,
    queued_events: usize,
    last_error: Option<String>,
    last_browser_capture_at: Option<String>,
    last_browser_capture_source: Option<String>,
    agent_version: String,
    policy: Policy,
    privacy_policy: Option<PrivacyPolicy>,
    privacy_acknowledged: bool,
}

impl Default for AgentStatus {
    fn default() -> Self {
        Self {
            state: "unregistered".into(),
            server_url: None,
            device_id: None,
            employee_name: None,
            employee_team: None,
            last_sync_at: None,
            queued_events: 0,
            last_error: None,
            last_browser_capture_at: None,
            last_browser_capture_source: None,
            agent_version: AGENT_VERSION.into(),
            policy: Policy::default(),
            privacy_policy: None,
            privacy_acknowledged: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PrivacyPolicy {
    version: String,
    title: String,
    notice: String,
    policy_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentEvent {
    event_id: String,
    occurred_at: String,
    event_type: String,
    app_name: String,
    process_name: String,
    source_kind: String,
    context_label: Option<String>,
    web_domain: Option<String>,
    duration_seconds: i64,
}

#[derive(Clone, Debug)]
struct ActiveSession {
    event_id: String,
    app_name: String,
    process_name: String,
    source_kind: String,
    context_label: Option<String>,
    web_domain: Option<String>,
    started_at: Instant,
    occurred_at: String,
    last_emitted_duration: i64,
}

#[derive(Clone, Debug)]
struct IdleSession {
    event_id: String,
    started_at: Instant,
    occurred_at: String,
    last_emitted_duration: i64,
}

#[derive(Clone, Debug)]
struct ForegroundActivity {
    app_name: String,
    process_name: String,
    source_kind: String,
    context_label: Option<String>,
    web_domain: Option<String>,
}

fn apply_collection_policy_to_activity(activity: &mut ForegroundActivity, policy: &Policy) {
    if !policy.collect_web_domains {
        activity.web_domain = None;
        if activity.source_kind == "browser_native" || activity.source_kind == "browser_extension" {
            activity.source_kind = "desktop_app".into();
        }
    }
    if !policy.collect_file_metadata {
        activity.context_label = activity.context_label.take().and_then(|value| {
            let labels = value
                .split(" · ")
                .filter(|label| !label.starts_with("文档：") && !label.starts_with("资源："))
                .collect::<Vec<_>>();
            (!labels.is_empty()).then(|| labels.join(" · "))
        });
    }
}

#[derive(Debug, Deserialize)]
struct BootstrapConfig {
    server_url: Option<String>,
    registration_code: Option<String>,
}

struct Core {
    db: Connection,
    http: Client,
    status: AgentStatus,
    token: Option<String>,
    local_queue_key: [u8; 32],
    active_session: Option<ActiveSession>,
    idle_session: Option<IdleSession>,
    last_heartbeat: Instant,
    last_event_flush: Instant,
    pending_registration_code: Option<String>,
    last_auto_enroll_attempt: Instant,
}

struct AgentState {
    core: Arc<Mutex<Core>>,
}

#[derive(Serialize)]
struct EnrollRequest {
    registration_code: String,
    hostname: String,
    os_version: String,
    agent_version: String,
}

#[derive(Deserialize)]
struct EnrollResponse {
    device_id: String,
    device_token: String,
    employee: Employee,
    policy: Policy,
    privacy_policy: PrivacyPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Employee {
    id: String,
    name: String,
    team: String,
}

#[derive(Serialize)]
struct EventsRequest {
    events: Vec<AgentEventPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    privacy_policy_version: Option<String>,
}

#[derive(Clone, Serialize)]
struct AgentEventPayload {
    event_id: String,
    occurred_at: String,
    #[serde(rename = "type")]
    event_type: String,
    app_name: String,
    process_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_domain: Option<String>,
    duration_seconds: i64,
}

#[derive(Serialize)]
struct HeartbeatRequest {
    agent_version: String,
    queued_events: usize,
}

#[derive(Deserialize)]
struct HeartbeatResponse {
    policy: Policy,
    privacy_policy: PrivacyPolicy,
    #[serde(default)]
    privacy_acknowledged: bool,
}

#[derive(Serialize)]
struct PrivacyAcknowledgementRequest {
    policy_version: String,
    policy_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BrowserPairingResponse {
    code: String,
    expires_at: String,
    device_id: String,
}

impl Core {
    fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let db = Connection::open(db_path).map_err(|error| error.to_string())?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS events (
               event_id TEXT PRIMARY KEY,
               occurred_at TEXT NOT NULL,
               event_type TEXT NOT NULL,
               app_name TEXT NOT NULL,
               process_name TEXT NOT NULL,
               source_kind TEXT NOT NULL DEFAULT 'desktop_app',
               context_label TEXT,
               web_domain TEXT,
               duration_seconds INTEGER NOT NULL,
               uploaded INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|error| error.to_string())?;
        ensure_event_metadata_columns(&db)?;
        let local_queue_key = load_or_create_local_queue_key()?;

        let server_url = read_config(&db, "server_url");
        let device_id = read_config(&db, "device_id");
        let employee_name = read_config(&db, "employee_name");
        let employee_team = read_config(&db, "employee_team");
        let token = device_id.as_ref().and_then(|id| load_secret(id));
        let mut status = AgentStatus::default();
        status.server_url = server_url;
        status.device_id = device_id;
        status.employee_name = employee_name;
        status.employee_team = employee_team;
        status.queued_events = pending_count(&db);
        if status.device_id.is_some() && token.is_some() {
            status.state = "offline".into();
        }

        let mut http_builder = Client::builder().timeout(Duration::from_secs(8));
        if let Ok(proxy_url) = env::var("AGENT_PROXY_URL") {
            if !proxy_url.trim().is_empty() {
                http_builder = http_builder
                    .proxy(Proxy::all(proxy_url.trim()).map_err(|error| error.to_string())?);
            }
        }
        let mut core = Self {
            db,
            http: http_builder.build().map_err(|error| error.to_string())?,
            status,
            token,
            local_queue_key,
            active_session: None,
            idle_session: None,
            last_heartbeat: Instant::now() - Duration::from_secs(60),
            last_event_flush: Instant::now()
                - Duration::from_secs(DEFAULT_ACTIVITY_CHECKPOINT_SECONDS),
            pending_registration_code: None,
            last_auto_enroll_attempt: Instant::now() - Duration::from_secs(60),
        };
        core.migrate_legacy_events()?;
        Ok(core)
    }

    fn migrate_legacy_events(&mut self) -> Result<(), String> {
        let mut statement = self
            .db
            .prepare("SELECT event_id, app_name, process_name, source_kind, context_label, web_domain FROM events")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);

        let legacy = rows
            .into_iter()
            .filter(
                |(_, app_name, process_name, source_kind, context_label, web_domain)| {
                    !is_encrypted_local_value(app_name)
                        || !is_encrypted_local_value(process_name)
                        || !is_encrypted_local_value(source_kind)
                        || context_label
                            .as_deref()
                            .map(|value| !is_encrypted_local_value(value))
                            .unwrap_or(false)
                        || web_domain
                            .as_deref()
                            .map(|value| !is_encrypted_local_value(value))
                            .unwrap_or(false)
                },
            )
            .collect::<Vec<_>>();
        if legacy.is_empty() {
            return Ok(());
        }

        let key = self.local_queue_key;
        let transaction = self.db.transaction().map_err(|error| error.to_string())?;
        let mut update = transaction
            .prepare("UPDATE events SET app_name = ?1, process_name = ?2, source_kind = ?3, context_label = ?4, web_domain = ?5 WHERE event_id = ?6")
            .map_err(|error| error.to_string())?;
        for (event_id, app_name, process_name, source_kind, context_label, web_domain) in legacy {
            let encrypted_context = context_label
                .as_deref()
                .map(|value| encrypt_local_value(&key, value))
                .transpose()?;
            let encrypted_domain = web_domain
                .as_deref()
                .map(|value| encrypt_local_value(&key, value))
                .transpose()?;
            update
                .execute(params![
                    encrypt_local_value(&key, &app_name)?,
                    encrypt_local_value(&key, &process_name)?,
                    encrypt_local_value(&key, &source_kind)?,
                    encrypted_context,
                    encrypted_domain,
                    event_id,
                ])
                .map_err(|error| error.to_string())?;
        }
        drop(update);
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    fn load_bootstrap(&mut self, resource_dir: PathBuf) {
        if self.status.device_id.is_some() || self.token.is_some() {
            return;
        }
        let config_path = resource_dir.join("agent-config.json");
        let Ok(contents) = fs::read_to_string(config_path) else {
            return;
        };
        let Ok(config) = serde_json::from_str::<BootstrapConfig>(&contents) else {
            self.status.last_error = Some("安装包注册配置无法读取".into());
            self.status.state = "error".into();
            return;
        };
        if let Some(server_url) = config.server_url.filter(|value| !value.trim().is_empty()) {
            let normalized = server_url.trim().trim_end_matches('/').to_string();
            self.status.server_url = Some(normalized.clone());
            let _ = self.save_config("server_url", &normalized);
        }
        self.pending_registration_code = config
            .registration_code
            .filter(|value| !value.trim().is_empty());
    }

    fn save_config(&self, key: &str, value: &str) -> Result<(), String> {
        self.db.execute("INSERT INTO config (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn clear_local_data(&mut self) -> Result<(), String> {
        if let Err(error) = self
            .db
            .execute_batch("DELETE FROM events; DELETE FROM config;")
        {
            self.status.state = "error".into();
            self.status.last_error = Some(format!("本地数据清理失败：{error}"));
            return Err(error.to_string());
        }
        self.active_session = None;
        self.idle_session = None;
        self.pending_registration_code = None;
        remove_secret(LOCAL_QUEUE_KEY_ACCOUNT);
        self.local_queue_key = load_or_create_local_queue_key()?;
        self.status.queued_events = 0;
        Ok(())
    }

    fn report_storage_error(&mut self, action: &str, error: rusqlite::Error) -> String {
        let message = format!("本地缓存{action}失败：{error}");
        self.status.state = "error".into();
        self.status.last_error = Some(message.clone());
        message
    }

    fn report_local_error(&mut self, message: String) -> String {
        self.status.state = "error".into();
        self.status.last_error = Some(message.clone());
        message
    }

    fn invalidate_token(&mut self) -> String {
        self.token = None;
        self.status.privacy_acknowledged = false;
        self.status.state = "error".into();
        let message = "设备 Token 已失效，请重新注册".to_string();
        self.status.last_error = Some(message.clone());
        message
    }

    fn queue_event(&mut self, event: AgentEvent) -> Result<(), String> {
        let key = self.local_queue_key;
        let app_name = match encrypt_local_value(&key, &event.app_name) {
            Ok(value) => value,
            Err(error) => return Err(self.report_local_error(format!("本地缓存加密失败：{error}"))),
        };
        let process_name = match encrypt_local_value(&key, &event.process_name) {
            Ok(value) => value,
            Err(error) => return Err(self.report_local_error(format!("本地缓存加密失败：{error}"))),
        };
        let source_kind = match encrypt_local_value(&key, &event.source_kind) {
            Ok(value) => value,
            Err(error) => return Err(self.report_local_error(format!("本地缓存加密失败：{error}"))),
        };
        let context_label = match event.context_label.as_deref() {
            Some(value) => match encrypt_local_value(&key, value) {
                Ok(value) => Some(value),
                Err(error) => {
                    return Err(self.report_local_error(format!("本地缓存加密失败：{error}")))
                }
            },
            None => None,
        };
        let web_domain = match event.web_domain.as_deref() {
            Some(value) => match encrypt_local_value(&key, value) {
                Ok(value) => Some(value),
                Err(error) => {
                    return Err(self.report_local_error(format!("本地缓存加密失败：{error}")))
                }
            },
            None => None,
        };
        if let Err(error) = self.db.execute(
            "INSERT INTO events (event_id, occurred_at, event_type, app_name, process_name, source_kind, context_label, web_domain, duration_seconds) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(event_id) DO UPDATE SET source_kind = excluded.source_kind, context_label = excluded.context_label, web_domain = excluded.web_domain, duration_seconds = MAX(events.duration_seconds, excluded.duration_seconds)",
            params![event.event_id, event.occurred_at, event.event_type, app_name, process_name, source_kind, context_label, web_domain, event.duration_seconds],
        ) {
            return Err(self.report_storage_error("写入", error));
        }
        let removed = match self.db.execute(
            "DELETE FROM events WHERE uploaded = 0 AND event_id IN (SELECT event_id FROM events WHERE uploaded = 0 ORDER BY occurred_at ASC LIMIT -1 OFFSET ?1)",
            params![MAX_PENDING_EVENTS],
        ) {
            Ok(removed) => removed,
            Err(error) => return Err(self.report_storage_error("整理", error)),
        };
        if removed > 0 {
            self.status.last_error = Some("本地缓存已达到上限，最早活动记录已被丢弃".into());
        }
        self.status.queued_events = pending_count(&self.db);
        Ok(())
    }

    fn pending_events(&mut self, limit: usize) -> Result<Vec<AgentEventPayload>, String> {
        let mut statement = self
            .db
            .prepare("SELECT event_id, occurred_at, event_type, app_name, process_name, source_kind, context_label, web_domain, duration_seconds FROM events WHERE uploaded = 0 ORDER BY occurred_at ASC LIMIT ?1")
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(params![limit as i64])
            .map_err(|error| error.to_string())?;
        let key = self.local_queue_key;
        let mut events = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let app_name: String = row.get(3).map_err(|error| error.to_string())?;
            let process_name: String = row.get(4).map_err(|error| error.to_string())?;
            let source_kind: String = row.get(5).map_err(|error| error.to_string())?;
            let context_label: Option<String> = row.get(6).map_err(|error| error.to_string())?;
            let web_domain: Option<String> = row.get(7).map_err(|error| error.to_string())?;
            events.push(AgentEventPayload {
                event_id: row.get(0).map_err(|error| error.to_string())?,
                occurred_at: row.get(1).map_err(|error| error.to_string())?,
                event_type: row.get(2).map_err(|error| error.to_string())?,
                app_name: decrypt_local_value(&key, &app_name)?,
                process_name: decrypt_local_value(&key, &process_name)?,
                source_kind: Some(decrypt_local_value(&key, &source_kind)?),
                context_label: context_label
                    .as_deref()
                    .map(|value| decrypt_local_value(&key, value))
                    .transpose()?,
                web_domain: web_domain
                    .as_deref()
                    .map(|value| decrypt_local_value(&key, value))
                    .transpose()?,
                duration_seconds: row
                    .get::<_, i64>(8)
                    .map_err(|error| error.to_string())?
                    .clamp(0, MAX_EVENT_DURATION_SECONDS),
            });
        }
        Ok(events)
    }

    fn mark_uploaded(&mut self, ids: &[String]) -> Result<(), String> {
        for id in ids {
            self.db
                .execute("DELETE FROM events WHERE event_id = ?1", params![id])
                .map_err(|error| error.to_string())?;
        }
        self.status.queued_events = pending_count(&self.db);
        Ok(())
    }

    fn api_url(&self, path: &str) -> Result<String, String> {
        self.status
            .server_url
            .clone()
            .map(|url| format!("{}{}", url.trim_end_matches('/'), path))
            .ok_or_else(|| "server URL is not configured".into())
    }

    fn flush_events(&mut self) -> Result<(), String> {
        if self.token.is_none()
            || self.status.device_id.is_none()
            || self.status.server_url.is_none()
            || self.status.queued_events == 0
        {
            return Ok(());
        }
        let events = self
            .pending_events(100)
            .map_err(|error| self.report_local_error(error))?;
        if events.is_empty() {
            return Ok(());
        }
        let token = self.token.clone().unwrap_or_default();
        let response = self
            .http
            .post(self.api_url("/api/agent/events")?)
            .bearer_auth(token)
            .json(&EventsRequest {
                events: events.clone(),
                privacy_policy_version: self
                    .status
                    .privacy_policy
                    .as_ref()
                    .map(|policy| policy.version.clone()),
            })
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                return Err(self.invalidate_token());
            }
            return Err(format!("事件上传失败：HTTP {status}：{body}"));
        }
        self.mark_uploaded(
            &events
                .iter()
                .map(|event| event.event_id.clone())
                .collect::<Vec<_>>(),
        )?;
        Ok(())
    }

    fn send_heartbeat(&mut self) -> Result<(), String> {
        if self.token.is_none()
            || self.status.device_id.is_none()
            || self.status.server_url.is_none()
        {
            return Ok(());
        }
        let token = self.token.clone().unwrap_or_default();
        let response = self
            .http
            .post(self.api_url("/api/agent/heartbeat")?)
            .bearer_auth(token)
            .json(&HeartbeatRequest {
                agent_version: AGENT_VERSION.into(),
                queued_events: self.status.queued_events,
            })
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                return Err(self.invalidate_token());
            }
            return Err(format!("心跳同步失败：HTTP {status}：{body}"));
        }
        let body: HeartbeatResponse = response.json().map_err(|error| error.to_string())?;
        self.status.policy = body.policy;
        self.status.privacy_policy = Some(body.privacy_policy);
        self.status.privacy_acknowledged = body.privacy_acknowledged;
        self.status.last_sync_at = Some(Utc::now().to_rfc3339());
        self.status.last_error = None;
        self.status.state = if self.status.privacy_acknowledged {
            "online".into()
        } else {
            "awaiting_consent".into()
        };
        self.last_heartbeat = Instant::now();
        Ok(())
    }

    fn acknowledge_privacy(&mut self) -> Result<(), String> {
        let token = self
            .token
            .clone()
            .ok_or_else(|| "设备尚未注册".to_string())?;
        let policy = self
            .status
            .privacy_policy
            .clone()
            .ok_or_else(|| "尚未取得当前隐私策略，请等待心跳同步".to_string())?;
        let response = self
            .http
            .post(self.api_url("/api/agent/privacy-acknowledgement")?)
            .bearer_auth(token)
            .json(&PrivacyAcknowledgementRequest {
                policy_version: policy.version.clone(),
                policy_hash: policy.policy_hash,
            })
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(format!("隐私策略确认失败：HTTP {}：{}", status, body));
        }
        self.save_config("privacy_acknowledged_version", &policy.version)?;
        self.status.privacy_acknowledged = true;
        self.status.state = "online".into();
        self.status.last_error = None;
        Ok(())
    }

    fn create_browser_pairing_code(&self) -> Result<BrowserPairingResponse, String> {
        let token = self
            .token
            .clone()
            .ok_or_else(|| "设备尚未注册".to_string())?;
        let response = self
            .http
            .post(self.api_url("/api/agent/browser-pairing-codes")?)
            .bearer_auth(token)
            .json(&serde_json::json!({}))
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("生成浏览器配对码失败：HTTP {}", response.status()));
        }
        response.json().map_err(|error| error.to_string())
    }

    fn finish_session(&mut self, ended_at: Instant) -> Result<(), String> {
        let Some(session) = self.active_session.take() else {
            return Ok(());
        };
        let duration = ended_at.duration_since(session.started_at).as_secs() as i64;
        self.queue_event(AgentEvent {
            event_id: session.event_id,
            occurred_at: session.occurred_at,
            event_type: "app_session".into(),
            app_name: session.app_name,
            process_name: session.process_name,
            source_kind: session.source_kind,
            context_label: session.context_label,
            web_domain: session.web_domain,
            duration_seconds: duration,
        })
    }

    fn finish_idle_session(&mut self, ended_at: Instant) -> Result<(), String> {
        let Some(session) = self.idle_session.take() else {
            return Ok(());
        };
        let duration = ended_at
            .duration_since(session.started_at)
            .as_secs()
            .min(MAX_EVENT_DURATION_SECONDS as u64) as i64;
        self.queue_event(AgentEvent {
            event_id: session.event_id,
            occurred_at: session.occurred_at,
            event_type: "idle".into(),
            app_name: "Idle".into(),
            process_name: "system".into(),
            source_kind: "system_idle".into(),
            context_label: None,
            web_domain: None,
            duration_seconds: duration,
        })
    }

    fn checkpoint_idle_session(&mut self, now: Instant) -> Result<(), String> {
        let Some((event_id, occurred_at, started_at, last_emitted_duration)) =
            self.idle_session.as_ref().map(|session| {
                (
                    session.event_id.clone(),
                    session.occurred_at.clone(),
                    session.started_at,
                    session.last_emitted_duration,
                )
            })
        else {
            return Ok(());
        };
        let duration = now
            .duration_since(started_at)
            .as_secs()
            .min(MAX_EVENT_DURATION_SECONDS as u64) as i64;
        let checkpoint_seconds = self.activity_checkpoint_seconds();
        if duration < checkpoint_seconds as i64 || duration <= last_emitted_duration {
            return Ok(());
        }
        self.queue_event(AgentEvent {
            event_id,
            occurred_at,
            event_type: "idle".into(),
            app_name: "Idle".into(),
            process_name: "system".into(),
            source_kind: "system_idle".into(),
            context_label: None,
            web_domain: None,
            duration_seconds: duration,
        })?;
        if let Some(session) = self.idle_session.as_mut() {
            session.last_emitted_duration = duration;
        }
        Ok(())
    }

    fn checkpoint_session(&mut self, now: Instant) -> Result<(), String> {
        let Some((
            event_id,
            app_name,
            process_name,
            source_kind,
            context_label,
            web_domain,
            occurred_at,
            started_at,
            last_emitted_duration,
        )) = self.active_session.as_ref().map(|session| {
            (
                session.event_id.clone(),
                session.app_name.clone(),
                session.process_name.clone(),
                session.source_kind.clone(),
                session.context_label.clone(),
                session.web_domain.clone(),
                session.occurred_at.clone(),
                session.started_at,
                session.last_emitted_duration,
            )
        })
        else {
            return Ok(());
        };
        let duration = now.duration_since(started_at).as_secs() as i64;
        let checkpoint_seconds = self.activity_checkpoint_seconds();
        if duration < checkpoint_seconds as i64 || duration <= last_emitted_duration {
            return Ok(());
        }
        self.queue_event(AgentEvent {
            event_id,
            occurred_at,
            event_type: "app_session".into(),
            app_name,
            process_name,
            source_kind,
            context_label,
            web_domain,
            duration_seconds: duration,
        })?;
        if let Some(session) = self.active_session.as_mut() {
            session.last_emitted_duration = duration;
        }
        Ok(())
    }

    fn activity_checkpoint_seconds(&self) -> u64 {
        self.status
            .policy
            .activity_checkpoint_seconds
            .clamp(10, 300)
    }

    fn enroll_from_code(
        &mut self,
        server_url: &str,
        registration_code: &str,
    ) -> Result<(), String> {
        let normalized_url = server_url.trim().trim_end_matches('/').to_string();
        if normalized_url.is_empty() {
            return Err("服务地址不能为空".into());
        }
        let hostname = hostname::get()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .into_owned();
        let response = self
            .http
            .post(format!("{normalized_url}/api/agent/enroll"))
            .json(&EnrollRequest {
                registration_code: registration_code.trim().to_uppercase(),
                hostname,
                os_version: "Windows 10/11".into(),
                agent_version: AGENT_VERSION.into(),
            })
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("注册失败：HTTP {}", response.status()));
        }
        let enrolled: EnrollResponse = response.json().map_err(|error| error.to_string())?;
        store_secret(&enrolled.device_id, &enrolled.device_token)?;
        self.save_config("server_url", &normalized_url)?;
        self.save_config("device_id", &enrolled.device_id)?;
        self.save_config("employee_name", &enrolled.employee.name)?;
        self.save_config("employee_team", &enrolled.employee.team)?;
        self.token = Some(enrolled.device_token);
        self.status.server_url = Some(normalized_url);
        self.status.device_id = Some(enrolled.device_id);
        self.status.employee_name = Some(enrolled.employee.name);
        self.status.employee_team = Some(enrolled.employee.team);
        self.status.policy = enrolled.policy;
        self.status.privacy_policy = Some(enrolled.privacy_policy);
        self.status.privacy_acknowledged = false;
        self.status.state = "awaiting_consent".into();
        self.status.last_error = None;
        self.status.last_sync_at = Some(Utc::now().to_rfc3339());
        self.pending_registration_code = None;
        Ok(())
    }

    fn try_auto_enroll(&mut self) {
        let Some(code) = self.pending_registration_code.clone() else {
            return;
        };
        let Some(server_url) = self.status.server_url.clone() else {
            self.status.state = "error".into();
            self.status.last_error = Some("安装包缺少服务地址".into());
            return;
        };
        if self.last_auto_enroll_attempt.elapsed() < Duration::from_secs(30) {
            return;
        }
        self.last_auto_enroll_attempt = Instant::now();
        if let Err(error) = self.enroll_from_code(&server_url, &code) {
            self.status.state = "error".into();
            self.status.last_error = Some(error);
        }
    }

    fn tick(&mut self) {
        if self.status.device_id.is_none() || self.token.is_none() {
            self.try_auto_enroll();
            self.status.queued_events = pending_count(&self.db);
            return;
        }

        let now = Instant::now();
        if !self.status.privacy_acknowledged {
            if now.duration_since(self.last_heartbeat).as_secs()
                >= self.status.policy.heartbeat_interval_seconds
            {
                if let Err(error) = self.send_heartbeat() {
                    self.status.state = "offline".into();
                    self.status.last_error = Some(error);
                }
            }
            self.status.queued_events = pending_count(&self.db);
            return;
        }
        let checkpoint_seconds = self.activity_checkpoint_seconds();
        if !within_work_hours(&self.status.policy) {
            let _ = self.finish_session(now);
            let _ = self.finish_idle_session(now);
        } else {
            let idle_seconds = system_idle_seconds();
            let idle_limit = self.status.policy.idle_threshold_seconds;
            if self.status.policy.collect_idle_status && idle_seconds >= idle_limit {
                if self.idle_session.is_none() {
                    let bounded_idle_seconds = idle_seconds.min(MAX_EVENT_DURATION_SECONDS as u64);
                    let idle_started = now - Duration::from_secs(bounded_idle_seconds);
                    let _ = self.finish_session(idle_started);
                    let idle_occurred_at = (Utc::now()
                        - chrono::Duration::seconds(bounded_idle_seconds as i64))
                    .to_rfc3339();
                    let event_id = Uuid::new_v4().to_string();
                    let _ = self.queue_event(AgentEvent {
                        event_id: event_id.clone(),
                        occurred_at: idle_occurred_at.clone(),
                        event_type: "idle".into(),
                        app_name: "Idle".into(),
                        process_name: "system".into(),
                        source_kind: "system_idle".into(),
                        context_label: None,
                        web_domain: None,
                        duration_seconds: bounded_idle_seconds as i64,
                    });
                    self.idle_session = Some(IdleSession {
                        event_id,
                        started_at: idle_started,
                        occurred_at: idle_occurred_at,
                        last_emitted_duration: bounded_idle_seconds as i64,
                    });
                }
                let _ = self.checkpoint_idle_session(now);
            } else {
                let _ = self.finish_idle_session(now);
                if self.status.policy.collect_app_activity {
                    if let Some(mut activity) = foreground_application() {
                        apply_collection_policy_to_activity(&mut activity, &self.status.policy);
                        if activity.web_domain.is_some() {
                            self.status.last_browser_capture_at = Some(Utc::now().to_rfc3339());
                            self.status.last_browser_capture_source =
                                Some(activity.source_kind.clone());
                        }
                        if activity_excluded(&activity, &self.status.policy) {
                            let _ = self.finish_session(now);
                        } else {
                            let changed = self
                                .active_session
                                .as_ref()
                                .map(|session| {
                                    session.process_name != activity.process_name
                                        || session.context_label != activity.context_label
                                        || session.web_domain != activity.web_domain
                                        || session.source_kind != activity.source_kind
                                })
                                .unwrap_or(true);
                            if changed {
                                let _ = self.finish_session(now);
                                self.active_session = Some(ActiveSession {
                                    event_id: Uuid::new_v4().to_string(),
                                    app_name: activity.app_name,
                                    process_name: activity.process_name,
                                    source_kind: activity.source_kind,
                                    context_label: activity.context_label,
                                    web_domain: activity.web_domain,
                                    started_at: now,
                                    occurred_at: Utc::now().to_rfc3339(),
                                    last_emitted_duration: 0,
                                });
                            }
                        }
                    } else {
                        let _ = self.finish_session(now);
                    }
                    let _ = self.checkpoint_session(now);
                } else {
                    let _ = self.finish_session(now);
                }
            }
        }

        let mut sync_error = None;
        let event_flush_due = self.status.queued_events > 0
            && now.duration_since(self.last_event_flush).as_secs() >= checkpoint_seconds;
        if event_flush_due {
            match self.flush_events() {
                Ok(()) => {
                    self.last_event_flush = now;
                    self.status.last_sync_at = Some(Utc::now().to_rfc3339());
                }
                Err(error) => sync_error = Some(error),
            }
        }

        if now.duration_since(self.last_heartbeat).as_secs()
            >= self.status.policy.heartbeat_interval_seconds
        {
            if let Err(error) = self.send_heartbeat() {
                sync_error = Some(error);
            }
        }

        if let Some(error) = sync_error {
            if error == "设备 Token 已失效，请重新注册" {
                self.status.state = "error".into();
            } else {
                self.status.state = "offline".into();
            }
            self.status.last_error = Some(error);
        } else if event_flush_due {
            self.status.state = "online".into();
            self.status.last_error = None;
        }
        self.status.queued_events = pending_count(&self.db);
    }
}

fn ensure_event_metadata_columns(db: &Connection) -> Result<(), String> {
    let mut statement = db
        .prepare("PRAGMA table_info(events)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for (name, definition) in [
        ("source_kind", "TEXT NOT NULL DEFAULT 'desktop_app'"),
        ("context_label", "TEXT"),
        ("web_domain", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            db.execute(
                &format!("ALTER TABLE events ADD COLUMN {name} {definition}"),
                [],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn read_config(db: &Connection, key: &str) -> Option<String> {
    db.query_row(
        "SELECT value FROM config WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn pending_count(db: &Connection) -> usize {
    db.query_row(
        "SELECT COUNT(*) FROM events WHERE uploaded = 0",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
    .max(0) as usize
}

fn within_work_hours(policy: &Policy) -> bool {
    fn parse_minutes(value: &str) -> Option<u32> {
        let mut parts = value.split(':');
        let hour = parts.next()?.parse::<u32>().ok()?;
        let minute = parts.next()?.parse::<u32>().ok()?;
        if minute >= 60 || hour > 24 || (hour == 24 && minute != 0) {
            return None;
        }
        Some(hour * 60 + minute)
    }
    let Some(start) = parse_minutes(&policy.work_hours_start) else {
        return true;
    };
    let Some(end) = parse_minutes(&policy.work_hours_end) else {
        return true;
    };
    // Collection policy is evaluated in China Standard Time regardless of the
    // Windows machine's regional timezone. Event timestamps remain UTC ISO-8601
    // on the wire and are rendered as Asia/Shanghai in the UIs.
    let now = (Utc::now() + chrono::Duration::hours(8)).time();
    let current = now.hour() * 60 + now.minute();
    if start == 0 && end == 24 * 60 {
        return true;
    }
    current >= start && current < end
}

fn activity_excluded(activity: &ForegroundActivity, policy: &Policy) -> bool {
    let process_name = activity.process_name.trim().to_lowercase();
    if policy
        .excluded_processes
        .iter()
        .any(|excluded| excluded.trim().eq_ignore_ascii_case(&process_name))
    {
        return true;
    }

    let Some(domain) = activity.web_domain.as_deref() else {
        return false;
    };
    let domain = domain.trim().to_lowercase();
    policy.excluded_domains.iter().any(|excluded| {
        let excluded = excluded.trim().to_lowercase();
        domain == excluded || domain.ends_with(&format!(".{excluded}"))
    })
}

fn store_secret(device_id: &str, token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, device_id)
        .map_err(|error| error.to_string())?
        .set_password(token)
        .map_err(|error| error.to_string())
}

fn load_secret(device_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, device_id)
        .ok()?
        .get_password()
        .ok()
}

fn remove_secret(device_id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, device_id) {
        let _ = entry.delete_credential();
    }
}

fn load_or_create_local_queue_key() -> Result<[u8; 32], String> {
    if let Some(encoded) = load_secret(LOCAL_QUEUE_KEY_ACCOUNT) {
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|error| format!("本地缓存密钥无法读取：{error}"))?;
        if decoded.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&decoded);
            return Ok(key);
        }
        return Err("本地缓存密钥长度无效，请重新注册 Agent".into());
    }

    let first = *Uuid::new_v4().as_bytes();
    let second = *Uuid::new_v4().as_bytes();
    let mut key = [0u8; 32];
    key[..16].copy_from_slice(&first);
    key[16..].copy_from_slice(&second);
    store_secret(LOCAL_QUEUE_KEY_ACCOUNT, &URL_SAFE_NO_PAD.encode(key))?;
    Ok(key)
}

fn is_encrypted_local_value(value: &str) -> bool {
    value.starts_with("enc:v1:")
}

fn encrypt_local_value(key: &[u8; 32], value: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let nonce_bytes = Uuid::new_v4().as_bytes()[..12].to_vec();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), value.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut payload = nonce_bytes;
    payload.extend(ciphertext);
    Ok(format!("enc:v1:{}", URL_SAFE_NO_PAD.encode(payload)))
}

fn decrypt_local_value(key: &[u8; 32], value: &str) -> Result<String, String> {
    if !is_encrypted_local_value(value) {
        return Ok(value.to_string());
    }
    let encoded = value
        .strip_prefix("enc:v1:")
        .ok_or_else(|| "本地缓存密文格式无效".to_string())?;
    let payload = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| format!("本地缓存密文无法读取：{error}"))?;
    if payload.len() <= 12 {
        return Err("本地缓存密文长度无效".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
        .map_err(|error| format!("本地缓存解密失败：{error}"))?;
    String::from_utf8(plaintext).map_err(|error| format!("本地缓存编码无效：{error}"))
}

#[cfg(windows)]
fn foreground_application() -> Option<ForegroundActivity> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, &mut process_id);
        if process_id == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(handle);
        if ok == 0 || length == 0 {
            return None;
        }
        let path = OsString::from_wide(&buffer[..length as usize])
            .to_string_lossy()
            .into_owned();
        let process_name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        let app_name = process_name.trim_end_matches(".exe").to_string();
        let title_length = GetWindowTextLengthW(window);
        let title = if title_length > 0 {
            let mut title_buffer = vec![0u16; title_length as usize + 1];
            let copied =
                GetWindowTextW(window, title_buffer.as_mut_ptr(), title_buffer.len() as i32);
            if copied > 0 {
                Some(
                    OsString::from_wide(&title_buffer[..copied as usize])
                        .to_string_lossy()
                        .into_owned(),
                )
            } else {
                None
            }
        } else {
            None
        };

        let browser_metadata = if is_browser_process(&app_name, &process_name) {
            native_browser_metadata(window)
        } else {
            None
        };
        let title_context_label = title
            .as_deref()
            .and_then(|value| sanitize_context_label(&app_name, &process_name, value));
        let context_label = merge_context_labels([
            title_context_label,
            browser_metadata
                .as_ref()
                .and_then(|metadata| metadata.context_label.clone()),
        ]);
        let title_domain = title
            .as_deref()
            .filter(|_| is_browser_process(&app_name, &process_name))
            .and_then(extract_explicit_web_domain);
        let web_domain = if is_browser_process(&app_name, &process_name) {
            browser_metadata
                .as_ref()
                .and_then(|metadata| metadata.domain.clone())
                .or(title_domain)
        } else {
            None
        };
        let source_kind = if web_domain.is_some() {
            "browser_native".to_string()
        } else {
            "desktop_app".to_string()
        };

        Some(ForegroundActivity {
            app_name,
            process_name,
            source_kind,
            context_label,
            web_domain,
        })
    }
}

#[cfg(windows)]
struct BrowserMetadata {
    domain: Option<String>,
    context_label: Option<String>,
}

#[cfg(windows)]
fn native_browser_metadata(
    window: windows_sys::Win32::Foundation::HWND,
) -> Option<BrowserMetadata> {
    use windows::core::BSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VT_BSTR};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ValueValuePropertyId,
    };

    fn variant_text(value: VARIANT) -> Option<String> {
        let variant_type = unsafe { value.Anonymous.Anonymous.vt };
        if variant_type != VT_BSTR {
            return None;
        }
        let bstr: BSTR = unsafe { (&*value.Anonymous.Anonymous.Anonymous.bstrVal).clone() };
        String::try_from(bstr)
            .ok()
            .filter(|text| !text.trim().is_empty())
    }

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.0 < 0 {
        return None;
    }

    let result = (|| unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation.ElementFromHandle(HWND(window)).ok()?;
        let condition = automation.CreateTrueCondition().ok()?;
        let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let length = elements.Length().ok()?.clamp(0, 300);
        let mut domain = None;
        let mut labels = Vec::new();
        for index in 0..length {
            let element = elements.GetElement(index).ok()?;
            let control_type = element.CurrentControlType().ok()?;
            let name = String::try_from(element.CurrentName().ok()?).unwrap_or_default();
            let automation_id =
                String::try_from(element.CurrentAutomationId().ok()?).unwrap_or_default();
            let descriptor = format!("{} {}", name, automation_id).to_lowercase();
            let value = if descriptor.contains("address")
                || descriptor.contains("omnibox")
                || descriptor.contains("地址")
                || descriptor.contains("搜索栏")
            {
                element
                    .GetCurrentPropertyValue(UIA_ValueValuePropertyId)
                    .ok()
                    .and_then(variant_text)
            } else {
                None
            };
            let looks_like_address_bar = descriptor.contains("address")
                || descriptor.contains("omnibox")
                || descriptor.contains("地址")
                || descriptor.contains("搜索栏")
                || value
                    .as_deref()
                    .map(|text| text.contains("http://") || text.contains("https://"))
                    .unwrap_or(false);
            if !looks_like_address_bar {
                append_semantic_labels(&mut labels, &name);
                continue;
            }
            if domain.is_none() {
                domain = value
                    .as_deref()
                    .and_then(extract_explicit_web_domain)
                    .or_else(|| extract_explicit_web_domain(&name));
            }
            let _ = control_type;
        }
        Some(BrowserMetadata {
            domain,
            context_label: (!labels.is_empty()).then(|| labels.join(" · ")),
        })
    })();
    unsafe { CoUninitialize() };
    result
}

#[cfg(not(windows))]
fn foreground_application() -> Option<ForegroundActivity> {
    None
}

#[cfg(windows)]
fn is_browser_process(app_name: &str, process_name: &str) -> bool {
    let value = format!("{} {}", app_name, process_name).to_lowercase();
    ["chrome", "msedge", "edge", "firefox", "360se"]
        .iter()
        .any(|name| value.contains(name))
}

#[cfg(windows)]
fn sanitize_context_label(app_name: &str, process_name: &str, title: &str) -> Option<String> {
    let value = format!("{} {}", app_name, process_name).to_lowercase();
    let mut labels = Vec::new();

    if is_browser_process(app_name, process_name) {
        let lower_title = title.to_lowercase();
        for (needle, label) in [
            ("github", "来源：GitHub"),
            ("gitlab", "来源：GitLab"),
            ("notion", "来源：Notion"),
            ("figma", "来源：Figma"),
            ("chatgpt", "来源：ChatGPT"),
            ("codex", "来源：Codex"),
            ("jira", "来源：Jira"),
            ("linear", "来源：Linear"),
            ("trello", "来源：Trello"),
            ("asana", "来源：Asana"),
            ("clickup", "来源：ClickUp"),
            ("feishu", "来源：飞书"),
            ("lark", "来源：飞书"),
            ("dingtalk", "来源：钉钉"),
            ("slack", "来源：Slack"),
            ("teams", "来源：Teams"),
        ] {
            if lower_title.contains(needle) {
                append_unique_label(&mut labels, label);
                break;
            }
        }
        append_semantic_labels(&mut labels, title);
        return (!labels.is_empty()).then(|| labels.join(" · "));
    }

    if value.contains("code.exe")
        || value.contains("visual studio")
        || value.contains("devenv")
        || value.contains("idea")
        || value.contains("pycharm")
        || value.contains("android studio")
    {
        if let Some(project) = extract_project_identifier(title) {
            append_unique_label(&mut labels, &project);
        }
        if let Some(resource) = infer_resource_label(title) {
            append_unique_label(&mut labels, &resource);
        }
        return (!labels.is_empty()).then(|| labels.join(" · "));
    }

    if is_document_process(&value) {
        if let Some(document) = extract_document_identifier(title) {
            append_unique_label(&mut labels, &document);
        }
        append_unique_label(&mut labels, "资源：文档");
        return Some(labels.join(" · "));
    }

    None
}

#[cfg(windows)]
fn merge_context_labels(values: [Option<String>; 2]) -> Option<String> {
    let mut labels = Vec::new();
    for value in values.into_iter().flatten() {
        for label in value.split(" · ") {
            append_unique_label(&mut labels, label);
        }
    }
    (!labels.is_empty()).then(|| labels.join(" · "))
}

#[cfg(windows)]
fn append_unique_label(labels: &mut Vec<String>, value: &str) {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 120
        || normalized.contains('\n')
        || normalized.contains('\r')
        || normalized.contains("http://")
        || normalized.contains("https://")
        || normalized.contains('/')
        || normalized.contains('\\')
        || labels.iter().any(|item| item == normalized)
    {
        return;
    }
    labels.push(normalized.to_string());
}

#[cfg(windows)]
fn append_semantic_labels(labels: &mut Vec<String>, text: &str) {
    let lower = text.to_lowercase();
    if let Some(project) = extract_repository_identifier(text) {
        append_unique_label(labels, &project);
    }
    if let Some(operation) = infer_operation_label(&lower) {
        append_unique_label(labels, operation);
    }
    if let Some(status) = infer_status_label(&lower) {
        append_unique_label(labels, status);
    }
    if let Some(resource) = infer_resource_label(text) {
        append_unique_label(labels, &resource);
    }
}

#[cfg(windows)]
fn extract_repository_identifier(text: &str) -> Option<String> {
    for candidate in text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '-' | '.'))
    }) {
        let mut parts = candidate.split('/');
        let Some(owner) = parts.next().map(str::trim) else {
            continue;
        };
        let Some(repository) = parts.next().map(str::trim) else {
            continue;
        };
        if parts.next().is_some()
            || owner.is_empty()
            || repository.is_empty()
            || !is_safe_identifier_part(owner)
            || !is_safe_identifier_part(repository)
            || owner.eq_ignore_ascii_case("http")
            || owner.eq_ignore_ascii_case("https")
            || repository.eq_ignore_ascii_case("com")
        {
            continue;
        }
        return sanitize_label(repository, "项目：");
    }
    None
}

#[cfg(windows)]
fn is_safe_identifier_part(value: &str) -> bool {
    value.len() <= 80
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

#[cfg(windows)]
fn infer_operation_label(lower_text: &str) -> Option<&'static str> {
    if [
        "actions",
        "workflow",
        "build",
        "msi",
        "artifact",
        "构建",
        "安装包",
        "流水线",
    ]
    .iter()
    .any(|needle| lower_text.contains(needle))
    {
        return Some("操作：构建发布");
    }
    if ["pull request", "merge request", "commit", "提交", "分支"]
        .iter()
        .any(|needle| lower_text.contains(needle))
    {
        return Some("操作：代码协作");
    }
    if ["issue", "问题", "bug", "缺陷"]
        .iter()
        .any(|needle| lower_text.contains(needle))
    {
        return Some("操作：问题跟踪");
    }
    if ["readme", "documentation", "docs", "文档"]
        .iter()
        .any(|needle| lower_text.contains(needle))
    {
        return Some("操作：查看文档");
    }
    None
}

#[cfg(windows)]
fn infer_status_label(lower_text: &str) -> Option<&'static str> {
    if ["failed", "failure", "error", "失败", "错误"]
        .iter()
        .any(|needle| lower_text.contains(needle))
    {
        return Some("状态：失败");
    }
    if [
        "success",
        "successful",
        "succeeded",
        "passed",
        "successfully",
        "成功",
        "通过",
    ]
    .iter()
    .any(|needle| lower_text.contains(needle))
    {
        return Some("状态：成功");
    }
    if ["running", "in progress", "queued", "进行中", "排队"]
        .iter()
        .any(|needle| lower_text.contains(needle))
    {
        return Some("状态：进行中");
    }
    None
}

#[cfg(windows)]
fn infer_resource_label(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if [
        ".rs",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        "cargo.toml",
        "package.json",
        "source code",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Some("资源：代码".into());
    }
    if [
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", "文档",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Some("资源：文档".into());
    }
    if ["artifact", "安装包", "下载"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return Some("资源：构建产物".into());
    }
    None
}

#[cfg(windows)]
fn is_document_process(value: &str) -> bool {
    [
        "explorer.exe",
        "wps.exe",
        "et.exe",
        "wpp.exe",
        "winword.exe",
        "excel.exe",
        "powerpnt.exe",
        "notepad.exe",
        "wordpad.exe",
        "acrobat.exe",
        "foxitreader.exe",
    ]
    .iter()
    .any(|name| value.contains(name))
}

#[cfg(windows)]
fn extract_document_identifier(title: &str) -> Option<String> {
    let mut candidate = title.trim();
    for suffix in [
        " - File Explorer",
        " - Windows File Explorer",
        " - WPS Office",
        " - Word",
        " - Excel",
        " - PowerPoint",
        " - Notepad",
        " – File Explorer",
        " – WPS Office",
    ] {
        if let Some(value) = candidate.strip_suffix(suffix) {
            candidate = value.trim();
            break;
        }
    }
    candidate = candidate
        .trim_start_matches('*')
        .trim_matches(' ')
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(candidate)
        .trim();
    if candidate.is_empty()
        || ["home", "desktop", "documents", "downloads"]
            .contains(&candidate.to_lowercase().as_str())
    {
        return None;
    }
    let allowed_extensions = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "txt", "csv", "rtf",
    ];
    let has_allowed_extension = candidate.rsplit_once('.').is_some_and(|(_, extension)| {
        allowed_extensions.contains(&extension.to_lowercase().as_str())
    });
    if !has_allowed_extension && candidate.contains('.') {
        return None;
    }
    Some(redacted_document_label(candidate))
}

#[cfg(windows)]
fn redacted_document_label(candidate: &str) -> String {
    let extension = candidate
        .rsplit_once('.')
        .map(|(_, extension)| format!(".{}", extension.to_lowercase()))
        .unwrap_or_default();
    if extension.is_empty() {
        return "文件夹：脱敏文件夹".into();
    }
    let prefix = if is_sensitive_document_name(candidate) {
        "敏感文件"
    } else {
        "脱敏文件"
    };
    format!("文档：{prefix}{extension}")
}

#[cfg(windows)]
fn is_sensitive_document_name(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || [
            "password",
            "passwd",
            "secret",
            "token",
            "credential",
            "apikey",
            "api_key",
            "private_key",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
}

#[cfg(windows)]
fn extract_project_identifier(title: &str) -> Option<String> {
    let mut prefix = None;
    for suffix in [
        " - Visual Studio Code",
        " - Microsoft Visual Studio",
        " - IntelliJ IDEA",
        " - PyCharm",
        " - Android Studio",
        " – Visual Studio Code",
        " – Microsoft Visual Studio",
    ] {
        if let Some(value) = title.strip_suffix(suffix) {
            prefix = Some(value);
            break;
        }
    }
    let prefix = prefix.unwrap_or(title);
    let candidate = prefix
        .rsplit_once(" - ")
        .map(|(_, value)| value)
        .or_else(|| prefix.rsplit_once(" – ").map(|(_, value)| value))
        .unwrap_or(prefix)
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(prefix)
        .trim();
    let lower = candidate.to_lowercase();
    if candidate.is_empty()
        || [
            "welcome",
            "untitled",
            "visual studio code",
            "microsoft visual studio",
        ]
        .iter()
        .any(|value| lower == *value)
    {
        return None;
    }
    if candidate.rsplit_once('.').is_some_and(|(_, extension)| {
        [
            "txt", "md", "rs", "js", "jsx", "ts", "tsx", "json", "csv", "py", "java", "cs", "go",
            "html", "css", "sql", "docx", "xlsx", "pptx",
        ]
        .contains(&extension.to_lowercase().as_str())
    }) {
        return None;
    }
    sanitize_label(candidate, "项目：")
}

#[cfg(windows)]
fn sanitize_label(value: &str, prefix: &str) -> Option<String> {
    if value.contains('\\') || value.contains('/') {
        return None;
    }
    let mut output = String::new();
    let mut previous_space = false;
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '-' | '.') {
            output.push(character);
            previous_space = false;
        } else if character.is_whitespace() && !previous_space {
            output.push(' ');
            previous_space = true;
        }
    }
    let output = output.trim().trim_matches('.').to_string();
    if output.is_empty() {
        return None;
    }
    let limited = output.chars().take(80).collect::<String>();
    Some(format!("{prefix}{limited}"))
}

#[cfg(windows)]
fn extract_explicit_web_domain(title: &str) -> Option<String> {
    const KNOWN_TLDS: [&str; 12] = [
        "com", "cn", "org", "net", "io", "ai", "dev", "co", "gov", "edu", "app", "me",
    ];
    for token in title.split(|character: char| {
        !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
    }) {
        let candidate = token.trim_matches('.').to_lowercase();
        if candidate == "localhost" {
            return Some(candidate);
        }
        let parts = candidate.split('.').collect::<Vec<_>>();
        if parts.len() < 2
            || parts
                .iter()
                .any(|part| part.is_empty() || part.starts_with('-') || part.ends_with('-'))
            || !parts.iter().all(|part| {
                part.chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
            || !KNOWN_TLDS.contains(&parts.last().copied().unwrap_or_default())
        {
            continue;
        }
        return Some(candidate);
    }
    None
}

#[cfg(windows)]
fn system_idle_seconds() -> u64 {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return 0;
        }
        // LASTINPUTINFO.dwTime is a 32-bit tick count. Use the matching
        // 32-bit counter so machines running for more than 49 days do not
        // produce an incorrectly huge idle duration.
        let now_ms = GetTickCount();
        now_ms.wrapping_sub(info.dwTime) as u64 / 1000
    }
}

#[cfg(not(windows))]
fn system_idle_seconds() -> u64 {
    0
}

#[cfg(windows)]
fn enable_startup(_app: &AppHandle) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;
    if let Ok(executable) = std::env::current_exe() {
        if let Ok((run_key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_WRITE,
        ) {
            let command = format!("\"{}\"", executable.to_string_lossy());
            let _ = run_key.set_value("AIJinyiweiAgent", &command);
        }
    }
}

#[cfg(not(windows))]
fn enable_startup(_app: &AppHandle) {}

#[tauri::command]
fn get_agent_status(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    Ok(state
        .core
        .lock()
        .map_err(|error| error.to_string())?
        .status
        .clone())
}

#[tauri::command]
fn enroll_agent(
    server_url: String,
    registration_code: String,
    state: State<'_, AgentState>,
) -> Result<AgentStatus, String> {
    let mut core = state.core.lock().map_err(|error| error.to_string())?;
    core.enroll_from_code(&server_url, &registration_code)?;
    Ok(core.status.clone())
}

#[tauri::command]
fn create_browser_pairing_code(
    state: State<'_, AgentState>,
) -> Result<BrowserPairingResponse, String> {
    let core = state.core.lock().map_err(|error| error.to_string())?;
    core.create_browser_pairing_code()
}

#[tauri::command]
fn acknowledge_privacy(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let mut core = state.core.lock().map_err(|error| error.to_string())?;
    core.acknowledge_privacy()?;
    Ok(core.status.clone())
}

#[tauri::command]
fn clear_registration(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let mut core = state.core.lock().map_err(|error| error.to_string())?;
    let device_id = core.status.device_id.clone();
    core.clear_local_data()?;
    if let Some(device_id) = device_id {
        remove_secret(&device_id);
    }
    core.token = None;
    core.status = AgentStatus::default();
    Ok(core.status.clone())
}

fn start_worker(app: AppHandle, core: Arc<Mutex<Core>>) {
    thread::spawn(move || loop {
        let mut runtime = match core.lock() {
            Ok(runtime) => runtime,
            Err(poisoned) => poisoned.into_inner(),
        };
        let tick_result = catch_unwind(AssertUnwindSafe(|| runtime.tick()));
        if tick_result.is_err() {
            runtime.status.state = "error".into();
            runtime.status.last_error = Some("Agent 采集线程发生异常，已自动恢复并继续运行".into());
        }
        let _ = app.emit("agent-status", runtime.status.clone());
        thread::sleep(Duration::from_secs(1));
    });
}

fn create_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "打开 Agent", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Agent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("AI锦衣卫 Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
            let mut runtime = Core::new(data_dir.join("agent.sqlite")).map_err(|error| {
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, error))
                    as Box<dyn std::error::Error>
            })?;
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
            runtime.load_bootstrap(resource_dir);
            let core = Arc::new(Mutex::new(runtime));
            app.manage(AgentState { core: core.clone() });
            enable_startup(app.handle());
            create_tray(app.handle())?;
            start_worker(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_agent_status,
            enroll_agent,
            create_browser_pairing_code,
            acknowledge_privacy,
            clear_registration
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AI锦衣卫 Agent");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    run();
}

#[cfg(test)]
mod local_queue_crypto_tests {
    use super::{decrypt_local_value, encrypt_local_value, is_encrypted_local_value};

    #[test]
    fn encrypts_and_decrypts_local_activity_metadata() {
        let key = [7u8; 32];
        let encrypted = encrypt_local_value(&key, "AI锦衣卫系统 / GitHub")
            .expect("local metadata should encrypt");
        assert!(is_encrypted_local_value(&encrypted));
        assert_ne!(encrypted, "AI锦衣卫系统 / GitHub");
        assert_eq!(
            decrypt_local_value(&key, &encrypted).expect("local metadata should decrypt"),
            "AI锦衣卫系统 / GitHub"
        );
    }

    #[test]
    fn keeps_legacy_plaintext_readable_for_startup_migration() {
        let key = [9u8; 32];
        assert_eq!(
            decrypt_local_value(&key, "legacy-app").expect("legacy value should be readable"),
            "legacy-app"
        );
        assert!(!is_encrypted_local_value("legacy-app"));
    }
}

#[cfg(all(test, windows))]
mod windows_metadata_tests {
    use super::{
        extract_explicit_web_domain, extract_repository_identifier, infer_operation_label,
        infer_status_label, sanitize_context_label,
    };

    #[test]
    fn extracts_only_the_host_from_browser_title_text() {
        assert_eq!(
            extract_explicit_web_domain("GitHub - https://github.com/openai/project/issues/1"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_explicit_web_domain("Microsoft Edge | jd.com"),
            Some("jd.com".to_string())
        );
    }

    #[test]
    fn rejects_non_domain_text() {
        assert_eq!(
            extract_explicit_web_domain("C:\\Users\\Wei\\report.docx"),
            None
        );
        assert_eq!(extract_explicit_web_domain("搜索栏"), None);
    }

    #[test]
    fn keeps_only_allowlisted_context_labels() {
        assert_eq!(
            sanitize_context_label("Code", "Code.exe", "AI锦衣卫系统 - Visual Studio Code"),
            Some("项目：AI锦衣卫系统".to_string())
        );
        assert_eq!(
            sanitize_context_label("Chrome", "chrome.exe", "ChatGPT - github.com"),
            Some("来源：GitHub".to_string())
        );
    }

    #[test]
    fn derives_redacted_project_operation_and_status_labels() {
        let title = "Build AI锦衣卫 Windows Agent · wzhang217/ai-jinyiwei-system · GitHub Actions · Success";
        assert_eq!(
            extract_repository_identifier(title),
            Some("项目：ai-jinyiwei-system".to_string())
        );
        assert_eq!(
            infer_operation_label(&title.to_lowercase()),
            Some("操作：构建发布")
        );
        assert_eq!(
            infer_status_label(&title.to_lowercase()),
            Some("状态：成功")
        );
        assert_eq!(
            sanitize_context_label("Chrome", "chrome.exe", title),
            Some(
                "来源：GitHub · 项目：ai-jinyiwei-system · 操作：构建发布 · 状态：成功".to_string()
            )
        );
    }
}
