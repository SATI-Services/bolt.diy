# Coolify Live Preview — Proxmox VM Setup Guide

This guide walks through setting up the Coolify live preview integration on a Proxmox VM with an external IP address, from VM creation to a working shareable preview URL.

---

## Prerequisites

- Proxmox VE host with available resources (4+ CPU cores, 8+ GB RAM recommended)
- An external/public IP address assigned to (or routable to) the VM
- A domain name with DNS access (e.g., `yourdomain.com`)
- SSH access to your Proxmox host

---

## 1. Create the Proxmox VM

### Via Proxmox Web UI

1. **Download an ISO**: Go to your Proxmox storage → ISO Images → Download from URL:
   ```
   https://releases.ubuntu.com/24.04/ubuntu-24.04.1-live-server-amd64.iso
   ```

2. **Create VM** (top-right → Create VM):
   - **General**: Name: `coolify`, VM ID: pick one
   - **OS**: Select the Ubuntu 24.04 ISO
   - **System**: BIOS: Default, Machine: q35, Qemu Agent: checked
   - **Disks**: 80 GB minimum (preview containers need space), VirtIO Block
   - **CPU**: 4 cores minimum (type: host for best performance)
   - **Memory**: 8192 MB minimum (16384 recommended)
   - **Network**: Bridge: `vmbr0` (or your external bridge), Model: VirtIO

3. **Start the VM** and complete the Ubuntu Server installation:
   - Set a hostname (e.g., `coolify`)
   - Enable OpenSSH server during install
   - Create your admin user

### Via CLI (alternative)

```bash
# On the Proxmox host
qm create 200 --name coolify --memory 8192 --cores 4 --sockets 1 \
  --cpu host --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single --scsi0 local-lvm:80 \
  --ide2 local:iso/ubuntu-24.04.1-live-server-amd64.iso,media=cdrom \
  --boot order=ide2 --ostype l26 --agent 1

qm start 200
```

---

## 2. Configure Networking

### Assign the External IP

After Ubuntu is installed, configure the static external IP.

```bash
# SSH into the VM
ssh your-user@<vm-ip>

# Edit netplan config
sudo nano /etc/netplan/00-installer-config.yaml
```

```yaml
network:
  version: 2
  ethernets:
    ens18:  # your interface name (check with `ip a`)
      addresses:
        - YOUR_EXTERNAL_IP/24       # e.g., 203.0.113.50/24
      routes:
        - to: default
          via: YOUR_GATEWAY_IP      # e.g., 203.0.113.1
      nameservers:
        addresses:
          - 1.1.1.1
          - 8.8.8.8
```

```bash
sudo netplan apply
```

### If Using NAT Instead of Direct External IP

If your Proxmox host NATs traffic to VMs, configure port forwarding on the Proxmox host:

```bash
# On the Proxmox host — add to /etc/network/interfaces or use iptables
# Forward ports 80, 443, 8000 (Coolify), 9838 (sidecar WS) to the VM

iptables -t nat -A PREROUTING -i vmbr0 -p tcp --dport 80 -j DNAT --to-destination VM_INTERNAL_IP:80
iptables -t nat -A PREROUTING -i vmbr0 -p tcp --dport 443 -j DNAT --to-destination VM_INTERNAL_IP:443
iptables -t nat -A PREROUTING -i vmbr0 -p tcp --dport 8000 -j DNAT --to-destination VM_INTERNAL_IP:8000
iptables -t nat -A PREROUTING -i vmbr0 -p tcp --dport 9838 -j DNAT --to-destination VM_INTERNAL_IP:9838
```

### Firewall Rules

```bash
# On the VM
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 8000/tcp  # Coolify dashboard
sudo ufw allow 9838/tcp  # Sidecar WebSocket
sudo ufw enable
```

---

## 3. Configure DNS

Add these DNS records pointing to your external IP:

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| A | `coolify.yourdomain.com` | `YOUR_EXTERNAL_IP` | Coolify dashboard |
| A | `*.preview.yourdomain.com` | `YOUR_EXTERNAL_IP` | Wildcard for preview containers |

The wildcard record is critical — each preview container gets a subdomain like `bolt-preview-abc123.preview.yourdomain.com`.

**If using Cloudflare**: Set the proxy status to "DNS only" (gray cloud) for the wildcard record, since Coolify handles its own SSL via Traefik.

---

## 4. Install Coolify

```bash
# SSH into the VM
ssh your-user@YOUR_EXTERNAL_IP

# Install Coolify (official one-liner)
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

This installs:
- Docker Engine
- Coolify application
- Traefik reverse proxy (handles SSL/TLS automatically)
- PostgreSQL (Coolify's database)

Wait for the installation to complete (2–5 minutes).

### Access Coolify Dashboard

Open `http://YOUR_EXTERNAL_IP:8000` in your browser and complete the initial setup:

1. Create your admin account
2. Set the instance FQDN to `https://coolify.yourdomain.com`
3. Coolify will automatically configure Traefik and obtain Let's Encrypt certificates

After setup, access the dashboard at `https://coolify.yourdomain.com`.

---

## 5. Configure Coolify for Preview Containers

### Create a Project

1. Go to **Projects** → **+ New**
2. Name it: `bolt-previews`
3. Note the **Project UUID** (visible in the URL: `/project/<uuid>`)

### Get Your Server UUID

1. Go to **Servers** → click your server
2. Note the **Server UUID** from the URL: `/server/<uuid>`

### Generate an API Token

1. Go to **Keys & Tokens** → **API Tokens**
2. Click **+ New Token**
3. Name it: `bolt-diy-integration`
4. Copy the token immediately (it won't be shown again)

### Configure Wildcard Domain

1. Go to **Servers** → your server → **Proxy** tab
2. Ensure Traefik is running
3. Go to **Settings** → set the wildcard domain: `preview.yourdomain.com`

This tells Traefik to route `*.preview.yourdomain.com` traffic to the appropriate containers.

---

## 6. Build and Push the Sidecar Image

### Option A: Use Coolify's Built-in Docker Registry

Coolify can run a Docker registry for you:

1. Go to **Servers** → your server → **Docker Registry**
2. Enable the built-in registry
3. Note the registry URL (typically `YOUR_EXTERNAL_IP:5000` or `registry.yourdomain.com`)

### Option B: Use Any Private Registry

If you have an existing registry, use that instead.

### Build and Push

On any machine with Docker installed (can be the VM itself):

```bash
# Clone or navigate to your bolt.diy repo
cd /path/to/bolt.diy/sidecar

# Build the image
docker build -t preview-sidecar:latest .

# Tag for your registry
# Replace with your actual registry URL
docker tag preview-sidecar:latest registry.yourdomain.com/preview-sidecar:latest

# Push
docker push registry.yourdomain.com/preview-sidecar:latest
```

If building directly on the Coolify VM:

```bash
cd /path/to/bolt.diy/sidecar
docker build -t preview-sidecar:latest .

# If using Coolify's local registry
docker tag preview-sidecar:latest localhost:5000/preview-sidecar:latest
docker push localhost:5000/preview-sidecar:latest
```

---

## 7. Configure bolt.diy

### Environment Variables

Copy or edit your `.env.local` file:

```bash
cd /path/to/bolt.diy
cp .env.example .env.local
```

Add the Coolify configuration:

```env
# Coolify Integration
VITE_COOLIFY_URL=https://coolify.yourdomain.com
VITE_COOLIFY_TOKEN=your_api_token_from_step_5
VITE_COOLIFY_SERVER_UUID=your_server_uuid_from_step_5
VITE_COOLIFY_PROJECT_UUID=your_project_uuid_from_step_5
```

### Via Settings UI (alternative)

If you prefer not to use env vars:

1. Start bolt.diy: `pnpm run dev`
2. Open the app in your browser
3. Go to **Settings** → **Coolify** tab
4. Enter:
   - **Coolify URL**: `https://coolify.yourdomain.com`
   - **API Token**: your token
   - Click **Test Connection** → should show "Connected to Coolify vX.X"
   - Select your **Server** and **Project** from the dropdowns
   - Set **Environment**: `production`
   - Set **Sidecar Image**: `registry.yourdomain.com/preview-sidecar:latest`
   - Enable **Live Preview** toggle
   - Enable **Auto-Provision** toggle
   - Set **Container TTL** as desired (default: 60 minutes)

---

## 8. Configure Traefik for WebSocket Support

The sidecar uses WebSocket on port 9838. Traefik needs to route this properly.

SSH into your Coolify VM and add a custom Traefik configuration:

```bash
# Create a dynamic config file for Traefik
sudo mkdir -p /data/coolify/proxy/dynamic

sudo tee /data/coolify/proxy/dynamic/sidecar-ws.yaml << 'EOF'
# This file is managed by bolt.diy Coolify integration
# It enables WebSocket routing for sidecar containers

http:
  middlewares:
    sidecar-ws-headers:
      headers:
        customRequestHeaders:
          Connection: "Upgrade"
          Upgrade: "websocket"
EOF
```

Traefik will auto-detect this file and reload. Preview containers created by bolt.diy will have their ports (3000 for the dev server, 9838 for the sidecar WebSocket) properly routed via Traefik.

---

## 9. Test the Full Flow

### Manual Test (Phase 2 verification)

1. Create a test application manually in Coolify:
   - Go to **Projects** → `bolt-previews` → **+ New** → **Docker Image**
   - Image: `registry.yourdomain.com/preview-sidecar:latest`
   - Ports: `3000,9838`
   - Add env var: `SIDECAR_TOKEN` = `testtoken123`
   - Deploy

2. Test the sidecar WebSocket connection:
   ```bash
   # Install wscat if needed
   npm install -g wscat

   # Connect to the sidecar
   wscat -c wss://your-app-domain.preview.yourdomain.com:9838

   # Send auth message
   {"type":"auth","token":"testtoken123"}
   # Should receive: {"type":"auth_ok"}

   # Test file write
   {"type":"write_file","path":"index.html","content":"<h1>Hello from bolt.diy!</h1>"}
   # Should receive: {"type":"ok","message":"Written: index.html"}
   ```

3. Delete the test application when done.

### End-to-End Test (Phase 5 verification)

1. Start bolt.diy with Coolify configured
2. Open a new chat session
3. Ask the AI to create a simple React app
4. Watch for:
   - Container auto-provisioning (toast notification: "Coolify preview container is ready")
   - Files syncing to the container (check Coolify dashboard → app logs)
   - The share button appearing in the preview toolbar
5. Click the share button → copies URL to clipboard
6. Open the URL in an incognito window → should show the live app
7. Ask the AI to make a change → should reflect at the shareable URL within seconds

---

## 10. Production Hardening

### SSL/TLS

Coolify handles SSL automatically via Let's Encrypt. Verify:

1. Go to **Settings** → check that Let's Encrypt email is configured
2. Ensure port 80 is open (required for ACME HTTP-01 challenge)
3. Preview URLs will automatically get HTTPS certificates

### Resource Limits

To prevent preview containers from consuming all VM resources, set limits in the Coolify settings or per-application:

```bash
# In the Coolify UI when creating apps, or via API:
# CPU limit: 1 core per container
# Memory limit: 512MB per container
# These can also be set as defaults in Coolify Settings → Server
```

### Container Cleanup

The bolt.diy integration includes automatic cleanup (TTL-based), but you can also set up a cron job as a safety net:

```bash
# On the Coolify VM
sudo crontab -e

# Add: Clean up stopped containers older than 2 hours, every hour
0 * * * * docker container prune -f --filter "until=2h" --filter "label=coolify.managed=true" 2>&1 | logger -t coolify-cleanup
```

### Monitoring

```bash
# Check Docker resource usage
docker stats --no-stream

# Check Traefik logs
docker logs coolify-proxy 2>&1 | tail -50

# Check disk space (preview containers can accumulate)
df -h
```

### Backups

Coolify stores its configuration in `/data/coolify`. Back this up regularly:

```bash
# Add to crontab
0 2 * * * tar czf /backup/coolify-$(date +\%Y\%m\%d).tar.gz /data/coolify 2>&1 | logger -t coolify-backup
```

---

## Troubleshooting

### "Test Connection" fails in bolt.diy settings

- Verify the Coolify URL is accessible from the machine running bolt.diy
- Check that the API token is valid and hasn't expired
- If bolt.diy runs locally and Coolify is remote, ensure no firewall blocks port 443
- Try: `curl -H "Authorization: Bearer YOUR_TOKEN" https://coolify.yourdomain.com/api/v1/version`

### Container stuck in "provisioning"

- Check Coolify dashboard → the application → Deployments tab for errors
- Common cause: sidecar image not found → verify the image is pushed to the registry
- Common cause: port conflict → ensure ports 3000 and 9838 are not already in use
- Check: `docker logs <container_id>` on the Coolify VM

### WebSocket connection fails

- Verify port 9838 is open in the VM firewall
- Check that Traefik is routing WebSocket traffic correctly
- If using Cloudflare, ensure WebSocket support is enabled (it is by default)
- Test directly: `wscat -c wss://your-preview.preview.yourdomain.com:9838`

### Preview URL shows nothing

- The dev server inside the container needs time to start (check sidecar logs)
- Verify files are being synced: check the sidecar container logs for `write_file` messages
- Ensure the AI-generated project has a `dev` script in `package.json`
- Check: `docker exec <container_id> ls /app/` to see if files arrived

### DNS not resolving

- Wildcard DNS records can take time to propagate (up to 48h, usually minutes)
- Test: `dig bolt-preview-test.preview.yourdomain.com`
- Ensure the wildcard `*.preview.yourdomain.com` points to the correct IP

### Out of disk space

- Preview containers create full Node.js projects with `node_modules`
- Reduce container TTL in bolt.diy settings
- Prune unused Docker images: `docker image prune -a -f`
- Prune stopped containers: `docker container prune -f`

---

## Architecture Reference

```
Internet
  │
  ▼
External IP (YOUR_EXTERNAL_IP)
  │
  ▼
Proxmox VM (Ubuntu 24.04)
  │
  ├── Traefik (reverse proxy, auto-SSL)
  │     ├── coolify.yourdomain.com → Coolify Dashboard (:8000)
  │     ├── *.preview.yourdomain.com:443 → Container Dev Server (:3000)
  │     └── *.preview.yourdomain.com:9838 → Container Sidecar WS (:9838)
  │
  ├── Coolify (container orchestrator)
  │     └── Manages preview container lifecycle via API
  │
  └── Preview Containers (one per chat session)
        ├── Sidecar WS Server (:9838) ← receives files from bolt.diy
        └── Dev Server / Vite (:3000) ← serves the preview app
```

```
bolt.diy (browser)
  │
  ├── WebContainer (local HMR preview, unchanged)
  │
  └── CoolifyFileSyncService (WebSocket)
        │
        └──► wss://bolt-preview-xxx.preview.yourdomain.com:9838
               │
               ▼
        Sidecar writes files to /app/ → Vite HMR → shareable URL
```
