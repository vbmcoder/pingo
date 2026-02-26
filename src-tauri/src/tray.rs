// src-tauri/src/tray.rs
// System Tray handling for Pingo

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

// Global state for notification mute
pub static NOTIFICATIONS_MUTED: AtomicBool = AtomicBool::new(false);

/// Initialize the system tray with menu items
pub fn init_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Create menu items
    let open_item = MenuItem::with_id(app, "open", "Open Pingo", true, None::<&str>)?;
    let mute_item = MenuItem::with_id(app, "mute", "Mute Notifications", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;

    // Build menu
    let menu = Menu::with_items(app, &[&open_item, &mute_item, &separator, &exit_item])?;

    // Build tray icon - keep it alive by assigning to a name without underscore
    let _tray_icon = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Pingo - P2P Messaging")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "mute" => {
                    let current = NOTIFICATIONS_MUTED.load(Ordering::SeqCst);
                    NOTIFICATIONS_MUTED.store(!current, Ordering::SeqCst);
                    // Emit event to frontend
                    let _ = app.emit("notifications-muted", !current);
                }
                "exit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    println!("System tray initialized successfully");
    Ok(())
}

/// Blink tray icon on new message (call from notification handler)
#[allow(dead_code)]
pub fn blink_tray_icon<R: Runtime>(app: &AppHandle<R>) {
    // This would toggle icon between normal and notification state
    // For production, implement icon switching with timer
    let _ = app.emit("tray-blink", true);
}

/// Check if notifications are muted
pub fn is_muted() -> bool {
    NOTIFICATIONS_MUTED.load(Ordering::SeqCst)
}

/// Toggle mute state
pub fn toggle_mute() -> bool {
    let current = NOTIFICATIONS_MUTED.load(Ordering::SeqCst);
    NOTIFICATIONS_MUTED.store(!current, Ordering::SeqCst);
    !current
}
