# 🎯 PINGO - P2P Desktop Messaging Application

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.70%2B-ce422b)](https://rust-lang.org)

**PINGO** is a secure, peer-to-peer (P2P) desktop messaging application built with modern technologies. It enables users to communicate directly with each other over a local network (LAN) or the internet with end-to-end encryption, file transfers, screen sharing, and instant messaging capabilities.

## 🌟 Key Features

- 💬 **Real-time Messaging** - Send instant messages with automatic delivery confirmation
- 🔐 **End-to-End Encryption** - All communications encrypted using AES-GCM and X25519
- 📁 **File Transfer** - Share files seamlessly between peers
- 📺 **Screen Sharing** - Real-time screen capture and sharing capabilities
- 🔍 **LAN Discovery** - Automatic peer discovery on local networks
- 🔔 **Notifications** - Real-time desktop notifications for new messages
- 🖥️ **Minimalist UI** - Clean, intuitive React-based interface
- ⚡ **Cross-Platform Ready** - Built with Tauri for Windows, Mac, and Linux support
- 🚀 **Auto-Start** - Optional auto-launch on system startup

## 🏗️ Technology Stack

### Frontend
- **React 19** - Modern UI library
- **Vite** - Fast build tool and dev server
- **React Router** - Client-side routing
- **React Icons** - UI icon library
- **CSS** - Custom styling

### Backend
- **Rust** - High-performance, memory-safe backend
- **Tauri 2** - Desktop app framework
- **Tokio** - Async runtime
- **SQLite** - Local database with SQLite3
- **WebRTC** - Real-time communication protocol
- **AES-GCM** - Military-grade encryption
- **X25519-Dalek** - Elliptic Curve cryptography

---

## 📋 Prerequisites & Installation ⚡

Follow these steps in order to set up your development environment:

---

### ✅ **Step 1: Install Node.js**

**Node.js** is required for frontend development and package management.

1. Download from: 👉 https://nodejs.org/ (LTS version - 18.0 or higher)
2. Run the installer and follow the prompts
3. Accept all defaults
4. Restart your terminal/PowerShell

**Verify installation:**
```powershell
node --version
npm --version
```

---

### ✅ **Step 2: Install pnpm (Package Manager)**

**pnpm** is a faster alternative to npm for managing dependencies (already configured for PINGO).

```powershell
npm install -g pnpm@10.29.3
```

**Verify installation:**
```powershell
pnpm --version
# Should output: 10.29.3 or higher
```

---

### ✅ **Step 3: Install Rust (Most Important ⚡)**

**Rust** is the backend for Tauri - this is why apps are super lightweight 😎

**Option A: Using winget (Recommended for Windows)**
```powershell
winget install --id Rustlang.Rustup
```

**Option B: Manual Installation**
Visit: 👉 https://rustup.rs

Then run the installer and select default options.

**After installation, RESTART YOUR PC ⚠️**

**Verify installation:**
```powershell
rustc -V
# Should output: rustc 1.70.0 or higher

cargo -V
# Should output: cargo 1.70.0 or higher
```

---

### ✅ **Step 4: Install Microsoft Visual Studio C++ Build Tools**

⚠️ **This is CRITICAL - Without this → Tauri will NOT build EXE files!**

1. Download: 👉 https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. Run the installer
3. Select **ONLY** the following:
   - ✔ **Desktop Development with C++**
   - ✔ **MSVC v143** (or latest available)
   - ✔ **Windows 10/11 SDK**
4. Complete the installation
5. **Restart your PC after installation**

**Why this is needed:** Tauri needs a C++ compiler to build native Rust components for Windows.

---

### ✅ **Step 5: Install WebView2 Runtime**

**WebView2** is the runtime that Tauri uses for the UI (instead of Chromium - much lighter! 🚀)

Download and install from: 👉 https://developer.microsoft.com/en-us/microsoft-edge/webview2/

**Why this is needed:** Tauri uses the system WebView for rendering your React app, making the app size tiny (~50MB instead of 200+MB)

---

### ✅ **Step 6: Install Tauri CLI Globally**

Now install the Tauri command-line tool:

```powershell
npm install -g @tauri-apps/cli
```

**Verify installation:**
```powershell
tauri -v
# Should show version info
```

---

### ✅ **Final Verification Checklist**

Open PowerShell and verify all tools are installed:

```powershell
# Check all critical tools
node --version        # Node.js
npm --version         # npm
pnpm --version        # pnpm
rustc --version       # Rust compiler
cargo --version       # Cargo package manager
tauri -v              # Tauri CLI

# All should show version numbers without errors
```

✅ **If all commands work, you're ready to proceed!**

---

## 🚀 Quick Start - Project Setup

### **For Existing PINGO Project (Already Cloned)**

If you've already cloned the PINGO repository:

```powershell
# Navigate to project directory
cd pingo

# Install all dependencies
pnpm install

# Verify Tauri installation
pnpm tauri --version

# Start development
pnpm dev
```

---

### **For New Projects - Create Tauri App from Scratch**

If you're starting fresh, follow these complete steps:

#### **Step 1: Create Vite Project**

```powershell
npm create vite@latest my-pingo-app -- --template react
cd my-pingo-app
```

#### **Step 2: Install Dependencies**

```powershell
# Install with pnpm (faster and recommended)
pnpm install

# Or with npm if you prefer
npm install
```

#### **Step 3: Install Tauri Dependencies**

```powershell
pnpm add --save-dev @tauri-apps/cli @tauri-apps/api
```

#### **Step 4: Initialize Tauri Project**

```powershell
# Initialize Tauri configuration
npx tauri init

# This will create:
# - src-tauri/ directory (Rust backend)
# - tauri.conf.json (configuration file)
# - Cargo.toml (Rust dependencies)
```

#### **Step 5: Start Development**

```powershell
# This starts both frontend dev server and Tauri desktop app
npm run tauri dev
```

Or with pnpm:
```powershell
pnpm tauri dev
```

**What happens next:**
1. Rust backend compiles (first time takes 2-5 minutes ☕)
2. Frontend dev server starts on http://localhost:1420
3. Desktop app window opens with hot-reload enabled
4. Make changes to see them instantly!

---

### **Development Commands Reference**

```powershell
# Start development with hot reload
pnpm dev
pnpm tauri dev

# Build frontend assets only
pnpm build

# Build production desktop app (creates EXE/installer)
pnpm tauri build

# Check Tauri CLI version
pnpm tauri --version

# View Tauri configuration
pnpm tauri info

# Run in production mode locally
pnpm tauri dev --release
```

---

### **Troubleshooting Tips** 🔧

If `pnpm tauri dev` doesn't work:

```powershell
# Clear cache and node_modules
rm -r node_modules
rm pnpm-lock.yaml

# Reinstall everything
pnpm install

# Try again
pnpm tauri dev
```

If Rust compilation fails:
```powershell
# Update Rust
rustup update

# Try building again
pnpm tauri dev
```

---

## 💻 Development

### Running the Development Server

To start developing with hot-reload enabled:

```bash
pnpm dev
```

This command:
1. Starts the Vite dev server (frontend on http://localhost:1420)
2. Launches the Tauri desktop application
3. Enables hot-reload for both frontend and backend changes

### Directory Structure

```
pingo/
├── src/                          # Frontend (React)
│   ├── components/               # Reusable Vue components
│   │   ├── Aside.jsx
│   │   ├── Profile.jsx
│   │   ├── ImageLightbox.jsx
│   │   ├── NotificationCenter.jsx
│   │   ├── ScreenshotCrop.jsx
│   │   └── UserAvatar.jsx
│   ├── pages/                    # Page components
│   │   ├── chat.jsx
│   │   ├── meetings.jsx
│   │   ├── notes.jsx
│   │   └── settings.jsx
│   ├── context/                  # React Context API
│   │   └── AppContext.jsx
│   ├── hooks/                    # Custom React hooks
│   │   └── useApp.js
│   ├── lib/                      # Utility libraries
│   │   ├── api.js                # Tauri API wrapper
│   │   ├── webrtc.js             # WebRTC communication
│   │   ├── meeting_rtc_api.js    # Meeting/call handling
│   │   ├── screenShare.js        # Screen sharing
│   │   ├── notifications.js      # Notification system
│   │   ├── avatarCache.js        # Avatar caching
│   │   └── cryptography.js
│   ├── App.jsx                   # Root component
│   ├── App.css                   # Global styles
│   └── main.jsx                  # Vite entry point
│
├── src-tauri/                    # Backend (Rust)
│   ├── src/
│   │   ├── main.rs               # Application entry point
│   │   ├── lib.rs                # Library initialization
│   │   ├── commands.rs           # Tauri IPC commands
│   │   ├── db.rs                 # SQLite database
│   │   ├── crypto.rs             # Encryption & security
│   │   ├── webrtc.js             # WebRTC implementation
│   │   ├── file_transfer.rs      # File transfer protocol
│   │   ├── file_server.rs        # File serving
│   │   ├── discovery.rs          # LAN peer discovery
│   │   ├── signaling.rs          # Signaling server
│   │   ├── screen_capture.rs     # Screen capture functionality
│   │   └── tray.rs               # System tray integration
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json          # Tauri configuration
│   └── build.rs                  # Build script
│
├── public/                       # Static assets
│   └── fonts/
├── dist/                         # Build output (generated)
├── index.html                    # HTML entry point
├── package.json                  # Node.js configuration
├── pnpm-lock.yaml               # Dependency lock file
├── vite.config.js               # Vite configuration
└── README.md                     # This file
```

---

## 🔨 Building for Production

### Build Desktop Application

To create production builds for your platform:

```bash
# For Windows (creates installer)
pnpm tauri build

# On macOS
pnpm tauri build

# On Linux
pnpm tauri build
```

The build artifacts will be created in:
- **Windows**: `src-tauri/target/release/bundle/nsis/` (NSIS installer)
- **macOS**: `src-tauri/target/release/bundle/macos/` (DMG package)
- **Linux**: `src-tauri/target/release/bundle/deb/` (DEB package)

### Build Frontend Only

```bash
pnpm build
```

This generates optimized frontend assets in the `dist/` directory.

---

## 🔍 How It Works

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   PINGO Application                      │
├──────────────────────┬──────────────────────────────────┤
│                      │                                   │
│   FRONTEND (React)   │      BACKEND (Rust/Tauri)        │
│                      │                                   │
│  • UI Components     │  • IPC Commands Handler           │
│  • State Management  │  • Crypto/Encryption             │
│  • WebRTC Client     │  • Database (SQLite)              │
│  • Notifications     │  • File Transfer Protocol         │
│  • File Handling     │  • Screen Capture                 │
│                      │  • LAN Discovery                  │
│                      │  • Signaling Server               │
│                      │  • System Tray                    │
│                      │  • Auto-start                     │
└──────────────────────┴──────────────────────────────────┘
                            ↕
                    IPC Bridge (Tauri)
```

### Data Flow

1. **User Action** → React component captures user interaction
2. **Message Processing** → Data sent to Rust backend via Tauri IPC
3. **Encryption** → Message encrypted using AES-GCM with X25519 keys
4. **Network Transmission** → Encrypted data sent via WebRTC or HTTP
5. **Peer Reception** → Remote peer receives encrypted data
6. **Decryption** → Data decrypted using exchange keys
7. **Database Storage** → Message saved to local SQLite database
8. **UI Update** → React state updated, component re-renders

### Key Communication Protocols

#### 1. **Peer Discovery** (LAN)
- Uses network interface scanning
- Broadcasts presence on local network
- Discovers other PINGO peers

#### 2. **End-to-End Encryption**
- Key Exchange: X25519 elliptic curve
- Message Encryption: AES-GCM-256
- Ensures only sender and receiver can read messages

#### 3. **Real-time Communication** (WebRTC)
- Peer-to-peer data channel
- Video/audio streaming capabilities
- Falls back to signaling server if needed

#### 4. **File Transfer Protocol**
- Chunks large files for transfer
- Checksum verification
- Resume capability for interrupted transfers

---

## 📝 Development Workflow

### Making Changes

1. **Frontend Changes**
   ```bash
   # Edit files in src/
   # Changes auto-reload in dev mode
   ```

2. **Backend Changes**
   ```bash
   # Edit files in src-tauri/src/
   # The app will automatically rebuild and reload
   ```

3. **Configuration Changes**
   ```bash
   # Edit src-tauri/tauri.conf.json
   # Restart dev server: Ctrl+C then pnpm dev
   ```

### Testing

```bash
# Unit tests (when available)
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend tests (when available)
pnpm test
```

### Debugging

- **Frontend**: Open DevTools in the running app (F12 or Ctrl+Shift+I)
- **Backend**: Check console output in terminal where `pnpm dev` is running
- **Logs**: Check `src-tauri/target/debug/` for build artifacts

---

## 🚀 Deployment

### Creating Release Builds

1. **Update Version**
   ```
   Edit package.json and src-tauri/Cargo.toml
   ```

2. **Build Release**
   ```bash
   pnpm tauri build --release
   ```

3. **Code Signing** (Optional but recommended)
   - Windows: Code sign with Microsoft Authenticode
   - macOS: Sign with Apple Developer Certificate
   - Linux: GPG sign

4. **Distribution**
   - Create GitHub releases
   - Upload build artifacts
   - Provide installation instructions

---

## 🐛 Troubleshooting

### Common Issues

#### **"Rust not found"**
```bash
# Reinstall Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Reload environment
$PROFILE  # On PowerShell, or source ~/.bashrc on Linux
```

#### **"Microsoft Build Tools not found" (Windows)**
- Download and install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
- Or install Visual Studio Community with C++ workload

#### **"pnpm not found"**
```bash
# Install pnpm globally
npm install -g pnpm@10.29.3

# Verify
pnpm --version
```

#### **Tauri dev server not starting**
```bash
# Clear cache and reinstall
pnpm install
rm -r src-tauri/target
pnpm dev
```

#### **Database locked errors**
```bash
# Ensure only one instance is running
# Kill all previous instances of Pingo
# Then restart
```

#### **WebRTC connection issues**
- Check firewall settings
- Ensure both peers are on same network or have valid relay servers configured
- Check signaling server connectivity

---

## 📚 Learning Resources

- [Tauri Documentation](https://tauri.app/v1/guides/)
- [React Documentation](https://react.dev)
- [Rust Book](https://doc.rust-lang.org/book/)
- [WebRTC Documentation](https://webrtc.org)
- [SQLite Documentation](https://www.sqlite.org/docs.html)

---

## 🤝 Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is FREE TO USE

---

## 👥 Authors & Maintainers

- **Development Team**: PINGO Contributors

---

## 📞 Support & Feedback

For issues, feature requests, or feedback:
- Open an issue on GitHub
- Check existing issues for solutions
- Read the [Contributing Guide](CONTRIBUTING.md)

---

## 🗺️ Roadmap

- [ ] Cross-platform support (macOS, Linux)
- [ ] Message search functionality
- [ ] User profiles and settings
- [ ] Message reactions and emojis
- [ ] Video/voice calls
- [ ] Future advanced features

---

**Made with ❤️ by the VBMCODER**
