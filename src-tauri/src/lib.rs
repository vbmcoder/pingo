// src-tauri/src/lib.rs
// Pingo - P2P Desktop Messaging Application
// Main library entry point

mod commands;
mod crypto;
mod db;
mod discovery;
mod file_server;
mod file_transfer;
mod screen_capture;
mod signaling;
mod tray;

use commands::AppState;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Core plugins
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // App setup
        .setup(|app| {
            // Initialize app state
            let state = AppState::new()
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            app.manage(state);

            // Initialize system tray (must happen before window setup)
            let handle = app.handle().clone();
            if let Err(e) = tray::init_tray(&handle) {
                // Tray initialization failure should not abort app startup in dev/hot-reload
                println!("[Pingo] Warning: failed to initialize tray: {}", e);
            }

            // Set up window close behavior (minimize to tray instead of closing)
            // In dev/hot-reload situations the "main" window may not be available during setup.
            // Be tolerant and skip the close handler if the window is absent instead of failing setup.
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Prevent close and hide window instead to keep app running in background
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            } else {
                println!("[Pingo] Warning: main window not available during setup; skipping close-handler registration");
            }

            // Log initialization
            println!("Pingo initialized successfully");
            println!("Database path: {:?}", db::Database::get_db_path());

            Ok(())
        })
        // Register all IPC commands
        .invoke_handler(tauri::generate_handler![
            // Initialization
            commands::init_app,
            // User commands
            commands::create_user,
            commands::get_user,
            commands::get_all_users,
            commands::get_local_user,
            // Message commands
            commands::send_message,
            commands::get_messages,
            commands::mark_message_read,
            commands::get_unread_count,
            commands::get_messages_paginated,
            commands::get_new_messages_since,
            commands::mark_messages_read_from_peer,
            commands::get_last_messages,
            // Discovery commands
            commands::start_discovery,
            commands::stop_discovery,
            commands::get_peers,
            commands::get_online_peers,
            // Signaling commands
            commands::start_signaling,
            commands::register_peer,
            commands::send_signaling_message,
            // Encryption commands
            commands::establish_session,
            commands::encrypt_message,
            commands::decrypt_message,
            commands::get_public_key,
            // File transfer commands
            commands::prepare_file_send,
            commands::prepare_file_receive,
            commands::get_file_chunk,
            commands::receive_file_chunk,
            commands::get_transfer_progress,
            commands::get_missing_chunks,
            commands::complete_transfer,
            commands::cancel_transfer,
            // Settings commands
            commands::set_setting,
            commands::get_setting,
            commands::get_all_settings,
            // Notification commands
            commands::toggle_notifications_mute,
            commands::is_notifications_muted,
            // Window commands
            commands::minimize_to_tray,
            commands::show_window,
            // Utility commands
            commands::get_device_id,
            commands::generate_uuid,
            commands::get_timestamp,
            commands::get_downloads_dir,
            commands::upsert_peer_user,
            commands::get_unread_count_from_peer,
            commands::is_window_visible,
            commands::restart_discovery,
            commands::relay_chat_message,
            commands::save_avatar,
            commands::get_shared_media,
            commands::get_users_with_messages,
            // Offline delivery commands
            commands::mark_message_delivered,
            commands::get_undelivered_messages_for_peer,
            // Notes commands
            commands::save_note,
            commands::get_all_notes,
            commands::delete_note,
            commands::toggle_note_pin,
            // Group commands
            commands::create_group,
            commands::get_groups,
            commands::get_group_members,
            commands::send_group_message,
            commands::get_group_messages,
            commands::delete_group,
            // File server commands
            commands::store_shared_file,
            commands::get_file_server_port,
            commands::read_file_as_data_url,
            // Message deletion commands
            commands::delete_message,
            commands::delete_all_messages_with_peer,
            commands::delete_user,
            // Group management commands
            commands::add_group_member,
            commands::remove_group_member,
            commands::leave_group,
            commands::get_all_users_for_group,
            // File download & management commands
            commands::auto_download_file,
            commands::open_file_location,
            commands::save_file_with_dialog,
            commands::rename_user_download_folder,
            commands::get_pingo_downloads_base,
            commands::check_file_downloaded,
            commands::get_local_file_url,
            commands::get_shared_file_path,
            // Avatar caching command — download remote avatar and save locally
            commands::download_and_cache_avatar,
            // Register existing local avatar files with file server
            commands::register_local_avatar,
            commands::get_storage_stats,
            // Screen capture commands
            screen_capture::capture_screen_primary,
            screen_capture::capture_screen,
            screen_capture::list_displays,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod integration_tests {
    use crate::commands::AppState;
    use crate::crypto::CryptoManager;
    use crate::db::Database;
    use crate::discovery::DiscoveryManager;
    use crate::file_server::FileServer;
    use crate::file_transfer::FileTransferManager;
    use crate::signaling::SignalingServer;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_full_backend_simulation() {
        println!("Starting Full Backend Simulation...");

        // Setup State A
        let db_a = Arc::new(Database::new_in_memory().unwrap());
        let disc_a = Arc::new(DiscoveryManager::new());
        let crypto_a = Arc::new(CryptoManager::new());
        let sig_a = Arc::new(SignalingServer::new("device_a".to_string()));
        let ft_a = Arc::new(FileTransferManager::new());
        let fs_a = Arc::new(FileServer::new());

        let state_a = AppState {
            db: db_a,
            discovery: disc_a,
            crypto: crypto_a,
            signaling: sig_a,
            file_transfer: ft_a,
            file_server: fs_a,
            device_id: "device_a".to_string(),
        };

        // Setup State B
        let db_b = Arc::new(Database::new_in_memory().unwrap());
        let disc_b = Arc::new(DiscoveryManager::new());
        let crypto_b = Arc::new(CryptoManager::new());
        let sig_b = Arc::new(SignalingServer::new("device_b".to_string()));
        let ft_b = Arc::new(FileTransferManager::new());
        let fs_b = Arc::new(FileServer::new());

        let state_b = AppState {
            db: db_b,
            discovery: disc_b,
            crypto: crypto_b,
            signaling: sig_b,
            file_transfer: ft_b,
            file_server: fs_b,
            device_id: "device_b".to_string(),
        };

        println!("1. Initializing Crypto Keys...");
        let pub_key_a = state_a.crypto.generate_keypair();
        let pub_key_b = state_b.crypto.generate_keypair();

        println!("2. Starting Discovery (A on 1420, B on 1421)...");
        state_a
            .discovery
            .start(
                state_a.device_id.clone(),
                "User A".to_string(),
                1420,
                pub_key_a.clone(),
            )
            .unwrap();
        state_b
            .discovery
            .start(
                state_b.device_id.clone(),
                "User B".to_string(),
                1421,
                pub_key_b.clone(),
            )
            .unwrap();

        // Wait for discovery (give it a few seconds for UDP packets to fly)
        println!("   Waiting 3s for UDP broadcast...");
        thread::sleep(Duration::from_secs(3));

        println!("3. Verifying Discovery Results...");
        let peers_a = state_a.discovery.get_peers();
        let peers_b = state_b.discovery.get_peers();

        println!("   Peers A found: {:?}", peers_a);
        println!("   Peers B found: {:?}", peers_b);

        let b_in_a = peers_a.iter().find(|p| p.device_id == "device_b");
        let a_in_b = peers_b.iter().find(|p| p.device_id == "device_a");

        assert!(b_in_a.is_some(), "User A should find User B");
        assert!(a_in_b.is_some(), "User B should find User A");

        let peer_b_info = b_in_a.unwrap();
        assert_eq!(peer_b_info.username, "User B");
        assert_eq!(peer_b_info.port, 1421);

        println!("4. Verifying Encryption Flow...");
        // A wants to send message to B
        // First, establish session (normally happens when clicking on chat)
        state_a
            .crypto
            .establish_session("device_b", &pub_key_b)
            .expect("A failed to establish session with B");
        state_b
            .crypto
            .establish_session("device_a", &pub_key_a)
            .expect("B failed to establish session with A");

        // A encrypts message
        let msg_content = "Hello User B, this is a secret!";
        let envelope = state_a
            .crypto
            .encrypt_message("device_b", msg_content)
            .expect("Encryption failed");

        println!("   Encrypted message: {:?}", envelope.ciphertext);

        // (Simulate Network Transfer of envelope)

        // B decrypts message
        let decrypted = state_b
            .crypto
            .decrypt_message("device_a", &envelope)
            .expect("Decryption failed");
        println!("   Decrypted message: {}", decrypted);

        assert_eq!(
            decrypted, msg_content,
            "Decrypted message should match original"
        );

        println!("5. Verifying Database Storage...");

        // Create users in DB first (foreign key constraint)
        let user_a = crate::db::User {
            id: "device_a".to_string(),
            username: "User A".to_string(),
            device_id: "device_a".to_string(),
            public_key: Some(pub_key_a.clone()),
            avatar_path: None,
            bio: None,
            designation: None,
            last_seen: Some(crate::db::now()),
            is_online: true,
            created_at: crate::db::now(),
        };
        state_a.db.create_user(&user_a).unwrap();

        let user_b = crate::db::User {
            id: "device_b".to_string(),
            username: "User B".to_string(),
            device_id: "device_b".to_string(),
            public_key: Some(pub_key_b.clone()),
            avatar_path: None,
            bio: None,
            designation: None,
            last_seen: Some(crate::db::now()),
            is_online: true,
            created_at: crate::db::now(),
        };
        state_a.db.create_user(&user_b).unwrap();

        // A stores the sent message
        let msg_obj = crate::db::Message {
            id: "msg_1".to_string(),
            sender_id: "device_a".to_string(),
            receiver_id: "device_b".to_string(),
            content: msg_content.to_string(),
            message_type: "text".to_string(),
            file_path: None,
            is_read: true,
            is_delivered: true,
            created_at: crate::db::now(),
        };
        state_a.db.create_message(&msg_obj).unwrap();

        let saved_msgs = state_a
            .db
            .get_messages_between("device_a", "device_b", 10)
            .unwrap();
        assert_eq!(saved_msgs.len(), 1);
        assert_eq!(saved_msgs[0].content, msg_content);

        println!("   Message stored successfully.");

        // Cleanup
        state_a.discovery.stop();
        state_b.discovery.stop();

        println!("Simulation Complete. All systems operational.");
    }
}
