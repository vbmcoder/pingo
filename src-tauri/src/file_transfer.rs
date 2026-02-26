// src-tauri/src/file_transfer.rs
// File Transfer System for Pingo

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

// Chunk size: 64KB for good balance between overhead and reliability
const CHUNK_SIZE: usize = 64 * 1024;
#[allow(dead_code)]
const MAX_RETRIES: u32 = 3;

/// File transfer metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub transfer_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub total_chunks: u32,
    pub checksum: String,
}

/// Individual chunk data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChunk {
    pub transfer_id: String,
    pub chunk_index: u32,
    pub data: String,  // Base64 encoded
    pub checksum: String,  // Chunk checksum
}

/// Chunk acknowledgment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkAck {
    pub transfer_id: String,
    pub chunk_index: u32,
    pub success: bool,
}

/// Transfer completion message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferComplete {
    pub transfer_id: String,
    pub success: bool,
    pub checksum: String,
}

/// Transfer state for tracking progress
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferState {
    pub transfer_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub total_chunks: u32,
    pub received_chunks: Vec<bool>,
    pub is_sender: bool,
    pub is_complete: bool,
    pub file_path: PathBuf,
    pub checksum: String,
}

/// File transfer progress event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub chunks_completed: u32,
    pub total_chunks: u32,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub percentage: f32,
}

/// File transfer manager
pub struct FileTransferManager {
    transfers: Arc<RwLock<HashMap<String, TransferState>>>,
    downloads_dir: PathBuf,
}

impl FileTransferManager {
    /// Create a new file transfer manager
    pub fn new() -> Self {
        let instance = std::env::var("PINGO_INSTANCE").unwrap_or_default();
        let folder_name = if instance.is_empty() {
            "Pingo".to_string()
        } else {
            format!("Pingo_{}", instance)
        };

        let downloads_dir = dirs::download_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(folder_name);

        // Create downloads directory if it doesn't exist
        fs::create_dir_all(&downloads_dir).ok();

        FileTransferManager {
            transfers: Arc::new(RwLock::new(HashMap::new())),
            downloads_dir,
        }
    }

    /// Get the downloads directory
    pub fn get_downloads_dir(&self) -> PathBuf {
        self.downloads_dir.clone()
    }

    /// Prepare a file for sending
    pub fn prepare_send(&self, file_path: &Path, transfer_id: &str) -> Result<FileMetadata, String> {
        let file = File::open(file_path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        let file_size = metadata.len();

        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let file_type = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();

        // Calculate checksum
        let checksum = self.calculate_file_checksum(file_path)?;

        // Calculate total chunks
        let total_chunks = ((file_size as f64) / (CHUNK_SIZE as f64)).ceil() as u32;

        // Create transfer state
        let state = TransferState {
            transfer_id: transfer_id.to_string(),
            file_name: file_name.clone(),
            file_size,
            total_chunks,
            received_chunks: vec![false; total_chunks as usize],
            is_sender: true,
            is_complete: false,
            file_path: file_path.to_path_buf(),
            checksum: checksum.clone(),
        };

        {
            let mut transfers = self.transfers.write().unwrap();
            transfers.insert(transfer_id.to_string(), state);
        }

        Ok(FileMetadata {
            transfer_id: transfer_id.to_string(),
            file_name,
            file_size,
            file_type,
            total_chunks,
            checksum,
        })
    }

    /// Prepare to receive a file
    pub fn prepare_receive(&self, metadata: &FileMetadata) -> Result<PathBuf, String> {
        // Create unique file path
        let mut file_path = self.downloads_dir.join(&metadata.file_name);
        let mut counter = 1;

        while file_path.exists() {
            let stem = Path::new(&metadata.file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = Path::new(&metadata.file_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");

            if ext.is_empty() {
                file_path = self.downloads_dir.join(format!("{} ({})", stem, counter));
            } else {
                file_path = self.downloads_dir.join(format!("{} ({}).{}", stem, counter, ext));
            }
            counter += 1;
        }

        // Create empty file with reserved size
        let file = File::create(&file_path).map_err(|e| e.to_string())?;
        file.set_len(metadata.file_size).map_err(|e| e.to_string())?;

        // Create transfer state
        let state = TransferState {
            transfer_id: metadata.transfer_id.clone(),
            file_name: metadata.file_name.clone(),
            file_size: metadata.file_size,
            total_chunks: metadata.total_chunks,
            received_chunks: vec![false; metadata.total_chunks as usize],
            is_sender: false,
            is_complete: false,
            file_path: file_path.clone(),
            checksum: metadata.checksum.clone(),
        };

        {
            let mut transfers = self.transfers.write().unwrap();
            transfers.insert(metadata.transfer_id.clone(), state);
        }

        Ok(file_path)
    }

    /// Get a chunk to send
    pub fn get_chunk(&self, transfer_id: &str, chunk_index: u32) -> Result<FileChunk, String> {
        let transfers = self.transfers.read().unwrap();
        let state = transfers.get(transfer_id)
            .ok_or("Transfer not found")?;

        let mut file = File::open(&state.file_path).map_err(|e| e.to_string())?;

        // Seek to chunk position
        let offset = (chunk_index as u64) * (CHUNK_SIZE as u64);
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;

        // Read chunk
        let mut buffer = vec![0u8; CHUNK_SIZE];
        let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        buffer.truncate(bytes_read);

        // Calculate chunk checksum
        let checksum = self.calculate_checksum(&buffer);

        Ok(FileChunk {
            transfer_id: transfer_id.to_string(),
            chunk_index,
            data: BASE64.encode(&buffer),
            checksum,
        })
    }

    /// Receive and write a chunk
    pub fn receive_chunk(&self, chunk: &FileChunk) -> Result<ChunkAck, String> {
        // Decode and verify chunk
        let data = BASE64.decode(&chunk.data).map_err(|e| e.to_string())?;
        let calculated_checksum = self.calculate_checksum(&data);

        if calculated_checksum != chunk.checksum {
            return Ok(ChunkAck {
                transfer_id: chunk.transfer_id.clone(),
                chunk_index: chunk.chunk_index,
                success: false,
            });
        }

        // Get transfer state
        let file_path = {
            let transfers = self.transfers.read().unwrap();
            let state = transfers.get(&chunk.transfer_id)
                .ok_or("Transfer not found")?;
            state.file_path.clone()
        };

        // Write chunk to file
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&file_path)
            .map_err(|e| e.to_string())?;

        let offset = (chunk.chunk_index as u64) * (CHUNK_SIZE as u64);
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;

        // Update transfer state
        {
            let mut transfers = self.transfers.write().unwrap();
            if let Some(state) = transfers.get_mut(&chunk.transfer_id) {
                if (chunk.chunk_index as usize) < state.received_chunks.len() {
                    state.received_chunks[chunk.chunk_index as usize] = true;
                }
            }
        }

        Ok(ChunkAck {
            transfer_id: chunk.transfer_id.clone(),
            chunk_index: chunk.chunk_index,
            success: true,
        })
    }

    /// Get transfer progress
    pub fn get_progress(&self, transfer_id: &str) -> Option<TransferProgress> {
        let transfers = self.transfers.read().unwrap();
        let state = transfers.get(transfer_id)?;

        let chunks_completed = state.received_chunks.iter().filter(|&&c| c).count() as u32;
        let bytes_transferred = (chunks_completed as u64) * (CHUNK_SIZE as u64);
        let percentage = (chunks_completed as f32) / (state.total_chunks as f32) * 100.0;

        Some(TransferProgress {
            transfer_id: transfer_id.to_string(),
            chunks_completed,
            total_chunks: state.total_chunks,
            bytes_transferred: bytes_transferred.min(state.file_size),
            total_bytes: state.file_size,
            percentage,
        })
    }

    /// Get missing chunks for resume
    pub fn get_missing_chunks(&self, transfer_id: &str) -> Vec<u32> {
        let transfers = self.transfers.read().unwrap();
        if let Some(state) = transfers.get(transfer_id) {
            state.received_chunks
                .iter()
                .enumerate()
                .filter(|(_, &received)| !received)
                .map(|(i, _)| i as u32)
                .collect()
        } else {
            vec![]
        }
    }

    /// Complete a transfer (verify integrity)
    pub fn complete_transfer(&self, transfer_id: &str) -> Result<TransferComplete, String> {
        let file_path = {
            let transfers = self.transfers.read().unwrap();
            let state = transfers.get(transfer_id)
                .ok_or("Transfer not found")?;
            state.file_path.clone()
        };

        let checksum = self.calculate_file_checksum(&file_path)?;

        let expected_checksum = {
            let transfers = self.transfers.read().unwrap();
            let state = transfers.get(transfer_id)
                .ok_or("Transfer not found")?;
            state.checksum.clone()
        };

        let success = checksum == expected_checksum;

        // Mark transfer as complete
        {
            let mut transfers = self.transfers.write().unwrap();
            if let Some(state) = transfers.get_mut(transfer_id) {
                state.is_complete = success;
            }
        }

        Ok(TransferComplete {
            transfer_id: transfer_id.to_string(),
            success,
            checksum,
        })
    }

    /// Cancel a transfer
    pub fn cancel_transfer(&self, transfer_id: &str) -> Result<(), String> {
        let mut transfers = self.transfers.write().unwrap();
        if let Some(state) = transfers.remove(transfer_id) {
            // Delete incomplete file if receiving
            if !state.is_sender && !state.is_complete {
                fs::remove_file(&state.file_path).ok();
            }
        }
        Ok(())
    }

    /// Get transfer state
    #[allow(dead_code)]
    pub fn get_transfer(&self, transfer_id: &str) -> Option<TransferState> {
        let transfers = self.transfers.read().unwrap();
        transfers.get(transfer_id).cloned()
    }

    /// Calculate checksum for a byte slice
    fn calculate_checksum(&self, data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex_encode(&result)
    }

    /// Calculate checksum for a file
    fn calculate_file_checksum(&self, path: &Path) -> Result<String, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];

        loop {
            let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
        }

        let result = hasher.finalize();
        Ok(hex_encode(&result))
    }
}

impl Default for FileTransferManager {
    fn default() -> Self {
        Self::new()
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Check if a file is an image (for preview)
#[allow(dead_code)]
pub fn is_image(file_type: &str) -> bool {
    matches!(file_type.to_lowercase().as_str(), 
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg")
}

/// Get MIME type from extension
#[allow(dead_code)]
pub fn get_mime_type(extension: &str) -> &'static str {
    match extension.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/*
FILE TRANSFER FLOW:

┌─────────────────────────────────────────────────────────────────────┐
│                    FILE TRANSFER PROTOCOL                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐                                ┌──────────┐           │
│  │ Sender   │                                │ Receiver │           │
│  └────┬─────┘                                └────┬─────┘           │
│       │                                           │                 │
│       │ 1. FileTransferRequest                    │                 │
│       │    {file_name, file_size, transfer_id}    │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 2. FileTransferResponse                   │                 │
│       │    {transfer_id, accepted: true}          │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│       │ 3. FileMetadata                           │                 │
│       │    {total_chunks, checksum}               │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 4. FileChunk[0]                           │                 │
│       │    {chunk_index, data, checksum}          │                 │
│       ├──────────────────────────────────────────►│                 │
│       │                                           │                 │
│       │ 5. ChunkAck[0]                            │                 │
│       │    {chunk_index, success: true}           │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│       │ ... repeat for all chunks ...             │                 │
│       │                                           │                 │
│       │ N. TransferComplete                       │                 │
│       │    {success, final_checksum}              │                 │
│       │◄──────────────────────────────────────────┤                 │
│       │                                           │                 │
│                                                                      │
│  RESUME ON FAILURE:                                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1. Receiver stores received_chunks bitmap                   │   │
│  │ 2. On reconnect, receiver sends missing chunk indices       │   │
│  │ 3. Sender resends only missing chunks                       │   │
│  │ 4. Continue until all chunks received                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  CHUNK SIZE: 64KB                                                   │
│  - Good balance for reliability                                     │
│  - Fits in single WebRTC message                                    │
│  - Easy to resend on failure                                        │
│                                                                      │
│  FILE INTEGRITY:                                                    │
│  - SHA-256 checksum per chunk (detect corruption)                   │
│  - SHA-256 checksum for entire file (verify completion)            │
│  - Automatic retry on checksum mismatch                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
*/
