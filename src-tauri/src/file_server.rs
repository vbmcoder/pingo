// src-tauri/src/file_server.rs
// Tiny HTTP file server for serving images/files to LAN peers

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::thread;

/// A simple HTTP file server that serves stored files to LAN peers
pub struct FileServer {
    files: Arc<RwLock<HashMap<String, StoredFile>>>,
    port: Arc<RwLock<u16>>,
    storage_dir: PathBuf,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct StoredFile {
    pub id: String,
    pub path: PathBuf,
    pub mime_type: String,
    pub file_name: String,
}

impl FileServer {
    pub fn new() -> Self {
        let storage_dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Pingo")
            .join("shared_files");
        fs::create_dir_all(&storage_dir).ok();

        FileServer {
            files: Arc::new(RwLock::new(HashMap::new())),
            port: Arc::new(RwLock::new(0)),
            storage_dir,
        }
    }

    /// Store a base64 data URL and return the file ID
    pub fn store_data_url(
        &self,
        file_id: &str,
        data_url: &str,
        file_name: &str,
    ) -> Result<String, String> {
        // Parse data URL: data:mime;base64,<data>
        let mime_type;
        let data_part;
        if let Some(comma_pos) = data_url.find(',') {
            let header = &data_url[..comma_pos];
            mime_type = header
                .strip_prefix("data:")
                .and_then(|s| s.split(';').next())
                .unwrap_or("application/octet-stream")
                .to_string();
            data_part = &data_url[comma_pos + 1..];
        } else {
            return Err("Invalid data URL".to_string());
        }

        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_part)
            .map_err(|e| format!("Base64 decode error: {}", e))?;

        let ext = mime_to_ext(&mime_type);
        let file_path = self.storage_dir.join(format!("{}.{}", file_id, ext));
        fs::write(&file_path, &bytes).map_err(|e| format!("Write error: {}", e))?;

        let stored = StoredFile {
            id: file_id.to_string(),
            path: file_path,
            mime_type,
            file_name: file_name.to_string(),
        };

        self.files
            .write()
            .unwrap()
            .insert(file_id.to_string(), stored);
        Ok(file_id.to_string())
    }

    /// Store raw bytes
    #[allow(dead_code)]
    pub fn store_bytes(
        &self,
        file_id: &str,
        bytes: &[u8],
        file_name: &str,
        mime_type: &str,
    ) -> Result<String, String> {
        let ext = mime_to_ext(mime_type);
        let file_path = self.storage_dir.join(format!("{}.{}", file_id, ext));
        fs::write(&file_path, bytes).map_err(|e| format!("Write error: {}", e))?;

        let stored = StoredFile {
            id: file_id.to_string(),
            path: file_path,
            mime_type: mime_type.to_string(),
            file_name: file_name.to_string(),
        };

        self.files
            .write()
            .unwrap()
            .insert(file_id.to_string(), stored);
        Ok(file_id.to_string())
    }

    /// Get the HTTP URL for a file
    #[allow(dead_code)]
    pub fn get_file_url(&self, file_id: &str) -> Option<String> {
        let port = *self.port.read().unwrap();
        if port == 0 {
            return None;
        }
        let files = self.files.read().unwrap();
        if files.contains_key(file_id) {
            Some(format!("http://0.0.0.0:{}/file/{}", port, file_id))
        } else {
            None
        }
    }

    pub fn get_port(&self) -> u16 {
        *self.port.read().unwrap()
    }

    /// Get the storage directory path
    pub fn get_storage_dir(&self) -> PathBuf {
        self.storage_dir.clone()
    }

    /// Register an externally-downloaded file so the HTTP server can serve it
    pub fn register_file(&self, file_id: &str, path: &std::path::Path, file_name: &str) {
        let mime = guess_mime(file_name);
        let stored = StoredFile {
            id: file_id.to_string(),
            path: path.to_path_buf(),
            mime_type: mime,
            file_name: file_name.to_string(),
        };
        self.files
            .write()
            .unwrap()
            .insert(file_id.to_string(), stored);
    }

    /// Start the HTTP server
    pub fn start(&self, preferred_port: u16) -> Result<u16, String> {
        // Try preferred port first
        let server = match tiny_http::Server::http(format!("0.0.0.0:{}", preferred_port)) {
            Ok(s) => {
                println!(
                    "[Pingo] File server bound to preferred port {}",
                    preferred_port
                );
                s
            }
            Err(e) => {
                println!(
                    "[Pingo] Failed to bind to port {}: {}. Trying random port...",
                    preferred_port, e
                );
                // Try any available port (0 means OS assigns)
                tiny_http::Server::http("0.0.0.0:0")
                    .map_err(|e| format!("Failed to start file server on any port: {}", e))?
            }
        };

        let actual_port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| "Failed to get server address".to_string())?;

        if actual_port == 0 {
            return Err("Server bound to port 0 - this should not happen".to_string());
        }

        *self.port.write().unwrap() = actual_port;
        println!(
            "[Pingo] File server listening on port {} and ready",
            actual_port
        );

        let files = Arc::clone(&self.files);
        let storage_dir = self.storage_dir.clone();

        thread::spawn(move || {
            println!("[Pingo] File server request handler thread started");
            for request in server.incoming_requests() {
                let url = request.url().to_string();

                // Helper to create CORS header each time (tiny_http headers are consumed)
                let cors = || {
                    tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..])
                        .unwrap()
                };

                if request.method() == &tiny_http::Method::Options {
                    let response = tiny_http::Response::empty(200)
                        .with_header(cors())
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Access-Control-Allow-Methods"[..],
                                &b"GET, OPTIONS"[..],
                            )
                            .unwrap(),
                        );
                    let _ = request.respond(response);
                    continue;
                }

                if let Some(file_id) = url.strip_prefix("/file/") {
                    let file_id = file_id.trim_matches('/');

                    // First check in-memory registry
                    let stored = files.read().unwrap().get(file_id).cloned();

                    if let Some(stored) = stored {
                        if stored.path.exists() {
                            if let Ok(data) = fs::read(&stored.path) {
                                let ct = tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    stored.mime_type.as_bytes(),
                                )
                                .unwrap();
                                let resp = tiny_http::Response::from_data(data)
                                    .with_header(ct)
                                    .with_header(cors());
                                let _ = request.respond(resp);
                                continue;
                            }
                        }
                    }

                    // Try finding file on disk by ID prefix
                    let disk_data = find_file_on_disk(&storage_dir, file_id);
                    if let Some((data, mime)) = disk_data {
                        let ct =
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_bytes())
                                .unwrap();
                        let resp = tiny_http::Response::from_data(data)
                            .with_header(ct)
                            .with_header(cors());
                        let _ = request.respond(resp);
                        continue;
                    }

                    // 404
                    let resp = tiny_http::Response::from_string("Not found")
                        .with_status_code(404)
                        .with_header(cors());
                    let _ = request.respond(resp);
                } else {
                    let resp =
                        tiny_http::Response::from_string("Pingo File Server").with_header(cors());
                    let _ = request.respond(resp);
                }
            }
        });

        Ok(actual_port)
    }
}

fn mime_to_ext(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        _ => "bin",
    }
}

fn guess_mime(filename: &str) -> String {
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn find_file_on_disk(storage_dir: &std::path::Path, file_id: &str) -> Option<(Vec<u8>, String)> {
    if let Ok(entries) = fs::read_dir(storage_dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with(file_id) {
                if let Ok(data) = fs::read(entry.path()) {
                    let mime = guess_mime(&fname);
                    return Some((data, mime));
                }
            }
        }
    }
    None
}
