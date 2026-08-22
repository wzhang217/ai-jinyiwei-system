#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{Local, Timelike, Utc};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use uuid::Uuid;

const AGENT_VERSION: &str = "0.1.3";
const KEYRING_SERVICE: &str = "ai-jinyiwei-agent";
const MAX_PENDING_EVENTS: i64 = 10_000;
const MAX_EVENT_DURATION_SECONDS: i64 = 86_400;
const ACTIVE_SESSION_CHECKPOINT_SECONDS: i64 = 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Policy {
    idle_threshold_seconds: u64,
    heartbeat_interval_seconds: u64,
    work_hours_start: String,
    work_hours_end: String,
    version: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            idle_threshold_seconds: 300,
            heartbeat_interval_seconds: 60,
            work_hours_start: "09:00".into(),
            work_hours_end: "18:00".into(),
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
    agent_version: String,
    policy: Policy,
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
            agent_version: AGENT_VERSION.into(),
            policy: Policy::default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentEvent {
    event_id: String,
    occurred_at: String,
    event_type: String,
    app_name: String,
    process_name: String,
    context_label: Option<String>,
    web_domain: Option<String>,
    duration_seconds: i64,
}

#[derive(Clone, Debug)]
struct ActiveSession {
    event_id: String,
    app_name: String,
    process_name: String,
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
    context_label: Option<String>,
    web_domain: Option<String>,
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
    active_session: Option<ActiveSession>,
    idle_session: Option<IdleSession>,
    last_heartbeat: Instant,
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
               context_label TEXT,
               web_domain TEXT,
               duration_seconds INTEGER NOT NULL,
               uploaded INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|error| error.to_string())?;
        ensure_event_metadata_columns(&db)?;

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

        Ok(Self {
            db,
            http: Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(|error| error.to_string())?,
            status,
            token,
            active_session: None,
            idle_session: None,
            last_heartbeat: Instant::now() - Duration::from_secs(60),
            pending_registration_code: None,
            last_auto_enroll_attempt: Instant::now() - Duration::from_secs(60),
        })
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

    fn clear_config(&self) -> Result<(), String> {
        self.db
            .execute("DELETE FROM config", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn queue_event(&mut self, event: AgentEvent) -> Result<(), String> {
        self.db.execute(
            "INSERT INTO events (event_id, occurred_at, event_type, app_name, process_name, context_label, web_domain, duration_seconds) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(event_id) DO UPDATE SET context_label = excluded.context_label, web_domain = excluded.web_domain, duration_seconds = MAX(events.duration_seconds, excluded.duration_seconds)",
            params![event.event_id, event.occurred_at, event.event_type, event.app_name, event.process_name, event.context_label, event.web_domain, event.duration_seconds],
        ).map_err(|error| error.to_string())?;
        let removed = self.db.execute(
            "DELETE FROM events WHERE uploaded = 0 AND event_id IN (SELECT event_id FROM events WHERE uploaded = 0 ORDER BY occurred_at ASC LIMIT -1 OFFSET ?1)",
            params![MAX_PENDING_EVENTS],
        ).map_err(|error| error.to_string())?;
        if removed > 0 {
            self.status.last_error = Some("本地缓存已达到上限，最早活动记录已被丢弃".into());
        }
        self.status.queued_events = pending_count(&self.db);
        Ok(())
    }

    fn pending_events(&self, limit: usize) -> Result<Vec<AgentEventPayload>, String> {
        let mut statement = self.db.prepare("SELECT event_id, occurred_at, event_type, app_name, process_name, context_label, web_domain, duration_seconds FROM events WHERE uploaded = 0 ORDER BY occurred_at ASC LIMIT ?1").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit as i64], |row| {
                Ok(AgentEventPayload {
                    event_id: row.get(0)?,
                    occurred_at: row.get(1)?,
                    event_type: row.get(2)?,
                    app_name: row.get(3)?,
                    process_name: row.get(4)?,
                    context_label: row.get(5)?,
                    web_domain: row.get(6)?,
                    duration_seconds: row.get::<_, i64>(7)?.clamp(0, MAX_EVENT_DURATION_SECONDS),
                })
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
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
        let events = self.pending_events(100)?;
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
            })
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
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
            return Err(format!("心跳同步失败：HTTP {status}：{body}"));
        }
        let body: HeartbeatResponse = response.json().map_err(|error| error.to_string())?;
        self.status.policy = body.policy;
        self.status.last_sync_at = Some(Utc::now().to_rfc3339());
        self.status.last_error = None;
        self.status.state = "online".into();
        self.last_heartbeat = Instant::now();
        Ok(())
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
        if duration < ACTIVE_SESSION_CHECKPOINT_SECONDS || duration <= last_emitted_duration {
            return Ok(());
        }
        self.queue_event(AgentEvent {
            event_id,
            occurred_at,
            event_type: "idle".into(),
            app_name: "Idle".into(),
            process_name: "system".into(),
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
        if duration < ACTIVE_SESSION_CHECKPOINT_SECONDS || duration <= last_emitted_duration {
            return Ok(());
        }
        self.queue_event(AgentEvent {
            event_id,
            occurred_at,
            event_type: "app_session".into(),
            app_name,
            process_name,
            context_label,
            web_domain,
            duration_seconds: duration,
        })?;
        if let Some(session) = self.active_session.as_mut() {
            session.last_emitted_duration = duration;
        }
        Ok(())
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
        self.status.state = "online".into();
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
        if !within_work_hours(&self.status.policy) {
            let _ = self.finish_session(now);
            let _ = self.finish_idle_session(now);
        } else {
            let idle_seconds = system_idle_seconds();
            let idle_limit = self.status.policy.idle_threshold_seconds;
            if idle_seconds >= idle_limit {
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
            } else if let Some(activity) = foreground_application() {
                let _ = self.finish_idle_session(now);
                let changed = self
                    .active_session
                    .as_ref()
                    .map(|session| {
                        session.process_name != activity.process_name
                            || session.context_label != activity.context_label
                            || session.web_domain != activity.web_domain
                    })
                    .unwrap_or(true);
                if changed {
                    let _ = self.finish_session(now);
                    self.active_session = Some(ActiveSession {
                        event_id: Uuid::new_v4().to_string(),
                        app_name: activity.app_name,
                        process_name: activity.process_name,
                        context_label: activity.context_label,
                        web_domain: activity.web_domain,
                        started_at: now,
                        occurred_at: Utc::now().to_rfc3339(),
                        last_emitted_duration: 0,
                    });
                }
            }
            let _ = self.checkpoint_session(now);
        }

        if now.duration_since(self.last_heartbeat).as_secs()
            >= self.status.policy.heartbeat_interval_seconds
        {
            let result = self.flush_events().and_then(|_| self.send_heartbeat());
            if let Err(error) = result {
                self.status.state = "offline".into();
                self.status.last_error = Some(error);
            }
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

    for (name, definition) in [("context_label", "TEXT"), ("web_domain", "TEXT")] {
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
    let now = Local::now().time();
    let current = now.hour() * 60 + now.minute();
    if start == 0 && end == 24 * 60 {
        return true;
    }
    current >= start && current < end
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

        let context_label = title
            .as_deref()
            .and_then(|value| sanitize_context_label(&app_name, &process_name, value));
        let web_domain = title
            .as_deref()
            .filter(|_| is_browser_process(&app_name, &process_name))
            .and_then(extract_explicit_web_domain);

        Some(ForegroundActivity {
            app_name,
            process_name,
            context_label,
            web_domain,
        })
    }
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
                return Some(label.into());
            }
        }
        return None;
    }

    if value.contains("code.exe")
        || value.contains("visual studio")
        || value.contains("devenv")
        || value.contains("idea")
        || value.contains("pycharm")
        || value.contains("android studio")
    {
        return extract_project_identifier(title);
    }

    if is_document_process(&value) {
        return extract_document_identifier(title);
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
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let extension = candidate
        .rsplit_once('.')
        .map(|(_, extension)| format!(".{}", extension.to_lowercase()))
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    candidate.to_lowercase().hash(&mut hasher);
    let prefix = if is_sensitive_document_name(candidate) {
        "敏感文档"
    } else if extension.is_empty() {
        "文件夹"
    } else {
        "文档"
    };
    format!("文档：{prefix}标识-{:08x}{extension}", hasher.finish())
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
        if let Ok(run_key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
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
fn clear_registration(state: State<'_, AgentState>) -> Result<AgentStatus, String> {
    let mut core = state.core.lock().map_err(|error| error.to_string())?;
    if let Some(device_id) = core.status.device_id.clone() {
        remove_secret(&device_id);
    }
    core.clear_config()?;
    core.token = None;
    core.status = AgentStatus::default();
    Ok(core.status.clone())
}

fn start_worker(app: AppHandle, core: Arc<Mutex<Core>>) {
    thread::spawn(move || loop {
        if let Ok(mut runtime) = core.lock() {
            runtime.tick();
            let _ = app.emit("agent-status", runtime.status.clone());
        }
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
