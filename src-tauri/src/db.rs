// src-tauri/src/db.rs
// SQLite Database Integration for Pingo — optimised with WAL, pagination, proper indexing

use rusqlite::{Connection, Result as SqliteResult, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use chrono::Utc;

pub struct Database { conn: Mutex<Connection> }

// ============ DATA MODELS ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: String, pub username: String, pub device_id: String,
    pub public_key: Option<String>, pub avatar_path: Option<String>,
    pub bio: Option<String>, pub designation: Option<String>,
    pub last_seen: Option<String>, pub is_online: bool, pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String, pub sender_id: String, pub receiver_id: String,
    pub content: String, pub message_type: String,
    pub file_path: Option<String>, pub is_read: bool, pub is_delivered: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct FileRecord {
    pub id: String, pub message_id: Option<String>, pub sender_id: String,
    pub receiver_id: String, pub file_name: String, pub file_path: String,
    pub file_size: i64, pub file_type: String, pub checksum: String,
    pub is_complete: bool, pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings { pub key: String, pub value: String }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String, pub title: String, pub content: String, pub color: String,
    pub pinned: bool, pub category: Option<String>,
    pub created_at: String, pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Group {
    pub id: String, pub name: String, pub created_by: String,
    pub avatar_color: Option<String>, pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupMember {
    pub group_id: String, pub user_id: String, pub username: String,
    pub role: String, pub joined_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupMessage {
    pub id: String, pub group_id: String, pub sender_id: String,
    pub sender_name: String, pub content: String, pub message_type: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LastMessageInfo {
    pub peer_id: String, pub content: String, pub created_at: String, pub is_from_me: bool,
}

// ============ DATABASE IMPLEMENTATION ============

impl Database {
    pub fn get_db_path() -> PathBuf {
        let instance = std::env::var("PINGO_INSTANCE").unwrap_or_default();
        let app_name = if instance.is_empty() { "Pingo".to_string() } else { format!("Pingo_{}", instance) };
        let app_dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join(app_name);
        std::fs::create_dir_all(&app_dir).ok();
        app_dir.join("pingo.db")
    }

    pub fn new() -> SqliteResult<Self> {
        let conn = Connection::open(Self::get_db_path())?;
        let db = Database { conn: Mutex::new(conn) };
        db.run_migrations()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn new_in_memory() -> SqliteResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Database { conn: Mutex::new(conn) };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous  = NORMAL;
             PRAGMA cache_size   = -8000;
             PRAGMA temp_store   = MEMORY;
             PRAGMA mmap_size    = 268435456;
             PRAGMA foreign_keys = ON;"
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, device_id TEXT UNIQUE NOT NULL,
                public_key TEXT, avatar_path TEXT, bio TEXT DEFAULT '', designation TEXT DEFAULT '',
                last_seen TEXT, is_online INTEGER DEFAULT 0, created_at TEXT NOT NULL
            )", [])?;
        let _ = conn.execute("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE users ADD COLUMN designation TEXT DEFAULT ''", []);

        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
                content TEXT NOT NULL, message_type TEXT DEFAULT 'text', file_path TEXT,
                is_read INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0, created_at TEXT NOT NULL,
                FOREIGN KEY (sender_id) REFERENCES users(id),
                FOREIGN KEY (receiver_id) REFERENCES users(id)
            )", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY, message_id TEXT, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
                file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL,
                file_type TEXT NOT NULL, checksum TEXT NOT NULL, is_complete INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            )", [])?;

        conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS peers (
                device_id TEXT PRIMARY KEY, username TEXT NOT NULL, ip_address TEXT NOT NULL,
                port INTEGER NOT NULL, public_key TEXT, last_seen TEXT NOT NULL, is_trusted INTEGER DEFAULT 0
            )", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT DEFAULT '',
                color TEXT DEFAULT '#fef3c7', pinned INTEGER DEFAULT 0, category TEXT DEFAULT '',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL,
                avatar_color TEXT DEFAULT '#4f46e5', created_at TEXT NOT NULL
            )", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS group_members (
                group_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
                role TEXT DEFAULT 'member', joined_at TEXT NOT NULL,
                PRIMARY KEY (group_id, user_id),
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            )", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS group_messages (
                id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
                message_type TEXT DEFAULT 'text', created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            )", [])?;

        for idx in &[
            "CREATE INDEX IF NOT EXISTS idx_msg_sender   ON messages(sender_id)",
            "CREATE INDEX IF NOT EXISTS idx_msg_receiver  ON messages(receiver_id)",
            "CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_msg_conv      ON messages(sender_id, receiver_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_msg_unread    ON messages(receiver_id, is_read, sender_id)",
            "CREATE INDEX IF NOT EXISTS idx_notes_pin     ON notes(pinned, updated_at)",
            "CREATE INDEX IF NOT EXISTS idx_grpmsg_grp    ON group_messages(group_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_grpmem_grp    ON group_members(group_id)",
        ] { conn.execute(idx, [])?; }

        Ok(())
    }

    // ============ USER CRUD ============

    pub fn create_user(&self, user: &User) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO users (id,username,device_id,public_key,avatar_path,bio,designation,last_seen,is_online,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![user.id, user.username, user.device_id, user.public_key, user.avatar_path,
                    user.bio, user.designation, user.last_seen, user.is_online as i32, user.created_at],
        )?;
        Ok(())
    }

    fn row_to_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
        Ok(User {
            id: row.get(0)?, username: row.get(1)?, device_id: row.get(2)?,
            public_key: row.get(3)?, avatar_path: row.get(4)?,
            bio: row.get(5)?, designation: row.get(6)?,
            last_seen: row.get(7)?, is_online: row.get::<_, i32>(8)? != 0, created_at: row.get(9)?,
        })
    }

    const USER_COLS: &'static str =
        "id,username,device_id,public_key,avatar_path,COALESCE(bio,'') as bio,COALESCE(designation,'') as designation,last_seen,is_online,created_at";

    pub fn get_user(&self, id: &str) -> SqliteResult<Option<User>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM users WHERE id=?1", Self::USER_COLS);
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? { Some(r) => Ok(Some(Self::row_to_user(r)?)), None => Ok(None) }
    }

    pub fn get_all_users(&self) -> SqliteResult<Vec<User>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {} FROM users ORDER BY username", Self::USER_COLS);
        let mut stmt = conn.prepare(&sql)?;
        let result = stmt.query_map([], |r| Self::row_to_user(r))?.collect::<Result<Vec<_>,_>>();
        result
    }

    #[allow(dead_code)]
    pub fn update_user_online_status(&self, id: &str, is_online: bool) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE users SET is_online=?1,last_seen=?2 WHERE id=?3", params![is_online as i32, now(), id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn delete_user(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM users WHERE id=?1", params![id])?; Ok(())
    }

    // ============ MESSAGE CRUD ============

    pub fn create_message(&self, message: &Message) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO messages (id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![message.id, message.sender_id, message.receiver_id, message.content,
                    message.message_type, message.file_path, message.is_read as i32,
                    message.is_delivered as i32, message.created_at],
        )?;
        Ok(())
    }

    fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
        Ok(Message {
            id: row.get(0)?, sender_id: row.get(1)?, receiver_id: row.get(2)?,
            content: row.get(3)?, message_type: row.get(4)?, file_path: row.get(5)?,
            is_read: row.get::<_,i32>(6)?!=0, is_delivered: row.get::<_,i32>(7)?!=0,
            created_at: row.get(8)?,
        })
    }

    pub fn get_messages_between(&self, user1: &str, user2: &str, limit: i32) -> SqliteResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
             FROM messages
             WHERE (sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1)
             ORDER BY created_at DESC LIMIT ?3")?;
        let result = stmt.query_map(params![user1,user2,limit], |r| Self::row_to_message(r))?.collect();
        result
    }

    pub fn get_messages_paginated(&self, user1: &str, user2: &str, before: Option<&str>, limit: i32) -> SqliteResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        if let Some(cursor) = before {
            let mut stmt = conn.prepare(
                "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
                 FROM messages
                 WHERE ((sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1)) AND created_at < ?3
                 ORDER BY created_at DESC LIMIT ?4")?;
            let result = stmt.query_map(params![user1,user2,cursor,limit], |r| Self::row_to_message(r))?.collect();
            result
        } else {
            let mut stmt = conn.prepare(
                "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
                 FROM messages
                 WHERE (sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1)
                 ORDER BY created_at DESC LIMIT ?3")?;
            let result = stmt.query_map(params![user1,user2,limit], |r| Self::row_to_message(r))?.collect();
            result
        }
    }

    pub fn get_new_messages_since(&self, user1: &str, user2: &str, since: &str) -> SqliteResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
             FROM messages
             WHERE ((sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1)) AND created_at > ?3
             ORDER BY created_at ASC")?;
        let result = stmt.query_map(params![user1,user2,since], |r| Self::row_to_message(r))?.collect();
        result
    }

    pub fn mark_message_read(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("UPDATE messages SET is_read=1 WHERE id=?1", params![id])?; Ok(())
    }

    pub fn mark_messages_read_from_peer(&self, local_id: &str, peer_id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE messages SET is_read=1 WHERE receiver_id=?1 AND sender_id=?2 AND is_read=0",
            params![local_id, peer_id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn mark_message_delivered(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("UPDATE messages SET is_delivered=1 WHERE id=?1", params![id])?; Ok(())
    }

    pub fn delete_message(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM messages WHERE id=?1", params![id])?; Ok(())
    }

    pub fn delete_all_messages_with_peer(&self, local_id: &str, peer_id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "DELETE FROM messages WHERE (sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1)",
            params![local_id, peer_id])?;
        Ok(())
    }

    pub fn update_message_file_path(&self, message_id: &str, file_path: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE messages SET file_path=?1 WHERE id=?2",
            params![file_path, message_id])?;
        Ok(())
    }

    pub fn get_undelivered_messages_for_peer(&self, sender_id: &str, receiver_id: &str) -> SqliteResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
             FROM messages WHERE sender_id=?1 AND receiver_id=?2 AND is_delivered=0
             ORDER BY created_at ASC LIMIT 100")?;
        let result = stmt.query_map(params![sender_id, receiver_id], |r| Self::row_to_message(r))?.collect();
        result
    }

    pub fn get_unread_count(&self, user_id: &str) -> SqliteResult<i32> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM messages WHERE receiver_id=?1 AND is_read=0", params![user_id], |r| r.get(0))
    }

    pub fn get_unread_count_from_peer(&self, local_id: &str, peer_id: &str) -> SqliteResult<i32> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM messages WHERE receiver_id=?1 AND sender_id=?2 AND is_read=0",
            params![local_id, peer_id], |r| r.get(0))
    }

    pub fn get_last_messages(&self, local_id: &str) -> SqliteResult<Vec<LastMessageInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT peer_id, content, created_at, is_from_me FROM (
                SELECT
                    CASE WHEN sender_id=?1 THEN receiver_id ELSE sender_id END as peer_id,
                    content, created_at,
                    CASE WHEN sender_id=?1 THEN 1 ELSE 0 END as is_from_me,
                    ROW_NUMBER() OVER (
                        PARTITION BY CASE WHEN sender_id=?1 THEN receiver_id ELSE sender_id END
                        ORDER BY created_at DESC
                    ) as rn
                FROM messages WHERE sender_id=?1 OR receiver_id=?1
            ) WHERE rn=1")?;
        let result = stmt.query_map(params![local_id], |r| Ok(LastMessageInfo {
            peer_id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)?,
            is_from_me: r.get::<_,i32>(3)?!=0,
        }))?.collect();
        result
    }

    // ============ FILE CRUD ============

    #[allow(dead_code)]
    pub fn create_file_record(&self, file: &FileRecord) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO files (id,message_id,sender_id,receiver_id,file_name,file_path,file_size,file_type,checksum,is_complete,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![file.id,file.message_id,file.sender_id,file.receiver_id,file.file_name,
                    file.file_path,file.file_size,file.file_type,file.checksum,file.is_complete as i32,file.created_at])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn mark_file_complete(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("UPDATE files SET is_complete=1 WHERE id=?1", params![id])?; Ok(())
    }

    #[allow(dead_code)]
    pub fn get_file(&self, id: &str) -> SqliteResult<Option<FileRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,message_id,sender_id,receiver_id,file_name,file_path,file_size,file_type,checksum,is_complete,created_at FROM files WHERE id=?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(r) => Ok(Some(FileRecord {
                id:r.get(0)?,message_id:r.get(1)?,sender_id:r.get(2)?,receiver_id:r.get(3)?,
                file_name:r.get(4)?,file_path:r.get(5)?,file_size:r.get(6)?,file_type:r.get(7)?,
                checksum:r.get(8)?,is_complete:r.get::<_,i32>(9)?!=0,created_at:r.get(10)?,
            })),
            None => Ok(None),
        }
    }

    // ============ SETTINGS CRUD ============

    pub fn set_setting(&self, key: &str, value: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("INSERT OR REPLACE INTO settings (key,value) VALUES (?1,?2)", params![key,value])?; Ok(())
    }

    pub fn get_setting(&self, key: &str) -> SqliteResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn get_all_settings(&self) -> SqliteResult<Vec<Settings>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key,value FROM settings")?;
        let result = stmt.query_map([], |r| Ok(Settings{key:r.get(0)?,value:r.get(1)?}))?.collect();
        result
    }

    // ============ NOTES CRUD ============

    pub fn save_note(&self, note: &Note) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO notes (id,title,content,color,pinned,category,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![note.id,note.title,note.content,note.color,note.pinned as i32,note.category,note.created_at,note.updated_at])?;
        Ok(())
    }

    pub fn get_all_notes(&self) -> SqliteResult<Vec<Note>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,title,content,color,pinned,category,created_at,updated_at FROM notes ORDER BY pinned DESC, updated_at DESC")?;
        let result = stmt.query_map([], |r| Ok(Note {
            id:r.get(0)?,title:r.get(1)?,content:r.get(2)?,color:r.get(3)?,
            pinned:r.get::<_,i32>(4)?!=0,category:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?,
        }))?.collect();
        result
    }

    pub fn delete_note(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM notes WHERE id=?1", params![id])?; Ok(())
    }

    pub fn toggle_note_pin(&self, id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE notes SET pinned=CASE WHEN pinned=0 THEN 1 ELSE 0 END, updated_at=?2 WHERE id=?1",
            params![id, now()])?;
        Ok(())
    }

    // ============ GROUP CRUD ============

    pub fn create_group(&self, group: &Group) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO groups (id,name,created_by,avatar_color,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![group.id,group.name,group.created_by,group.avatar_color,group.created_at])?;
        Ok(())
    }

    pub fn add_group_member(&self, m: &GroupMember) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO group_members (group_id,user_id,username,role,joined_at) VALUES (?1,?2,?3,?4,?5)",
            params![m.group_id,m.user_id,m.username,m.role,m.joined_at])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn remove_group_member(&self, group_id: &str, user_id: &str) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute("DELETE FROM group_members WHERE group_id=?1 AND user_id=?2", params![group_id,user_id])?;
        Ok(())
    }

    pub fn get_groups(&self, user_id: &str) -> SqliteResult<Vec<Group>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT g.id,g.name,g.created_by,g.avatar_color,g.created_at FROM groups g
             INNER JOIN group_members gm ON g.id=gm.group_id WHERE gm.user_id=?1 ORDER BY g.created_at DESC")?;
        let result = stmt.query_map(params![user_id], |r| Ok(Group {
            id:r.get(0)?,name:r.get(1)?,created_by:r.get(2)?,avatar_color:r.get(3)?,created_at:r.get(4)?,
        }))?.collect();
        result
    }

    pub fn get_group_members(&self, group_id: &str) -> SqliteResult<Vec<GroupMember>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT group_id,user_id,username,role,joined_at FROM group_members WHERE group_id=?1")?;
        let result = stmt.query_map(params![group_id], |r| Ok(GroupMember {
            group_id:r.get(0)?,user_id:r.get(1)?,username:r.get(2)?,role:r.get(3)?,joined_at:r.get(4)?,
        }))?.collect();
        result
    }

    pub fn send_group_message(&self, msg: &GroupMessage) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO group_messages (id,group_id,sender_id,sender_name,content,message_type,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![msg.id,msg.group_id,msg.sender_id,msg.sender_name,msg.content,msg.message_type,msg.created_at])?;
        Ok(())
    }

    pub fn get_group_messages(&self, group_id: &str, limit: i32) -> SqliteResult<Vec<GroupMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,group_id,sender_id,sender_name,content,message_type,created_at FROM group_messages WHERE group_id=?1 ORDER BY created_at DESC LIMIT ?2")?;
        let result = stmt.query_map(params![group_id,limit], |r| Ok(GroupMessage {
            id:r.get(0)?,group_id:r.get(1)?,sender_id:r.get(2)?,sender_name:r.get(3)?,
            content:r.get(4)?,message_type:r.get(5)?,created_at:r.get(6)?,
        }))?.collect();
        result
    }

    pub fn delete_group(&self, group_id: &str) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM group_messages WHERE group_id=?1", params![group_id])?;
        conn.execute("DELETE FROM group_members WHERE group_id=?1", params![group_id])?;
        conn.execute("DELETE FROM groups WHERE id=?1", params![group_id])?;
        Ok(())
    }

    // ============ PEER CACHE ============

    pub fn upsert_peer_as_user(&self, device_id: &str, username: &str, public_key: Option<&str>) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        let now_str = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO users (id,username,device_id,public_key,avatar_path,bio,designation,last_seen,is_online,created_at)
             VALUES (?1,?2,?1,?3,NULL,'','',?4,1,?4)
             ON CONFLICT(id) DO UPDATE SET username=excluded.username,
                public_key=COALESCE(excluded.public_key,users.public_key),
                last_seen=excluded.last_seen, is_online=1",
            params![device_id, username, public_key, now_str])?;
        Ok(())
    }

    pub fn set_user_avatar(&self, device_id: &str, avatar_url: &str) -> SqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        // Ensure user exists; insert a minimal record if missing
        conn.execute(
            "INSERT OR IGNORE INTO users (id,username,device_id,created_at) VALUES (?1,?2,?1,?3)",
            params![device_id, "Peer", Utc::now().to_rfc3339()])?;
        conn.execute("UPDATE users SET avatar_path=?1 WHERE id=?2", params![avatar_url, device_id])?;
        Ok(())
    }

    pub fn get_shared_media(&self, user1: &str, user2: &str, media_type: Option<&str>) -> SqliteResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();
        let query = if let Some(mt) = media_type {
            format!(
                "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
                 FROM messages WHERE ((sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1))
                 AND message_type='{}' ORDER BY created_at DESC", mt)
        } else {
            "SELECT id,sender_id,receiver_id,content,message_type,file_path,is_read,is_delivered,created_at
             FROM messages WHERE ((sender_id=?1 AND receiver_id=?2) OR (sender_id=?2 AND receiver_id=?1))
             AND message_type IN ('image','file') ORDER BY created_at DESC".to_string()
        };
        let mut stmt = conn.prepare(&query)?;
        let result = stmt.query_map(params![user1,user2], |r| Self::row_to_message(r))?.collect();
        result
    }

    pub fn get_users_with_messages(&self, local_id: &str) -> SqliteResult<Vec<User>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT u.id,u.username,u.device_id,u.public_key,u.avatar_path,
                    COALESCE(u.bio,''),COALESCE(u.designation,''),u.last_seen,u.is_online,u.created_at
             FROM users u INNER JOIN messages m ON (m.sender_id=u.id OR m.receiver_id=u.id)
             WHERE u.id!=?1 AND (m.sender_id=?1 OR m.receiver_id=?1) ORDER BY u.username"
        )?;
        let result = stmt.query_map(params![local_id], |r| Self::row_to_user(r))?.collect();
        result
    }

    #[allow(dead_code)]
    pub fn cache_peer(&self, device_id: &str, username: &str, ip: &str, port: i32, public_key: Option<&str>) -> SqliteResult<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO peers (device_id,username,ip_address,port,public_key,last_seen) VALUES (?1,?2,?3,?4,?5,?6)",
            params![device_id,username,ip,port,public_key,Utc::now().to_rfc3339()])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn get_cached_peers(&self) -> SqliteResult<Vec<(String,String,String,i32)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT device_id,username,ip_address,port FROM peers ORDER BY last_seen DESC")?;
        let result = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect();
        result
    }
}

pub fn generate_id() -> String { uuid::Uuid::new_v4().to_string() }
pub fn now() -> String { Utc::now().to_rfc3339() }
