use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use crossbeam_channel::{unbounded, Receiver, Sender};
use network_interface::NetworkInterfaceConfig;

const DISCOVERY_PORT: u16 = 15353;
const PEER_TIMEOUT_SECS: u64 = 15;
const ANNOUNCE_INTERVAL_SECS: u64 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PeerInfo {
    pub device_id: String,
    pub username: String,
    pub ip_address: String,
    pub port: u16,
    pub public_key: String,
    pub is_online: bool,
}

#[derive(Clone, Debug)]
struct Peer {
    device_id: String,
    username: String,
    ip_address: String,
    port: u16,
    public_key: String,
    is_online: bool,
    last_seen: Instant,
}

impl From<&Peer> for PeerInfo {
    fn from(peer: &Peer) -> Self {
        Self {
            device_id: peer.device_id.clone(),
            username: peer.username.clone(),
            ip_address: peer.ip_address.clone(),
            port: peer.port,
            public_key: peer.public_key.clone(),
            is_online: peer.is_online,
        }
    }
}

#[derive(Clone, Debug)]
pub enum DiscoveryEvent {
    PeerDiscovered { peer: PeerInfo },
    PeerUpdated { peer: PeerInfo },
    PeerLost { device_id: String },
}

#[derive(Serialize, Deserialize, Debug)]
enum MessageType {
    Hello,
    Bye,
}

#[derive(Serialize, Deserialize, Debug)]
struct DiscoveryPacket {
    msg_type: MessageType,
    peer: PeerInfo,
}

pub struct DiscoveryManager {
    peers: Arc<RwLock<HashMap<String, Peer>>>,
    running: Arc<Mutex<bool>>,
    event_sender: Sender<DiscoveryEvent>,
    event_receiver: Receiver<DiscoveryEvent>,
}

impl DiscoveryManager {
    pub fn new() -> Self {
        let (sender, receiver) = unbounded();
        Self {
            peers: Arc::new(RwLock::new(HashMap::new())),
            running: Arc::new(Mutex::new(false)),
            event_sender: sender,
            event_receiver: receiver,
        }
    }

    pub fn start(&self, device_id: String, username: String, port: u16, public_key: String) -> Result<bool, String> {
        let mut running = self.running.lock().unwrap();
        if *running {
            return Ok(false);
        }

        *running = true;
        let running_clone = self.running.clone();
        let peers = self.peers.clone();
        let event_sender = self.event_sender.clone();
        let local_device_id = device_id.clone();

        // Create UDP socket
        let socket = create_multicast_socket(DISCOVERY_PORT).map_err(|e| e.to_string())?;
        let socket_send = socket.try_clone().map_err(|e| e.to_string())?;
        
        // Prepare local peer info for announcement
        // We set IP to 0.0.0.0 initially, receiver will fill it in
        let local_peer_info = PeerInfo {
            device_id: device_id.clone(),
            username: username.clone(),
            ip_address: "0.0.0.0".to_string(),
            port,
            public_key: public_key.clone(),
            is_online: true,
        };

        println!("Starting UDP discovery on port {}", DISCOVERY_PORT);

        // Spawn listener thread
        let peers_listen = peers.clone();
        let running_listen = running_clone.clone();
        let event_sender_listen = event_sender.clone();
        
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            socket.set_read_timeout(Some(Duration::from_millis(500))).ok();

            while *running_listen.lock().unwrap() {
                match socket.recv_from(&mut buf) {
                    Ok((amt, src_addr)) => {
                        if let Ok(packet) = serde_json::from_slice::<DiscoveryPacket>(&buf[..amt]) {
                            // Ignore own packets
                            if packet.peer.device_id == local_device_id {
                                continue;
                            }

                            match packet.msg_type {
                                MessageType::Hello => {
                                    let mut peers_lock = peers_listen.write().unwrap();
                                    let now = Instant::now();
                                    let ip = src_addr.ip().to_string();
                                    
                                    let mut is_new = false;
                                    let peer = peers_lock.entry(packet.peer.device_id.clone()).or_insert_with(|| {
                                        is_new = true;
                                        Peer {
                                            device_id: packet.peer.device_id.clone(),
                                            username: packet.peer.username.clone(),
                                            ip_address: ip.clone(),
                                            port: packet.peer.port,
                                            public_key: packet.peer.public_key.clone(),
                                            is_online: true,
                                            last_seen: now,
                                        }
                                    });

                                    // Update peer
                                    peer.username = packet.peer.username;
                                    peer.ip_address = ip; // Use source IP
                                    peer.port = packet.peer.port;
                                    peer.public_key = packet.peer.public_key;
                                    peer.is_online = true;
                                    peer.last_seen = now;

                                    let event = if is_new {
                                        DiscoveryEvent::PeerDiscovered { peer: (&*peer).into() }
                                    } else {
                                        DiscoveryEvent::PeerUpdated { peer: (&*peer).into() }
                                    };
                                    let _ = event_sender_listen.send(event);
                                }
                                MessageType::Bye => {
                                    let mut peers_lock = peers_listen.write().unwrap();
                                    if let Some(peer) = peers_lock.get_mut(&packet.peer.device_id) {
                                        peer.is_online = false;
                                        let _ = event_sender_listen.send(DiscoveryEvent::PeerLost {
                                            device_id: packet.peer.device_id.clone(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // Timeout or error, just continue
                    }
                }
            }
        });

        // Spawn announcer thread
        thread::spawn(move || {
            let broadcast_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT);
            
            // Also try common subnet broadcast addresses for better LAN coverage
            let extra_broadcasts: Vec<SocketAddr> = get_local_broadcast_addresses()
                .into_iter()
                .map(|ip| SocketAddr::new(IpAddr::V4(ip), DISCOVERY_PORT))
                .collect();

            println!("[Pingo Discovery] Announcer started. Broadcast targets: {:?} + {:?}", broadcast_addr, extra_broadcasts);
            
            while *running_clone.lock().unwrap() {
                let packet = DiscoveryPacket {
                    msg_type: MessageType::Hello,
                    peer: local_peer_info.clone(),
                };
                
                if let Ok(data) = serde_json::to_vec(&packet) {
                    // Send to global broadcast
                    let _ = socket_send.send_to(&data, broadcast_addr);
                    // Send to all subnet-specific broadcast addresses
                    for addr in &extra_broadcasts {
                        let _ = socket_send.send_to(&data, addr);
                    }
                }

                // Check for stale peers
                {
                    let mut peers_lock = peers.write().unwrap();
                    let now = Instant::now();
                    let timeout = Duration::from_secs(PEER_TIMEOUT_SECS);
                    
                    for (id, peer) in peers_lock.iter_mut() {
                        if peer.is_online && now.duration_since(peer.last_seen) > timeout {
                            peer.is_online = false;
                            let _ = event_sender.send(DiscoveryEvent::PeerLost {
                                device_id: id.clone(),
                            });
                        }
                    }
                }

                thread::sleep(Duration::from_secs(ANNOUNCE_INTERVAL_SECS));
            }

            // Send Bye
            let packet = DiscoveryPacket {
                msg_type: MessageType::Bye,
                peer: local_peer_info,
            };
            if let Ok(data) = serde_json::to_vec(&packet) {
                let _ = socket_send.send_to(&data, broadcast_addr);
            }
        });

        Ok(true)
    }

    pub fn stop(&self) {
        let mut running = self.running.lock().unwrap();
        *running = false;
    }

    pub fn get_peers(&self) -> Vec<PeerInfo> {
        self.peers.read().unwrap().values().map(|p| p.into()).collect()
    }
    
    pub fn get_online_peers(&self) -> Vec<PeerInfo> {
        self.peers.read().unwrap().values()
            .filter(|p| p.is_online)
            .map(|p| p.into())
            .collect()
    }
    
    #[allow(dead_code)]
    pub fn get_peer(&self, device_id: &str) -> Option<PeerInfo> {
        self.peers.read().unwrap().get(device_id).map(|p| p.into())
    }

    #[allow(dead_code)]
    pub fn get_event_receiver(&self) -> Receiver<DiscoveryEvent> {
        self.event_receiver.clone()
    }
    
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }
}

impl Default for DiscoveryManager {
    fn default() -> Self {
        Self::new()
    }
}

fn create_multicast_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    
    // Allow reusing the address so multiple instances can run on the same machine
    socket.set_reuse_address(true)?;
    #[cfg(not(windows))]
    socket.set_reuse_port(true)?; // Only on Unix-like
    
    socket.set_broadcast(true)?;
    
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
    socket.bind(&addr.into())?;
    
    Ok(socket.into())
}

/// Get broadcast addresses for all local network interfaces
/// Uses network_interface crate for accurate enumeration of ALL NICs
fn get_local_broadcast_addresses() -> Vec<Ipv4Addr> {
    let mut addresses = Vec::new();

    // Use the network_interface crate for proper enumeration
    if let Ok(interfaces) = network_interface::NetworkInterface::show() {
        for iface in &interfaces {
            for addr in &iface.addr {
                if let network_interface::Addr::V4(v4) = addr {
                    let ip = v4.ip;
                    if ip.is_loopback() { continue; }
                    // If the interface provides a broadcast address, use it
                    if let Some(bcast) = v4.broadcast {
                        if !addresses.contains(&bcast) && bcast != Ipv4Addr::BROADCAST {
                            addresses.push(bcast);
                        }
                    } else {
                        // Fallback: compute /24 broadcast
                        let octets = ip.octets();
                        if let Some(netmask) = v4.netmask {
                            let mask = netmask.octets();
                            let bcast = Ipv4Addr::new(
                                octets[0] | !mask[0],
                                octets[1] | !mask[1],
                                octets[2] | !mask[2],
                                octets[3] | !mask[3],
                            );
                            if !addresses.contains(&bcast) && bcast != Ipv4Addr::BROADCAST {
                                addresses.push(bcast);
                            }
                        } else {
                            let bcast = Ipv4Addr::new(octets[0], octets[1], octets[2], 255);
                            if !addresses.contains(&bcast) && bcast != Ipv4Addr::BROADCAST {
                                addresses.push(bcast);
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: use the connect() trick if no interfaces found
    if addresses.is_empty() {
        if let Ok(addrs) = local_ip_addresses() {
            for ip in addrs {
                let octets = ip.octets();
                let broadcast = Ipv4Addr::new(octets[0], octets[1], octets[2], 255);
                if !addresses.contains(&broadcast) && broadcast != Ipv4Addr::BROADCAST {
                    addresses.push(broadcast);
                }
            }
        }
    }

    addresses
}

/// Get all local IPv4 addresses (non-loopback)
fn local_ip_addresses() -> Result<Vec<Ipv4Addr>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    
    // Try to find local IPs by connecting to a well-known address
    // This doesn't actually send packets, just determines the route
    let mut ips = Vec::new();
    
    for target in &["8.8.8.8:80", "192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"] {
        if let Ok(()) = socket.connect(*target) {
            if let Ok(local_addr) = socket.local_addr() {
                if let IpAddr::V4(ip) = local_addr.ip() {
                    if !ip.is_loopback() && !ips.contains(&ip) {
                        ips.push(ip);
                    }
                }
            }
        }
    }
    
    Ok(ips)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_local_discovery() {
        let dm1 = DiscoveryManager::new();
        let dm2 = DiscoveryManager::new();
        
        let id1 = "device1".to_string();
        let id2 = "device2".to_string();
        
        let pk1 = "pubkey1".to_string();
        let pk2 = "pubkey2".to_string();
        
        dm1.start(id1.clone(), "User1".to_string(), 1234, pk1.clone()).unwrap();
        dm2.start(id2.clone(), "User2".to_string(), 5678, pk2.clone()).unwrap();
        
        // Wait for discovery
        thread::sleep(Duration::from_secs(4));
        
        // Check if DM1 found DM2
        let peers1 = dm1.get_peers();
        println!("DM1 peers: {:?}", peers1);
        let found_dm2 = peers1.iter().any(|p| p.device_id == id2);
        
        // Check if DM2 found DM1
        let peers2 = dm2.get_peers();
        println!("DM2 peers: {:?}", peers2);
        let found_dm1 = peers2.iter().any(|p| p.device_id == id1);
        
        dm1.stop();
        dm2.stop();
        
        assert!(found_dm2, "DM1 should have found DM2");
        assert!(found_dm1, "DM2 should have found DM1");
    }
}
