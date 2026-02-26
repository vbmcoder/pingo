// src-tauri/src/commands.rs
// IPC Commands exposed to frontend

use crate::crypto::{generate_device_id, CryptoManager, EncryptedEnvelope};
use crate::db::{
    generate_id, now, Database, Group, GroupMember, GroupMessage, LastMessageInfo, Message, Note,
    Settings, User,
};
use crate::discovery::{DiscoveryEvent, DiscoveryManager, PeerInfo};
use crate::file_server::FileServer;
use crate::file_transfer::{FileChunk, FileMetadata, FileTransferManager, TransferProgress};
use crate::signaling::{SignalingMessage, SignalingServer};
use crate::tray;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// App state containing all managers
pub struct AppState {
    pub db: Arc<Database>,
    pub discovery: Arc<DiscoveryManager>,
    pub crypto: Arc<CryptoManager>,
    pub signaling: Arc<SignalingServer>,
    pub file_transfer: Arc<FileTransferManager>,
    pub file_server: Arc<FileServer>,
    pub device_id: String,
}

impl AppState {
    pub fn new() -> Result<Self, String> {
        let db = Database::new().map_err(|e| e.to_string())?;

        let device_id = match db.get_setting("device_id") {
            Ok(Some(id)) if !id.is_empty() => {
                println!(
                    "[Pingo] Loaded persisted device_id: {}",
                    &id[..8.min(id.len())]
                );
                id
            }
            _ => {
                let new_id = generate_device_id();
                db.set_setting("device_id", &new_id)
                    .map_err(|e| e.to_string())?;
                println!(
                    "[Pingo] Generated new device_id: {}",
                    &new_id[..8.min(new_id.len())]
                );
                new_id
            }
        };

        Ok(AppState {
            db: Arc::new(db),
            discovery: Arc::new(DiscoveryManager::new()),
            crypto: Arc::new(CryptoManager::new()),
            signaling: Arc::new(SignalingServer::new(device_id.clone())),
            file_transfer: Arc::new(FileTransferManager::new()),
            file_server: Arc::new(FileServer::new()),
            device_id,
        })
    }
}

// Throttle file writes to avoid unbounded growth during noisy periods (e.g., presence updates).
// We still print to stdout every time for debugging, but only write to disk at most once per second.
static LAST_DEV_LOG_WRITE: OnceLock<AtomicU64> = OnceLock::new();

fn dev_log(msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let s = format!("[{}] [Pingo] {}", ts, msg);
    println!("{}", s);

    let last_write = LAST_DEV_LOG_WRITE.get_or_init(|| AtomicU64::new(0));
    let prev = last_write.load(Ordering::Relaxed);
    if ts.saturating_sub(prev) >= 1 {
        // safe to write to file — place log in the app data directory (same place as DB)
        last_write.store(ts, Ordering::Relaxed);
        // Determine a stable app-local location to avoid touching the source tree and
        // triggering dev rebuilds when the log file changes.
        let log_dir = Database::get_db_path()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let log_path = log_dir.join("pingo_dev_log.txt");
        // Ensure directory exists
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "{}", s);
        }
    }
}

#[derive(Serialize)]
pub struct InitResult {
    pub device_id: String,
    pub public_key: String,
    pub db_path: String,
    pub downloads_path: String,
}

#[tauri::command]
pub fn init_app(state: State<AppState>) -> Result<InitResult, String> {
    dev_log("init_app started");
    // spawn a one-shot watchdog to detect unusually long init
    let watchdog_device = state.device_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        dev_log(&format!(
            "init_app still running after 10s for device {}",
            watchdog_device
        ));
    });

    let public_key = state.crypto.generate_keypair();
    state
        .db
        .set_setting("public_key", &public_key)
        .map_err(|e| e.to_string())?;

    // Start file server with retry
    let file_port = state.file_server.start(18080).unwrap_or(0);
    if file_port == 0 {
        dev_log("ERROR: File server failed to start on any port!");
        return Err("File server failed to start".to_string());
    }
    dev_log(&format!(
        "File server started successfully on port {}",
        file_port
    ));

    // Add a small delay to ensure the server thread has time to bind
    std::thread::sleep(std::time::Duration::from_millis(100));

    let existing_user = state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())?;
    if existing_user.is_none() {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Pingo User".to_string());
        let user = User {
            id: state.device_id.clone(),
            username: hostname,
            device_id: state.device_id.clone(),
            public_key: Some(public_key.clone()),
            avatar_path: None,
            bio: Some(String::new()),
            designation: Some(String::new()),
            last_seen: Some(now()),
            is_online: true,
            created_at: now(),
        };
        state.db.create_user(&user).map_err(|e| e.to_string())?;
    } else {
        let mut user = existing_user.unwrap();
        user.public_key = Some(public_key.clone());
        user.is_online = true;
        user.last_seen = Some(now());
        state.db.create_user(&user).map_err(|e| e.to_string())?;
    }

    dev_log(&format!(
        "init_app complete. device_id={}",
        &state.device_id
    ));
    Ok(InitResult {
        device_id: state.device_id.clone(),
        public_key,
        db_path: Database::get_db_path().to_string_lossy().to_string(),
        downloads_path: state
            .file_transfer
            .get_downloads_dir()
            .to_string_lossy()
            .to_string(),
    })
}

// ============ USER COMMANDS ============

#[derive(Deserialize)]
pub struct CreateUserInput {
    pub username: String,
    pub avatar_path: Option<String>,
    pub bio: Option<String>,
    pub designation: Option<String>,
}

#[tauri::command]
pub fn create_user(state: State<AppState>, input: CreateUserInput) -> Result<User, String> {
    // Load existing user to preserve fields not being updated
    let existing = state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())?;
    let user = User {
        id: state.device_id.clone(),
        username: input.username,
        device_id: state.device_id.clone(),
        public_key: state.crypto.get_public_key(),
        avatar_path: input
            .avatar_path
            .or_else(|| existing.as_ref().and_then(|u| u.avatar_path.clone())),
        bio: input
            .bio
            .or_else(|| existing.as_ref().and_then(|u| u.bio.clone())),
        designation: input
            .designation
            .or_else(|| existing.as_ref().and_then(|u| u.designation.clone())),
        last_seen: Some(now()),
        is_online: true,
        created_at: existing.map(|u| u.created_at).unwrap_or_else(now),
    };
    state.db.create_user(&user).map_err(|e| e.to_string())?;
    Ok(user)
}

#[tauri::command]
pub fn get_user(state: State<AppState>, id: String) -> Result<Option<User>, String> {
    state.db.get_user(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_users(state: State<AppState>) -> Result<Vec<User>, String> {
    state.db.get_all_users().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_user(state: State<AppState>) -> Result<Option<User>, String> {
    state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
#[tauri::command]
pub fn append_dev_log(message: String) -> Result<(), String> {
    dev_log(&message);
    Ok(())
}

// ============ MESSAGE COMMANDS ============

#[derive(Deserialize)]
pub struct SendMessageInput {
    pub receiver_id: String,
    pub content: String,
    pub message_type: Option<String>,
    pub file_path: Option<String>,
}

#[tauri::command]
pub fn send_message(state: State<AppState>, input: SendMessageInput) -> Result<Message, String> {
    let message = Message {
        id: generate_id(),
        sender_id: state.device_id.clone(),
        receiver_id: input.receiver_id,
        content: input.content,
        message_type: input.message_type.unwrap_or_else(|| "text".into()),
        file_path: input.file_path,
        is_read: false,
        is_delivered: false,
        created_at: now(),
    };
    state
        .db
        .create_message(&message)
        .map_err(|e| e.to_string())?;
    Ok(message)
}

#[tauri::command]
pub fn get_messages(
    state: State<AppState>,
    peer_id: String,
    limit: Option<i32>,
) -> Result<Vec<Message>, String> {
    state
        .db
        .get_messages_between(&state.device_id, &peer_id, limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_messages_paginated(
    state: State<AppState>,
    peer_id: String,
    before: Option<String>,
    limit: Option<i32>,
) -> Result<Vec<Message>, String> {
    state
        .db
        .get_messages_paginated(
            &state.device_id,
            &peer_id,
            before.as_deref(),
            limit.unwrap_or(50),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_new_messages_since(
    state: State<AppState>,
    peer_id: String,
    since: String,
) -> Result<Vec<Message>, String> {
    state
        .db
        .get_new_messages_since(&state.device_id, &peer_id, &since)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_message_read(state: State<AppState>, message_id: String) -> Result<(), String> {
    state
        .db
        .mark_message_read(&message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_messages_read_from_peer(state: State<AppState>, peer_id: String) -> Result<(), String> {
    state
        .db
        .mark_messages_read_from_peer(&state.device_id, &peer_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_message_delivered(state: State<AppState>, message_id: String) -> Result<(), String> {
    state
        .db
        .mark_message_delivered(&message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_undelivered_messages_for_peer(
    state: State<AppState>,
    peer_id: String,
) -> Result<Vec<Message>, String> {
    state
        .db
        .get_undelivered_messages_for_peer(&state.device_id, &peer_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_unread_count(state: State<AppState>) -> Result<i32, String> {
    state
        .db
        .get_unread_count(&state.device_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_unread_count_from_peer(state: State<AppState>, peer_id: String) -> Result<i32, String> {
    state
        .db
        .get_unread_count_from_peer(&state.device_id, &peer_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_last_messages(state: State<AppState>) -> Result<Vec<LastMessageInfo>, String> {
    state
        .db
        .get_last_messages(&state.device_id)
        .map_err(|e| e.to_string())
}

// ============ DISCOVERY COMMANDS ============

#[tauri::command]
pub fn start_discovery<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    username: String,
    port: u16,
) -> Result<(), String> {
    let public_key = state
        .crypto
        .get_public_key()
        .ok_or("Public key not initialized")?;
    if state
        .discovery
        .start(state.device_id.clone(), username, port, public_key)?
    {
        let discovery = Arc::clone(&state.discovery);
        let db = Arc::clone(&state.db);
        let signaling = Arc::clone(&state.signaling);
        let app_clone = app.clone();

        std::thread::spawn(move || {
            let receiver = discovery.get_event_receiver();
            loop {
                if !discovery.is_running() {
                    break;
                }
                match receiver.recv_timeout(std::time::Duration::from_millis(500)) {
                    Ok(event) => match event {
                        DiscoveryEvent::PeerDiscovered { ref peer } => {
                            let _ = db.upsert_peer_as_user(
                                &peer.device_id,
                                &peer.username,
                                Some(&peer.public_key),
                            );
                            // Auto-register peer in signaling for reliable message delivery
                            let _ = signaling.register_peer(
                                &peer.device_id,
                                &peer.ip_address,
                                peer.port,
                            );
                            let _ = app_clone.emit("peer-discovered", peer);
                        }
                        DiscoveryEvent::PeerUpdated { ref peer } => {
                            let _ = db.upsert_peer_as_user(
                                &peer.device_id,
                                &peer.username,
                                Some(&peer.public_key),
                            );
                            let _ = signaling.register_peer(
                                &peer.device_id,
                                &peer.ip_address,
                                peer.port,
                            );
                            let _ = app_clone.emit("peer-updated", peer);
                        }
                        DiscoveryEvent::PeerLost { device_id } => {
                            let _ = app_clone
                                .emit("peer-lost", serde_json::json!({ "device_id": device_id }));
                        }
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn stop_discovery(state: State<AppState>) -> Result<(), String> {
    state.discovery.stop();
    Ok(())
}

#[tauri::command]
pub fn get_peers(state: State<AppState>) -> Vec<PeerInfo> {
    state.discovery.get_peers()
}

#[tauri::command]
pub fn get_online_peers(state: State<AppState>) -> Vec<PeerInfo> {
    state.discovery.get_online_peers()
}

// ============ SIGNALING COMMANDS ============

#[tauri::command]
pub fn start_signaling<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    port: Option<u16>,
) -> Result<u16, String> {
    let actual_port = state.signaling.start(port.unwrap_or(45678))?;
    let signaling = Arc::clone(&state.signaling);
    let db = Arc::clone(&state.db);
    let local_device_id = state.device_id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let receiver = signaling.get_event_receiver();
        dev_log(&format!(
            "Signaling event forwarder started on port {}",
            actual_port
        ));
        loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(msg) => match &msg {
                    SignalingMessage::ChatMessage {
                        from,
                        id,
                        content,
                        message_type,
                        sender_name,
                        timestamp,
                        ..
                    } => {
                        println!("[Pingo] Received chat message from {}", sender_name);

                        // Ensure the peer exists in users table
                        let _ = db.upsert_peer_as_user(from, sender_name, None);

                        // If we have a peer connection (UDP address) for this sender, expose it to the UI
                        if let Some(pc) = signaling.get_peer(&from) {
                            let ip = pc.address.ip().to_string();
                            let port = pc.address.port();

                            // Attempt to resolve any pending avatar metadata stored as filemeta:<id>:<port>
                            if let Ok(opt_user) = db.get_user(&from) {
                                if let Some(u) = opt_user {
                                    if let Some(avatar) = u.avatar_path {
                                        if avatar.starts_with("filemeta:") {
                                            // format: filemeta:<fileId>:<port>
                                            let parts: Vec<&str> = avatar.split(':').collect();
                                            if parts.len() >= 3 {
                                                let file_id = parts[1];
                                                let meta_port = parts[2]
                                                    .parse::<u16>()
                                                    .ok()
                                                    .filter(|p| *p != 0)
                                                    .unwrap_or(port);
                                                let url = format!(
                                                    "http://{}:{}/file/{}",
                                                    ip, meta_port, file_id
                                                );
                                                match db.set_user_avatar(&from, &url) {
                                                    Ok(_) => println!(
                                                        "[Pingo] Resolved avatar for {}",
                                                        from
                                                    ),
                                                    Err(e) => println!(
                                                        "[Pingo] Failed to resolve avatar: {}",
                                                        e
                                                    ),
                                                }
                                                let _ = app_clone.emit("peer-updated", serde_json::json!({ "device_id": from, "username": sender_name, "avatar_path": url }));
                                            }
                                        }
                                    }
                                }
                            }

                            let _ = app_clone.emit(
                                "peer-updated",
                                serde_json::json!({
                                    "device_id": from,
                                    "username": sender_name,
                                    "ip_address": ip,
                                    "port": port,
                                }),
                            );
                        }

                        let message = Message {
                            id: id.clone(),
                            sender_id: from.clone(),
                            receiver_id: local_device_id.clone(),
                            content: content.clone(),
                            message_type: message_type.clone(),
                            file_path: None,
                            is_read: false,
                            is_delivered: true,
                            created_at: timestamp.clone(),
                        };
                        match db.create_message(&message) {
                            Ok(_) => println!(
                                "[Pingo] Stored incoming message {}",
                                &id[..8.min(id.len())]
                            ),
                            Err(e) => println!("[Pingo] Failed to store message: {}", e),
                        }

                        // Notify frontend to load/display the message
                        let _ = app_clone.emit("chat-message-received", &message);

                        // Send delivery acknowledgement back to the sender so they can mark the
                        // message as delivered in their local DB/UI. This avoids marking delivery
                        // based purely on UDP send success.
                        let ack_msg = SignalingMessage::DeliveryAck {
                            from: local_device_id.clone(),
                            to: from.clone(),
                            message_id: id.clone(),
                        };
                        let _ = signaling.send_message(&from, &ack_msg);
                    }
                    SignalingMessage::ProfileUpdate {
                        from,
                        username,
                        avatar_url,
                        avatar_file_id,
                        avatar_file_port,
                        bio,
                        designation,
                        ..
                    } => {
                        println!("[Pingo] Received profile update from {}", from);
                        let _ = db.upsert_peer_as_user(from, username, None);

                        // Resolve avatar URL
                        let resolved_avatar: Option<String> = if let Some(url) = avatar_url {
                            match db.set_user_avatar(from, &url) {
                                Ok(_) => println!("[Pingo] Updated avatar for {}", from),
                                Err(e) => println!("[Pingo] Failed to set avatar: {}", e),
                            }
                            Some(url.clone())
                        } else if let Some(file_id) = avatar_file_id {
                            if let Some(pc) = signaling.get_peer(&from) {
                                let ip = pc.address.ip().to_string();
                                let port = avatar_file_port.unwrap_or(pc.address.port());
                                let url = format!("http://{}:{}/file/{}", ip, port, file_id);
                                match db.set_user_avatar(from, &url) {
                                    Ok(_) => println!("[Pingo] Set avatar (file) for {}", from),
                                    Err(e) => println!("[Pingo] Failed to set avatar: {}", e),
                                }
                                Some(url)
                            } else {
                                let placeholder = format!(
                                    "filemeta:{}:{}",
                                    file_id,
                                    avatar_file_port.unwrap_or(0)
                                );
                                match db.set_user_avatar(from, &placeholder) {
                                    Ok(_) => {
                                        println!("[Pingo] Stored avatar placeholder for {}", from)
                                    }
                                    Err(e) => println!(
                                        "[Pingo] Failed to store avatar placeholder: {}",
                                        e
                                    ),
                                }
                                Some(placeholder)
                            }
                        } else {
                            None
                        };

                        // CRITICAL: Emit as signaling-message so the JS ProfileUpdate handler
                        // processes it with correct semantics (authoritative profile change,
                        // not a presence update). This fixes username/avatar not reflecting.
                        let _ = app_clone.emit(
                            "signaling-message",
                            serde_json::json!({
                                "type": "ProfileUpdate",
                                "from": from,
                                "to": local_device_id,
                                "username": username,
                                "avatar_url": resolved_avatar,
                                "bio": bio,
                                "designation": designation,
                            }),
                        );
                    }
                    SignalingMessage::GroupCreated {
                        from,
                        id,
                        name,
                        member_ids,
                        member_names,
                        created_at,
                        ..
                    } => {
                        println!("[Pingo] Received group created from {} ({})", from, id);
                        // Create group locally and add members
                        let group = Group {
                            id: id.clone(),
                            name: name.clone(),
                            created_by: from.clone(),
                            avatar_color: None,
                            created_at: created_at.clone(),
                        };
                        match db.create_group(&group) {
                            Ok(_) => println!("[Pingo] Stored group {}", &id[..8.min(id.len())]),
                            Err(e) => println!("[Pingo] Failed to store group: {}", e),
                        }
                        for (i, uid) in member_ids.iter().enumerate() {
                            let uname = member_names.get(i).cloned().unwrap_or_default();
                            let role = if uid.as_str() == from.as_str() {
                                "admin".to_string()
                            } else {
                                "member".to_string()
                            };
                            let gm = GroupMember {
                                group_id: id.clone(),
                                user_id: uid.clone(),
                                username: uname,
                                role,
                                joined_at: now(),
                            };
                            match db.add_group_member(&gm) {
                                Ok(_) => {}
                                Err(e) => println!("[Pingo] Failed to add group member: {}", e),
                            }
                        }
                        let _ = app_clone.emit("group-created", &group);
                    }
                    SignalingMessage::GroupChatMessage {
                        from,
                        group_id,
                        id,
                        content,
                        message_type,
                        sender_name,
                        timestamp,
                        ..
                    } => {
                        println!(
                            "[Pingo] Received group chat message from {} in group {}",
                            sender_name,
                            &group_id[..8.min(group_id.len())]
                        );
                        // Ensure the peer exists in users table
                        let _ = db.upsert_peer_as_user(&from, &sender_name, None);
                        // Store as group message
                        let gmsg = GroupMessage {
                            id: id.clone(),
                            group_id: group_id.clone(),
                            sender_id: from.clone(),
                            sender_name: sender_name.clone(),
                            content: content.clone(),
                            message_type: message_type.clone(),
                            created_at: timestamp.clone(),
                        };
                        match db.send_group_message(&gmsg) {
                            Ok(_) => {
                                println!("[Pingo] Stored group message {}", &id[..8.min(id.len())])
                            }
                            Err(e) => println!("[Pingo] Failed to store group message: {}", e),
                        }
                        // Emit separate event for group messages
                        let _ = app_clone.emit("group-message-received", &gmsg);
                    }
                    SignalingMessage::MeetingChatMessage {
                        from,
                        session_id,
                        id,
                        content,
                        sender_name,
                        timestamp,
                        ..
                    } => {
                        println!(
                            "[Pingo] Received meeting chat from {} (session {})",
                            sender_name,
                            &session_id[..8.min(session_id.len())]
                        );
                        // Emit as separate event — NOT stored in DB
                        let _ = app_clone.emit("meeting-chat-received", serde_json::json!({
                            "from": from, "session_id": session_id, "id": id,
                            "content": content, "sender_name": sender_name, "timestamp": timestamp,
                        }));
                    }
                    SignalingMessage::GroupMemberAdded {
                        from,
                        group_id,
                        user_id,
                        username,
                        ..
                    } => {
                        println!(
                            "[Pingo] Group member added: {} to group {}",
                            username,
                            &group_id[..8.min(group_id.len())]
                        );
                        let gm = GroupMember {
                            group_id: group_id.clone(),
                            user_id: user_id.clone(),
                            username: username.clone(),
                            role: "member".to_string(),
                            joined_at: now(),
                        };
                        let _ = db.add_group_member(&gm);
                        let _ = app_clone.emit("group-member-added", serde_json::json!({
                            "from": from, "group_id": group_id, "user_id": user_id, "username": username,
                        }));
                    }
                    SignalingMessage::GroupMemberRemoved {
                        from,
                        group_id,
                        user_id,
                        ..
                    } => {
                        println!(
                            "[Pingo] Group member removed: {} from group {}",
                            user_id,
                            &group_id[..8.min(group_id.len())]
                        );
                        let _ = db.remove_group_member(&group_id, &user_id);
                        let _ = app_clone.emit(
                            "group-member-removed",
                            serde_json::json!({
                                "from": from, "group_id": group_id, "user_id": user_id,
                            }),
                        );
                    }
                    _ => {
                        let _ = app_clone.emit("signaling-message", &msg);
                    }
                },
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(actual_port)
}

#[tauri::command]
pub fn register_peer(
    state: State<AppState>,
    peer_id: String,
    ip: String,
    port: u16,
) -> Result<(), String> {
    state.signaling.register_peer(&peer_id, &ip, port)
}

#[tauri::command]
pub fn send_signaling_message(
    state: State<AppState>,
    peer_id: String,
    message: SignalingMessage,
) -> Result<(), String> {
    state.signaling.send_message(&peer_id, &message)
}

// ============ ENCRYPTION COMMANDS ============

#[tauri::command]
pub fn establish_session(
    state: State<AppState>,
    peer_id: String,
    peer_public_key: String,
) -> Result<(), String> {
    state.crypto.establish_session(&peer_id, &peer_public_key)
}

#[tauri::command]
pub fn encrypt_message(
    state: State<AppState>,
    peer_id: String,
    message: String,
) -> Result<EncryptedEnvelope, String> {
    state.crypto.encrypt_message(&peer_id, &message)
}

#[tauri::command]
pub fn decrypt_message(
    state: State<AppState>,
    peer_id: String,
    envelope: EncryptedEnvelope,
) -> Result<String, String> {
    state.crypto.decrypt_message(&peer_id, &envelope)
}

#[tauri::command]
pub fn get_public_key(state: State<AppState>) -> Option<String> {
    state.crypto.get_public_key()
}

// ============ FILE TRANSFER COMMANDS ============

#[tauri::command]
pub fn prepare_file_send(
    state: State<AppState>,
    file_path: String,
) -> Result<FileMetadata, String> {
    let transfer_id = generate_id();
    state
        .file_transfer
        .prepare_send(&PathBuf::from(file_path), &transfer_id)
}

#[tauri::command]
pub fn prepare_file_receive(
    state: State<AppState>,
    metadata: FileMetadata,
) -> Result<String, String> {
    let path = state.file_transfer.prepare_receive(&metadata)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_file_chunk(
    state: State<AppState>,
    transfer_id: String,
    chunk_index: u32,
) -> Result<FileChunk, String> {
    state.file_transfer.get_chunk(&transfer_id, chunk_index)
}

#[tauri::command]
pub fn receive_file_chunk(state: State<AppState>, chunk: FileChunk) -> Result<bool, String> {
    Ok(state.file_transfer.receive_chunk(&chunk)?.success)
}

#[tauri::command]
pub fn get_transfer_progress(
    state: State<AppState>,
    transfer_id: String,
) -> Option<TransferProgress> {
    state.file_transfer.get_progress(&transfer_id)
}

#[tauri::command]
pub fn get_missing_chunks(state: State<AppState>, transfer_id: String) -> Vec<u32> {
    state.file_transfer.get_missing_chunks(&transfer_id)
}

#[tauri::command]
pub fn complete_transfer(state: State<AppState>, transfer_id: String) -> Result<bool, String> {
    Ok(state.file_transfer.complete_transfer(&transfer_id)?.success)
}

#[tauri::command]
pub fn cancel_transfer(state: State<AppState>, transfer_id: String) -> Result<(), String> {
    state.file_transfer.cancel_transfer(&transfer_id)
}

// ============ SETTINGS COMMANDS ============

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    state
        .db
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    state.db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> Result<Vec<Settings>, String> {
    state.db.get_all_settings().map_err(|e| e.to_string())
}

// ============ NOTIFICATION / WINDOW COMMANDS ============

#[tauri::command]
pub fn toggle_notifications_mute() -> bool {
    tray::toggle_mute()
}

#[tauri::command]
pub fn is_notifications_muted() -> bool {
    tray::is_muted()
}

#[tauri::command]
pub fn minimize_to_tray<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============ UTILITY COMMANDS ============

#[tauri::command]
pub fn get_device_id(state: State<AppState>) -> String {
    state.device_id.clone()
}

#[tauri::command]
pub fn generate_uuid() -> String {
    generate_id()
}

#[tauri::command]
pub fn get_timestamp() -> String {
    now()
}

#[tauri::command]
pub fn get_downloads_dir(state: State<AppState>) -> String {
    state
        .file_transfer
        .get_downloads_dir()
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn upsert_peer_user(
    state: State<AppState>,
    device_id: String,
    username: String,
    public_key: Option<String>,
) -> Result<(), String> {
    state
        .db
        .upsert_peer_as_user(&device_id, &username, public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_window_visible<R: Runtime>(app: AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

#[tauri::command]
pub fn restart_discovery(
    state: State<AppState>,
    username: String,
    port: u16,
) -> Result<(), String> {
    state.discovery.stop();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let pk = state
        .crypto
        .get_public_key()
        .ok_or("Public key not initialized")?;
    state
        .discovery
        .start(state.device_id.clone(), username, port, pk)?;
    Ok(())
}

/// Relay a chat message via UDP signaling. Auto-registers peer from discovery if not found.
#[tauri::command]
pub fn relay_chat_message(
    state: State<AppState>,
    peer_id: String,
    message_id: String,
    content: String,
    message_type: Option<String>,
    sender_name: String,
) -> Result<(), String> {
    let signaling_msg = SignalingMessage::ChatMessage {
        from: state.device_id.clone(),
        to: peer_id.clone(),
        id: message_id,
        content,
        message_type: message_type.unwrap_or_else(|| "text".into()),
        sender_name,
        timestamp: now(),
    };

    // Try send; on Peer-not-found auto-register from discovery and retry
    match state.signaling.send_message(&peer_id, &signaling_msg) {
        Ok(()) => Ok(()),
        Err(ref e) if e.contains("not found") || e.contains("Not found") => {
            // Look up peer in discovery manager
            let peers = state.discovery.get_peers();
            if let Some(p) = peers.iter().find(|p| p.device_id == peer_id) {
                state
                    .signaling
                    .register_peer(&peer_id, &p.ip_address, p.port)?;
                state.signaling.send_message(&peer_id, &signaling_msg)
            } else {
                Err(format!(
                    "Peer {} not found in signaling or discovery",
                    peer_id
                ))
            }
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn save_avatar(state: State<AppState>, image_data: String) -> Result<String, String> {
    let mut user = state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())?
        .ok_or("User not found")?;
    user.avatar_path = Some(image_data.clone());
    state.db.create_user(&user).map_err(|e| e.to_string())?;
    Ok(image_data)
}

/// Download an avatar from remote URL and cache locally in Documents/Pingo/avatars/
/// Returns the local file:// URL for persistent rendering
///
/// Desktop-grade avatar management:
/// - Fixes "avatar disappears" bug by storing avatars locally
/// - Prevents presence updates from overwriting profile data
/// - Enables offline rendering from local filesystem
#[tauri::command]
pub fn download_and_cache_avatar(
    state: State<AppState>,
    device_id: String,
    remote_url: String,
    _hint_name: Option<String>,
) -> Result<String, String> {
    if device_id.is_empty() || remote_url.is_empty() {
        return Err("device_id and remote_url required".to_string());
    }

    // Create avatars directory: Documents/Pingo/avatars/
    // Uses standard Windows/Mac/Linux locations
    let avatars_path = if cfg!(target_os = "windows") {
        let docs = std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Documents"))
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        docs.join("Pingo").join("avatars")
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home).join("Documents/Pingo/avatars")
    } else {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home).join(".local/share/Pingo/avatars")
    };

    std::fs::create_dir_all(&avatars_path)
        .map_err(|e| format!("Failed to create avatars dir: {}", e))?;

    // Generate stable filename: user_<device_id>.png
    // This ensures same device_id always overwrites same file (safe update when avatar changes)
    let filename = format!("user_{}.png", device_id);
    let file_path = avatars_path.join(&filename);

    // Check if this is a local file server URL (e.g., from previous app run with different port)
    // If so, and the file exists, just register it instead of re-downloading
    if remote_url.starts_with("http://127.0.0.1:") || remote_url.starts_with("http://localhost:") {
        if file_path.exists() {
            // File exists locally, just register it with the file server
            let file_id = format!("avatar_{}", device_id);
            state
                .file_server
                .register_file(&file_id, &file_path, &filename);
            let port = state.file_server.get_port();
            let file_url = format!("http://127.0.0.1:{}/file/{}", port, file_id);
            return Ok(file_url);
        }
    }

    // Download from remote HTTP server
    let bytes = http_get_bytes(&remote_url)?;
    if bytes.is_empty() {
        return Err("Downloaded empty avatar".to_string());
    }

    // Write to local file (overwrites if exists — required for avatar updates)
    std::fs::write(&file_path, bytes).map_err(|e| format!("Failed to write avatar: {}", e))?;

    // Register avatar with local file server and return an HTTP URL the UI can load (127.0.0.1)
    let file_id = format!("avatar_{}", device_id);
    state
        .file_server
        .register_file(&file_id, &file_path, &filename);
    let port = state.file_server.get_port();
    let file_url = format!("http://127.0.0.1:{}/file/{}", port, file_id);

    // Update database to store local file server URL instead of a file:// URL
    match state.db.set_user_avatar(&device_id, &file_url) {
        Ok(_) => println!(
            "[Pingo] Cached avatar for {} at {} (served as {})",
            device_id,
            file_path.display(),
            file_url
        ),
        Err(e) => println!("[Pingo] Warning: failed to update avatar in DB: {}", e),
    }

    Ok(file_url)
}

/// Register an existing local avatar file with file server and return its local HTTP URL
#[tauri::command]
pub fn register_local_avatar(
    state: State<AppState>,
    device_id: String,
    file_path: String,
) -> Result<String, String> {
    // Strip file:// prefix if present
    let mut path_str = file_path.clone();
    if path_str.starts_with("file:///") {
        path_str = path_str.trim_start_matches("file:///").to_string();
    } else if path_str.starts_with("file://") {
        path_str = path_str.trim_start_matches("file://").to_string();
    }

    let path_buf = std::path::PathBuf::from(path_str);
    if !path_buf.exists() {
        return Err(format!("Avatar file not found: {}", file_path));
    }

    let filename = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("user_{}.png", device_id));

    // Register file under stable id
    let file_id = format!("avatar_{}", device_id);
    state
        .file_server
        .register_file(&file_id, &path_buf, &filename);
    let port = state.file_server.get_port();
    let local_url = format!("http://127.0.0.1:{}/file/{}", port, file_id);

    // Persist the new URL in DB
    match state.db.set_user_avatar(&device_id, &local_url) {
        Ok(_) => println!(
            "[Pingo] Registered local avatar for {} as {}",
            device_id, local_url
        ),
        Err(e) => println!("[Pingo] Warning: failed to update avatar in DB: {}", e),
    }

    Ok(local_url)
}

#[tauri::command]
pub fn get_shared_media(
    state: State<AppState>,
    peer_id: String,
    media_type: Option<String>,
) -> Result<Vec<Message>, String> {
    state
        .db
        .get_shared_media(&state.device_id, &peer_id, media_type.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_users_with_messages(state: State<AppState>) -> Result<Vec<User>, String> {
    state
        .db
        .get_users_with_messages(&state.device_id)
        .map_err(|e| e.to_string())
}

// ============ NOTES COMMANDS ============

#[derive(Deserialize)]
pub struct SaveNoteInput {
    pub id: String,
    pub title: String,
    pub content: Option<String>,
    pub color: Option<String>,
    pub pinned: Option<bool>,
    pub category: Option<String>,
    pub created_at: Option<String>,
}

#[tauri::command]
pub fn save_note(state: State<AppState>, input: SaveNoteInput) -> Result<Note, String> {
    let ts = now();
    let note = Note {
        id: input.id,
        title: input.title,
        content: input.content.unwrap_or_default(),
        color: input.color.unwrap_or_else(|| "#fef3c7".into()),
        pinned: input.pinned.unwrap_or(false),
        category: input.category,
        created_at: input.created_at.unwrap_or_else(|| ts.clone()),
        updated_at: ts,
    };
    state.db.save_note(&note).map_err(|e| e.to_string())?;
    Ok(note)
}

#[tauri::command]
pub fn get_all_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    state.db.get_all_notes().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_note(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_note_pin(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.toggle_note_pin(&id).map_err(|e| e.to_string())
}

// ============ GROUP COMMANDS ============

#[derive(Deserialize)]
pub struct CreateGroupInput {
    pub name: String,
    pub member_ids: Vec<String>,
    pub member_names: Vec<String>,
}

#[tauri::command]
pub fn create_group(state: State<AppState>, input: CreateGroupInput) -> Result<Group, String> {
    let group = Group {
        id: generate_id(),
        name: input.name,
        created_by: state.device_id.clone(),
        avatar_color: Some("#4f46e5".into()),
        created_at: now(),
    };
    state.db.create_group(&group).map_err(|e| e.to_string())?;

    // Add creator as admin
    let local_user = state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())?
        .unwrap();
    state
        .db
        .add_group_member(&GroupMember {
            group_id: group.id.clone(),
            user_id: state.device_id.clone(),
            username: local_user.username.clone(),
            role: "admin".into(),
            joined_at: now(),
        })
        .map_err(|e| e.to_string())?;

    // Add other members
    for (uid, uname) in input.member_ids.iter().zip(input.member_names.iter()) {
        state
            .db
            .add_group_member(&GroupMember {
                group_id: group.id.clone(),
                user_id: uid.clone(),
                username: uname.clone(),
                role: "member".into(),
                joined_at: now(),
            })
            .map_err(|e| e.to_string())?;
    }

    // Build full member list including creator for the notification
    let mut all_member_ids = vec![state.device_id.clone()];
    all_member_ids.extend(input.member_ids.iter().cloned());
    let mut all_member_names = vec![local_user.username.clone()];
    all_member_names.extend(input.member_names.iter().cloned());

    // Notify members (send signaling message) so other peers create the group locally
    for uid in input.member_ids.iter() {
        if uid != &state.device_id {
            let signaling_msg = SignalingMessage::GroupCreated {
                from: state.device_id.clone(),
                to: uid.clone(),
                id: group.id.clone(),
                name: group.name.clone(),
                member_ids: all_member_ids.clone(),
                member_names: all_member_names.clone(),
                created_at: group.created_at.clone(),
            };
            // Try sending; auto-register from discovery on failure
            match state.signaling.send_message(&uid, &signaling_msg) {
                Ok(()) => {}
                Err(ref e) if e.contains("not found") || e.contains("Not found") => {
                    if let Some(p) = state
                        .discovery
                        .get_peers()
                        .iter()
                        .find(|p| p.device_id == *uid)
                    {
                        let _ = state.signaling.register_peer(&uid, &p.ip_address, p.port);
                        let _ = state.signaling.send_message(&uid, &signaling_msg);
                    }
                }
                Err(_) => {}
            }
        }
    }

    Ok(group)
}

#[tauri::command]
pub fn get_groups(state: State<AppState>) -> Result<Vec<Group>, String> {
    state
        .db
        .get_groups(&state.device_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_group_members(
    state: State<AppState>,
    group_id: String,
) -> Result<Vec<GroupMember>, String> {
    state
        .db
        .get_group_members(&group_id)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct SendGroupMsgInput {
    pub group_id: String,
    pub content: String,
    pub message_type: Option<String>,
}

#[tauri::command]
pub fn send_group_message(
    state: State<AppState>,
    input: SendGroupMsgInput,
) -> Result<GroupMessage, String> {
    let local_user = state
        .db
        .get_user(&state.device_id)
        .map_err(|e| e.to_string())?
        .unwrap();
    let msg = GroupMessage {
        id: generate_id(),
        group_id: input.group_id.clone(),
        sender_id: state.device_id.clone(),
        sender_name: local_user.username,
        content: input.content,
        message_type: input.message_type.unwrap_or_else(|| "text".into()),
        created_at: now(),
    };
    state
        .db
        .send_group_message(&msg)
        .map_err(|e| e.to_string())?;

    // Relay to group members via signaling (with auto-discovery fallback)
    if let Ok(members) = state.db.get_group_members(&input.group_id) {
        for m in members {
            if m.user_id != state.device_id {
                let signaling_msg = SignalingMessage::GroupChatMessage {
                    from: state.device_id.clone(),
                    to: m.user_id.clone(),
                    group_id: msg.group_id.clone(),
                    id: msg.id.clone(),
                    content: msg.content.clone(),
                    message_type: msg.message_type.clone(),
                    sender_name: msg.sender_name.clone(),
                    timestamp: msg.created_at.clone(),
                };
                match state.signaling.send_message(&m.user_id, &signaling_msg) {
                    Ok(()) => {}
                    Err(ref e) if e.contains("not found") || e.contains("Not found") => {
                        // Auto-register from discovery and retry
                        if let Some(p) = state
                            .discovery
                            .get_peers()
                            .iter()
                            .find(|p| p.device_id == m.user_id)
                        {
                            let _ =
                                state
                                    .signaling
                                    .register_peer(&m.user_id, &p.ip_address, p.port);
                            let _ = state.signaling.send_message(&m.user_id, &signaling_msg);
                        }
                    }
                    Err(_) => {}
                }
            }
        }
    }
    Ok(msg)
}

#[tauri::command]
pub fn get_group_messages(
    state: State<AppState>,
    group_id: String,
    limit: Option<i32>,
) -> Result<Vec<GroupMessage>, String> {
    state
        .db
        .get_group_messages(&group_id, limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_group(state: State<AppState>, group_id: String) -> Result<(), String> {
    state.db.delete_group(&group_id).map_err(|e| e.to_string())
}

// ============ FILE SERVER COMMANDS ============

#[tauri::command]
pub fn store_shared_file(
    state: State<AppState>,
    file_id: String,
    data_url: String,
    file_name: String,
) -> Result<String, String> {
    state
        .file_server
        .store_data_url(&file_id, &data_url, &file_name)?;
    let port = state.file_server.get_port();
    Ok(format!("http://{{IP}}:{}/file/{}", port, file_id))
}

#[tauri::command]
pub fn get_file_server_port(state: State<AppState>) -> u16 {
    state.file_server.get_port()
}

/// Read a file directly from disk and return as base64 data URL
/// This bypasses the HTTP file server entirely for faster, direct file access
#[tauri::command]
pub fn read_file_as_data_url(file_id: String) -> Result<String, String> {
    let storage_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Pingo")
        .join("shared_files");

    // Find file matching the ID prefix
    if let Ok(entries) = std::fs::read_dir(&storage_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with(&file_id) {
                let path = entry.path();
                if let Ok(data) = std::fs::read(&path) {
                    // Determine MIME type from file extension
                    let ext = path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_else(|| "bin".to_string())
                        .to_lowercase();

                    let mime_type = match ext.as_str() {
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
                        "mp4" => "video/mp4",
                        "webm" => "video/webm",
                        _ => "application/octet-stream",
                    };

                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    return Ok(format!("data:{};base64,{}", mime_type, b64));
                }
            }
        }
    }

    Err(format!("File not found: {}", file_id))
}

#[tauri::command]
pub fn delete_message(state: State<AppState>, message_id: String) -> Result<(), String> {
    state
        .db
        .delete_message(&message_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_all_messages_with_peer(
    state: State<AppState>,
    peer_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_all_messages_with_peer(&state.device_id, &peer_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_user<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    user_id: String,
) -> Result<(), String> {
    // Prevent accidental deletion of local user
    if user_id == state.device_id {
        return Err("Cannot delete the local user".into());
    }
    // Remove messages related to this peer for the current local user
    state
        .db
        .delete_all_messages_with_peer(&state.device_id, &user_id)
        .map_err(|e| e.to_string())?;
    // Delete user from users table
    state.db.delete_user(&user_id).map_err(|e| e.to_string())?;

    // Notify UI that a user was deleted so views can refresh
    let _ = app.emit("user-deleted", serde_json::json!({ "user_id": user_id }));

    Ok(())
}

// ============ GROUP MANAGEMENT COMMANDS ============

#[tauri::command]
pub fn add_group_member(
    state: State<AppState>,
    group_id: String,
    user_id: String,
    username: String,
) -> Result<(), String> {
    state
        .db
        .add_group_member(&GroupMember {
            group_id: group_id.clone(),
            user_id: user_id.clone(),
            username: username.clone(),
            role: "member".into(),
            joined_at: now(),
        })
        .map_err(|e| e.to_string())?;

    // Notify the newly-added member about the group so their client will create the group locally
    if let Ok(groups) = state.db.get_groups(&state.device_id) {
        if let Some(g) = groups.into_iter().find(|gg| gg.id == group_id) {
            let member_rows = state.db.get_group_members(&g.id).unwrap_or_default();
            let member_ids: Vec<String> = member_rows.iter().map(|m| m.user_id.clone()).collect();
            let member_names: Vec<String> =
                member_rows.iter().map(|m| m.username.clone()).collect();
            let signaling_msg = SignalingMessage::GroupCreated {
                from: state.device_id.clone(),
                to: user_id.clone(),
                id: g.id.clone(),
                name: g.name.clone(),
                member_ids: member_ids.clone(),
                member_names: member_names.clone(),
                created_at: g.created_at.clone(),
            };
            match state.signaling.send_message(&user_id, &signaling_msg) {
                Ok(()) => {}
                Err(ref e) if e.contains("not found") || e.contains("Not found") => {
                    if let Some(p) = state
                        .discovery
                        .get_peers()
                        .iter()
                        .find(|pp| pp.device_id == user_id)
                    {
                        let _ = state
                            .signaling
                            .register_peer(&user_id, &p.ip_address, p.port);
                        let _ = state.signaling.send_message(&user_id, &signaling_msg);
                    }
                }
                Err(_) => {}
            }

            // Notify existing members about the new addition
            for mid in &member_ids {
                if mid != &state.device_id && mid != &user_id {
                    let notify_msg = SignalingMessage::GroupMemberAdded {
                        from: state.device_id.clone(),
                        to: mid.clone(),
                        group_id: group_id.clone(),
                        user_id: user_id.clone(),
                        username: username.clone(),
                    };
                    let _ = state.signaling.send_message(mid, &notify_msg);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn remove_group_member(
    state: State<AppState>,
    group_id: String,
    user_id: String,
) -> Result<(), String> {
    // Get members before removal for notification
    let members_before = state.db.get_group_members(&group_id).unwrap_or_default();
    state
        .db
        .remove_group_member(&group_id, &user_id)
        .map_err(|e| e.to_string())?;

    // Notify all remaining members about the removal
    for m in &members_before {
        if m.user_id != state.device_id && m.user_id != user_id {
            let notify_msg = SignalingMessage::GroupMemberRemoved {
                from: state.device_id.clone(),
                to: m.user_id.clone(),
                group_id: group_id.clone(),
                user_id: user_id.clone(),
            };
            let _ = state.signaling.send_message(&m.user_id, &notify_msg);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn leave_group(state: State<AppState>, group_id: String) -> Result<(), String> {
    state
        .db
        .remove_group_member(&group_id, &state.device_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_users_for_group(state: State<AppState>) -> Result<Vec<User>, String> {
    state.db.get_all_users().map_err(|e| e.to_string())
}

// ============ FILE DOWNLOAD & MANAGEMENT COMMANDS ============

/// Utility function to download bytes from HTTP URL
fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::new();
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("HTTP request failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}: {}", response.status(), url));
    }
    response
        .bytes()
        .map(|b| b.to_vec())
        .map_err(|e| format!("Read response: {}", e))
}

fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn ext_from_filename(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or("bin")
}

/// Auto-download a file from sender's HTTP file server and save locally
/// Emits "file-download-progress" events: { file_id, file_name, stage, progress }
/// stages: "downloading" (0..99), "saving" (99), "complete" (100)
#[tauri::command]
pub fn auto_download_file<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    url: String,
    sender_name: String,
    file_name: String,
    file_type: String,
    message_id: Option<String>,
) -> Result<String, String> {
    // Extract fileId from URL (last path segment)
    let file_id = url.rsplit('/').next().unwrap_or("unknown").to_string();

    // Emit "downloading" progress
    let _ = app.emit(
        "file-download-progress",
        serde_json::json!({
            "fileId": file_id,
            "fileName": file_name,
            "stage": "downloading",
            "progress": 0
        }),
    );

    // Check if already in shared_files (file server can already serve it)
    let shared_dir = state.file_server.get_storage_dir();
    let ext = ext_from_filename(&file_name);
    let shared_path = shared_dir.join(format!("{}.{}", file_id, ext));

    let bytes = if shared_path.exists() {
        // Already downloaded — skip network fetch
        let _ = app.emit(
            "file-download-progress",
            serde_json::json!({
                "fileId": file_id,
                "fileName": file_name,
                "stage": "cached",
                "progress": 100
            }),
        );
        std::fs::read(&shared_path).map_err(|e| e.to_string())?
    } else {
        // Download from sender's file server
        let downloaded = http_get_bytes(&url)?;
        if downloaded.is_empty() {
            let _ = app.emit(
                "file-download-progress",
                serde_json::json!({
                    "fileId": file_id,
                    "fileName": file_name,
                    "stage": "error",
                    "progress": 0
                }),
            );
            return Err("Downloaded empty file".to_string());
        }
        let _ = app.emit(
            "file-download-progress",
            serde_json::json!({
                "fileId": file_id,
                "fileName": file_name,
                "stage": "saving",
                "progress": 80
            }),
        );
        std::fs::create_dir_all(&shared_dir).ok();
        std::fs::write(&shared_path, &downloaded)
            .map_err(|e| format!("Write shared file: {}", e))?;
        // Register in file server for local serving
        state
            .file_server
            .register_file(&file_id, &shared_path, &file_name);
        downloaded
    };

    // Also save to organized downloads: Pingo/Downloads/<sender_name>/<type>/<file_name>
    let type_folder = match file_type.as_str() {
        "image" => "images",
        "video" => "videos",
        _ => "files",
    };
    let downloads_base = state.file_transfer.get_downloads_dir();
    let user_folder = downloads_base
        .join(sanitize_folder_name(&sender_name))
        .join(type_folder);
    std::fs::create_dir_all(&user_folder).map_err(|e| e.to_string())?;

    let organized_path = user_folder.join(&file_name);
    if !organized_path.exists() {
        std::fs::write(&organized_path, &bytes).map_err(|e| format!("Write organized: {}", e))?;
    }

    // Update message file_path in DB
    if let Some(mid) = message_id {
        let _ = state
            .db
            .update_message_file_path(&mid, &organized_path.to_string_lossy());
    }

    // Emit "complete" — includes the local path so the front-end can immediately display
    let _ = app.emit(
        "file-download-progress",
        serde_json::json!({
            "fileId": file_id,
            "fileName": file_name,
            "stage": "complete",
            "progress": 100,
            "localPath": organized_path.to_string_lossy()
        }),
    );

    Ok(organized_path.to_string_lossy().to_string())
}

/// Open file location in system file explorer
#[tauri::command]
pub fn open_file_location(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        // /select,<path> must be a SINGLE argument for explorer.exe
        // Also normalise forward slashes to back slashes so explorer can parse the path
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", win_path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(&["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = p.parent().unwrap_or(std::path::Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Save a file from URL with a native save dialog (Windows PowerShell)
#[tauri::command]
pub fn save_file_with_dialog(url: String, default_name: String) -> Result<Option<String>, String> {
    let save_path = show_save_dialog(&default_name);
    if let Some(ref path) = save_path {
        let bytes = http_get_bytes(&url)?;
        std::fs::write(path, &bytes).map_err(|e| format!("Write failed: {}", e))?;
    }
    Ok(save_path)
}

#[cfg(target_os = "windows")]
fn show_save_dialog(default_name: &str) -> Option<String> {
    let escaped = default_name.replace('\'', "''");
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.FileName = '{}'; $d.Filter = 'All files (*.*)|*.*'; if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.FileName }}"#,
        escaped
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(target_os = "windows"))]
fn show_save_dialog(_default_name: &str) -> Option<String> {
    None
}

/// Rename a user's download folder (when they change username)
#[tauri::command]
pub fn rename_user_download_folder(
    state: State<AppState>,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let base = state.file_transfer.get_downloads_dir();
    let old_path = base.join(sanitize_folder_name(&old_name));
    let new_path = base.join(sanitize_folder_name(&new_name));
    if old_path.exists() && !new_path.exists() {
        std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
        println!(
            "[Pingo] Renamed download folder: {:?} -> {:?}",
            old_path, new_path
        );
    }
    Ok(())
}

/// Get the base Pingo downloads directory
#[tauri::command]
pub fn get_pingo_downloads_base(state: State<AppState>) -> String {
    state
        .file_transfer
        .get_downloads_dir()
        .to_string_lossy()
        .to_string()
}

/// Check if a file has been auto-downloaded locally
/// Checks both organized downloads AND shared_files dir (for sender's own files)
#[tauri::command]
pub fn check_file_downloaded(
    state: State<AppState>,
    sender_name: String,
    file_name: String,
    file_type: String,
) -> Option<String> {
    let type_folder = match file_type.as_str() {
        "image" => "images",
        "video" => "videos",
        _ => "files",
    };
    let base = state.file_transfer.get_downloads_dir();
    let path = base
        .join(sanitize_folder_name(&sender_name))
        .join(type_folder)
        .join(&file_name);
    if path.exists() {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

/// Find the local path of a shared file by its file_id (for sender's own uploaded files)
#[tauri::command]
pub fn get_shared_file_path(state: State<AppState>, file_id: String) -> Option<String> {
    let shared_dir = state.file_server.get_storage_dir();
    if let Ok(entries) = std::fs::read_dir(&shared_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            // File names are stored as "<fileId>.<ext>"
            if fname.starts_with(&file_id) {
                return Some(entry.path().to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Get the local file server URL for a given file ID (uses 127.0.0.1)
#[tauri::command]
pub fn get_local_file_url(state: State<AppState>, file_id: String) -> Option<String> {
    let port = state.file_server.get_port();
    if port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{}/file/{}", port, file_id))
}

// ============ STORAGE STATS COMMANDS ============

#[derive(Serialize)]
pub struct StorageStats {
    pub db_path: String,
    pub db_size: u64,
    pub shared_files_path: String,
    pub shared_files_size: u64,
    pub downloads_path: String,
    pub downloads_size: u64,
    pub total_size: u64,
}

fn dir_size(path: &std::path::Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut total: u64 = 0;
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else {
                total += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

#[tauri::command]
pub fn get_storage_stats(state: State<AppState>) -> StorageStats {
    let db_path = Database::get_db_path();
    let db_size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    let shared_files_path = state.file_server.get_storage_dir();
    let shared_files_size = dir_size(&shared_files_path);

    let downloads_path = state.file_transfer.get_downloads_dir();
    let downloads_size = dir_size(&downloads_path);

    let total_size = db_size + shared_files_size + downloads_size;

    StorageStats {
        db_path: db_path.to_string_lossy().to_string(),
        db_size,
        shared_files_path: shared_files_path.to_string_lossy().to_string(),
        shared_files_size,
        downloads_path: downloads_path.to_string_lossy().to_string(),
        downloads_size,
        total_size,
    }
}
