# Production deployment manual

This runbook describes the production setup used by femboyz.cloud:

- Ubuntu 26.04 VPS
- system Node.js 22 from apt (`/usr/bin/node`)
- MongoDB 7.0.34 in Docker
- Fastify and SvelteKit managed by systemd
- Nginx as the public reverse proxy
- GitHub Actions deploying verified pushes to `main` over SSH

Commands requiring administration are run from the VPS `ops` account with
`sudo`. Direct root SSH login is not required. The `femboyz` account owns and
runs the application and intentionally has very limited sudo access.

## 1. Runtime layout

```text
/srv/femboyz-cloud                 clean Git checkout, owned by femboyz
/srv/femboyz-cloud/.env.prod       backend secrets, mode 600
/var/lib/femboyz-cloud/storage     uploaded file storage
/etc/femboyz-cloud/                MongoDB Compose configuration and secrets
127.0.0.1:27017                    MongoDB
127.0.0.1:3000                     Fastify API
127.0.0.1:3001                     SvelteKit Node server
Nginx :80/:443                     public entry point
/etc/femboyz-mail/                 Stalwart mail server Compose, secrets, TLS copy
:25                                Stalwart SMTP (Docker-published)
127.0.0.1:8443                     Stalwart HTTPS, behind Nginx as mx.femboyz.cloud
172.30.25.1:53                     unbound resolver for Stalwart
```

The mail server has its own runbook in section 13.

Do not edit tracked files inside `/srv/femboyz-cloud` on the VPS. The deploy
script refuses to deploy over a dirty checkout.

## 2. Create the deployment user

Log in as the administrative user:

```bash
ssh ops@YOUR_SERVER
```

Create the service account if it does not already exist:

```bash
sudo useradd --create-home --shell /bin/bash femboyz
sudo install -d -m 700 -o femboyz -g femboyz /home/femboyz/.ssh
```

The `femboyz` account does not need a fully interactive SSH shell. A deployment
key with `no-pty` or `restrict` can still execute the remote deployment command.
If login prints `PTY allocation request failed`, test command execution instead:

```bash
ssh -i github-actions-deploy femboyz@YOUR_SERVER 'whoami; pwd; git --version'
```

## 3. Install and verify Node.js

Production uses the apt-installed Node.js, not NVM. Verify the exact binaries
that systemd and the deployment script will use:

```bash
/usr/bin/node --version
/usr/bin/npm --version
sudo -u femboyz -H /usr/bin/node --version
sudo -u femboyz -H /usr/bin/npm --version
```

The client uses Vite 8 and requires Node.js 22.12.0 or newer. NVM installed for
`ops` is unrelated to production and should not be referenced by the service
files.

Install the remaining host tools as needed:

```bash
sudo apt update
sudo apt install -y git curl nginx docker.io docker-compose-v2
sudo systemctl enable --now docker
```

## 4. Clone the repository

For a public repository, HTTPS needs no second SSH key:

```bash
sudo install -d -m 755 -o femboyz -g femboyz /srv/femboyz-cloud
sudo -u femboyz -H git clone \
  https://github.com/meadowlarps/femboyz-cloud-node.git \
  /srv/femboyz-cloud
```

If it is already cloned:

```bash
sudo -u femboyz -H git -C /srv/femboyz-cloud status
```

For a private repository, give the VPS a separate read-only GitHub deploy key
and use the `git@github.com:...` remote. Do not reuse the GitHub Actions login
key for repository access.

## 5. Configure MongoDB

### Why MongoDB 7.0.34

MongoDB 8.0 and newer currently have a known TCMalloc incompatibility with
Linux kernel 6.19 and newer. Ubuntu 26.04 uses a newer kernel, so MongoDB 8.x
exits during startup. This setup pins `mongo:7.0.34` until upstream publishes a
supported fix:

- <https://www.mongodb.com/docs/manual/release-notes/8.0/#mongodb-8-0-and-newer-are-incompatible-with-kernel-6-19>

Do not work around this with the old `mongo:8.0.4` image or by downgrading the
Ubuntu kernel.

### Create MongoDB secrets

Generate two different hexadecimal passwords and store them in a password
manager:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

The first is the MongoDB root password. The second is the restricted
`femboyz_app` password.

Create the configuration directory:

```bash
sudo install -d -m 700 /etc/femboyz-cloud
```

Create `/etc/femboyz-cloud/mongo.env`:

```bash
sudoedit /etc/femboyz-cloud/mongo.env
```

```dotenv
MONGO_INITDB_ROOT_USERNAME=mongo_admin
MONGO_INITDB_ROOT_PASSWORD=REPLACE_WITH_ROOT_PASSWORD
MONGO_APP_PASSWORD=REPLACE_WITH_APP_PASSWORD
```

Secure it:

```bash
sudo chown root:root /etc/femboyz-cloud/mongo.env
sudo chmod 600 /etc/femboyz-cloud/mongo.env
```

Create `/etc/femboyz-cloud/mongo-init.js`:

```bash
sudoedit /etc/femboyz-cloud/mongo-init.js
```

```javascript
const adminDb = db.getSiblingDB("admin")

adminDb.createUser({
    user: "femboyz_app",
    pwd: process.env.MONGO_APP_PASSWORD,
    roles: [
        {
            role: "readWrite",
            db: "femboyz"
        }
    ]
})
```

The script contains no password and must be readable inside the container:

```bash
sudo chown root:root /etc/femboyz-cloud/mongo-init.js
sudo chmod 644 /etc/femboyz-cloud/mongo-init.js
```

Create `/etc/femboyz-cloud/mongo.compose.yml`:

```bash
sudoedit /etc/femboyz-cloud/mongo.compose.yml
```

```yaml
name: femboyz-cloud

services:
  mongodb:
    image: mongo:7.0.34
    container_name: femboyz-mongodb
    restart: unless-stopped
    ports:
      - "127.0.0.1:27017:27017"
    env_file:
      - /etc/femboyz-cloud/mongo.env
    volumes:
      - mongo_data:/data/db
      - /etc/femboyz-cloud/mongo-init.js:/docker-entrypoint-initdb.d/10-app-user.js:ro

volumes:
  mongo_data:
```

```bash
sudo chown root:root /etc/femboyz-cloud/mongo.compose.yml
sudo chmod 600 /etc/femboyz-cloud/mongo.compose.yml
```

MongoDB is bound only to localhost. Do not expose port 27017 through UFW or the
VPS provider firewall.

### Start MongoDB

```bash
sudo docker compose \
  -f /etc/femboyz-cloud/mongo.compose.yml \
  config --quiet

sudo docker compose \
  -f /etc/femboyz-cloud/mongo.compose.yml \
  pull

sudo docker compose \
  -f /etc/femboyz-cloud/mongo.compose.yml \
  up -d
```

Check it:

```bash
sudo docker ps --filter name=femboyz-mongodb
sudo docker logs --tail 100 femboyz-mongodb
sudo docker exec femboyz-mongodb mongod --version
```

The version should be 7.0.34.

### Test MongoDB authentication

Test the restricted account without putting its password in shell history:

```bash
sudo docker exec -it femboyz-mongodb \
  mongosh \
  --quiet \
  --host 127.0.0.1 \
  --username femboyz_app \
  --authenticationDatabase admin \
  --password \
  --eval 'db.runCommand({ ping: 1 })'
```

Enter the application password. Expected output:

```text
{ ok: 1 }
```

Initialization variables and `/docker-entrypoint-initdb.d` scripts run only
when the MongoDB data volume is empty. Editing `mongo.env` later does not change
live database passwords.

### Repair or rotate the application password

First verify the root login and list users:

```bash
sudo docker exec -it femboyz-mongodb \
  mongosh \
  --quiet \
  --username mongo_admin \
  --authenticationDatabase admin \
  --password \
  --eval 'db.getSiblingDB("admin").getUsers().forEach(user => print(user.user))'
```

Then read a new password and create or update the application user:

```bash
read -rsp "New application password: " NEW_APP_PASSWORD
echo

sudo docker exec \
  -it \
  -e NEW_APP_PASSWORD="$NEW_APP_PASSWORD" \
  femboyz-mongodb \
  mongosh \
  --quiet \
  --username mongo_admin \
  --authenticationDatabase admin \
  --password \
  --eval '
    const adminDb = db.getSiblingDB("admin")
    const existing = adminDb.getUser("femboyz_app")

    if (existing) {
        adminDb.changeUserPassword(
            "femboyz_app",
            process.env.NEW_APP_PASSWORD
        )
        print("Updated femboyz_app password")
    } else {
        adminDb.createUser({
            user: "femboyz_app",
            pwd: process.env.NEW_APP_PASSWORD,
            roles: [{ role: "readWrite", db: "femboyz" }]
        })
        print("Created femboyz_app")
    }
  '

unset NEW_APP_PASSWORD
```

Update the same application password in both:

```text
/etc/femboyz-cloud/mongo.env
/srv/femboyz-cloud/.env.prod
```

The init script reads `MONGO_APP_PASSWORD` from `mongo.env`, so it does not need
to be edited during rotation.

### Rotate the MongoDB root password

Authenticate with the current root password while supplying the new one through
a temporary environment variable:

```bash
read -rsp "New MongoDB root password: " NEW_ROOT_PASSWORD
echo

sudo docker exec \
  -it \
  -e NEW_ROOT_PASSWORD="$NEW_ROOT_PASSWORD" \
  femboyz-mongodb \
  mongosh \
  --quiet \
  --username mongo_admin \
  --authenticationDatabase admin \
  --password \
  --eval '
    db.getSiblingDB("admin").changeUserPassword(
        "mongo_admin",
        process.env.NEW_ROOT_PASSWORD
    )
    print("Updated mongo_admin password")
  '

unset NEW_ROOT_PASSWORD
```

Update `MONGO_INITDB_ROOT_PASSWORD` in
`/etc/femboyz-cloud/mongo.env` afterward. Editing that file alone does not
change the live root password.

### Clean MongoDB reset

The following is only for a new installation with no real data. It permanently
deletes the MongoDB database volume:

```bash
sudo systemctl stop femboyz-api.service

sudo docker compose \
  -f /etc/femboyz-cloud/mongo.compose.yml \
  down

sudo docker volume rm femboyz-cloud_mongo_data

sudo docker compose \
  -f /etc/femboyz-cloud/mongo.compose.yml \
  up -d
```

Never run `docker compose down -v` or remove this volume after production data
exists. A Docker volume provides persistence, not a backup.

## 6. Configure application storage and environment

Keep uploaded blobs outside the Git checkout:

```bash
sudo install -d \
  -m 750 \
  -o femboyz \
  -g femboyz \
  /var/lib/femboyz-cloud/storage
```

Create the ignored production environment without truncating it if it already
exists:

```bash
sudo -u femboyz -H touch /srv/femboyz-cloud/.env.prod
sudo chmod 600 /srv/femboyz-cloud/.env.prod
sudoedit /srv/femboyz-cloud/.env.prod
```

Example configuration:

```dotenv
CURR_ENV=PRODUCTION

MDB_URI=mongodb://femboyz_app:REPLACE_WITH_APP_PASSWORD@127.0.0.1
MDB_PORT=27017
MDB_NAME=femboyz
MDB_COLLECTION_UPLOADS=uploads

WEBSRV_PORT=3000

MAX_FILE_SIZE=104857600
MIN_FILE_SIZE=1
MAX_FILE_COUNT_PER_UPLOAD=6
MAX_TITLE_LENGTH_PER_UPLOAD=255
MAX_DESC_LENGTH_PER_UPLOAD=1024

STORAGE_DIR=/var/lib/femboyz-cloud/storage
STORAGE_LIMIT_BYTES=REPLACE_WITH_LIMIT_IN_BYTES
STORAGE_USAGE_WARNING_PERCENTAGE=80
EMPTY_STORAGE_DIR_ON_STARTUP=false

BASE_URL=https://YOUR_DOMAIN
SITE_NAME=femboyz.cloud
CORS_ORIGIN=https://YOUR_DOMAIN

AUTH_ADMIN_KEY=REPLACE_WITH_RANDOM_ADMIN_KEY
```

Generate the admin key separately:

```bash
openssl rand -hex 32
```

Do not include the port in `MDB_URI`; the application appends `MDB_PORT`. The
MongoDB application user is created in `admin`, which is the default
authentication database when the URI has credentials but no database path.

Confirm permissions:

```bash
sudo chown femboyz:femboyz /srv/femboyz-cloud/.env.prod
sudo chmod 600 /srv/femboyz-cloud/.env.prod
```

## 7. Initial install and build

```bash
sudo -u femboyz -H bash -lc '
  cd /srv/femboyz-cloud
  /usr/bin/npm ci
  /usr/bin/npm run build
  /usr/bin/npm --prefix client ci
  /usr/bin/npm --prefix client run build
'
```

Verify output:

```bash
sudo -u femboyz test -f /srv/femboyz-cloud/dist/index.js
sudo -u femboyz test -f /srv/femboyz-cloud/client/build/index.js
```

## 8. Install systemd services

The installed unit files belong in `/etc/systemd/system`. Leave the templates
inside the Git checkout unchanged.

```bash
sudo cp \
  /srv/femboyz-cloud/deploy/femboyz-api.service \
  /etc/systemd/system/femboyz-api.service
```

Install the web unit while replacing its domain placeholder:

```bash
DOMAIN=YOUR_DOMAIN

sed "s|https://example.com|https://${DOMAIN}|" \
  /srv/femboyz-cloud/deploy/femboyz-web.service | \
  sudo tee /etc/systemd/system/femboyz-web.service >/dev/null
```

Both units intentionally execute the system Node binary:

```bash
grep ExecStart /etc/systemd/system/femboyz-*.service
```

Expected paths begin with `/usr/bin/node`.

Enable the units:

```bash
sudo systemctl daemon-reload
sudo systemctl enable femboyz-api.service femboyz-web.service
```

Allow only the exact restart operation needed by CI:

```bash
sudo visudo -f /etc/sudoers.d/femboyz-deploy
```

```text
femboyz ALL=(root) NOPASSWD: /usr/bin/systemctl restart femboyz-api.service femboyz-web.service
```

Validate it:

```bash
sudo visudo -cf /etc/sudoers.d/femboyz-deploy
```

Start and inspect the applications:

```bash
sudo systemctl start femboyz-api.service femboyz-web.service
sudo systemctl status femboyz-api.service --no-pager
sudo systemctl status femboyz-web.service --no-pager
curl --fail http://127.0.0.1:3000/ping
curl --fail http://127.0.0.1:3001/
```

Logs:

```bash
sudo journalctl -u femboyz-api.service -n 100 --no-pager
sudo journalctl -u femboyz-web.service -n 100 --no-pager
```

MongoDB credentials must never appear in these logs.

## 9. Install Nginx

Generate the installed configuration while leaving the repository template
clean:

```bash
DOMAIN=YOUR_DOMAIN

sed "s|server_name example.com;|server_name ${DOMAIN};|" \
  /srv/femboyz-cloud/deploy/nginx.conf | \
  sudo tee /etc/nginx/sites-available/femboyz-cloud >/dev/null

sudo ln -s \
  /etc/nginx/sites-available/femboyz-cloud \
  /etc/nginx/sites-enabled/femboyz-cloud

sudo nginx -t
sudo systemctl reload nginx
```

The raw-file location regex must remain quoted because Nginx otherwise parses
the `{3}` and `{4}` quantifiers as configuration braces:

```nginx
location ~ "^/[0-9]{3}[0-9A-Z][A-Z]{4}/[0-9]+$" {
```

Bare upload IDs use content negotiation. Requests with
`Accept: application/json` are sent to Fastify for MiniUpload metadata; normal
browser navigation is sent to SvelteKit for the upload page. Keep both the
bare-ID location and its `@upload_json` named location from the checked-in
template.

Test HTTP:

```bash
curl --fail "http://${DOMAIN}/ping"
curl --fail "http://${DOMAIN}/"
```

After DNS points to the VPS, install a certificate with the preferred ACME
client. One option is Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d "${DOMAIN}"
```

The systemd `ORIGIN`, backend `BASE_URL`, and Nginx public hostname must all
refer to the same HTTPS origin.

## 10. Configure deployment SSH

Generate a dedicated key on a trusted local machine:

```bash
ssh-keygen -t ed25519 -f github-actions-deploy -C github-actions-deploy
```

Install only its public key on the VPS:

```bash
ssh-copy-id -i github-actions-deploy.pub femboyz@YOUR_SERVER
```

The private key becomes the GitHub `DEPLOY_SSH_KEY` secret. Never commit it.

Collect the VPS ED25519 host key:

```bash
ssh-keyscan -t ed25519 -H YOUR_SERVER 2>/dev/null
```

Before trusting it, compare fingerprints.

On the VPS:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the trusted local machine:

```bash
ssh-keyscan -t ed25519 YOUR_SERVER 2>/dev/null | ssh-keygen -lf -
```

Store the verified complete `ssh-ed25519` known-hosts line as the GitHub
`DEPLOY_KNOWN_HOSTS` secret. Lines beginning with `#` are comments and are not
included. Do not run `ssh-keyscan` dynamically during every deployment; doing
so would trust whichever host answered at that moment.

## 11. Configure GitHub Actions

Create a GitHub environment named `production` and add:

- `DEPLOY_HOST`: VPS hostname or IP
- `DEPLOY_PORT`: SSH port; omit to use 22
- `DEPLOY_USER`: `femboyz`
- `DEPLOY_SSH_KEY`: complete private deployment key
- `DEPLOY_KNOWN_HOSTS`: verified ED25519 known-hosts line

The workflow:

1. Checks out the pushed `main` commit.
2. Runs backend tests with Node.js 22.
3. Runs client checks and the production build.
4. Creates a temporary `~/.ssh` directory on the GitHub runner from secrets.
5. Connects to the VPS as `femboyz` and passes the verified commit SHA.
6. The VPS fetches and fast-forwards only if `origin/main` is still that SHA.
7. It installs dependencies, builds, restarts both services, and performs local
   health checks.

The runner's SSH key only logs into the VPS. It is not forwarded. If the GitHub
repository is private, the VPS needs its own separate read-only repository key
for `git fetch`.

Test the deployment account before relying on CI:

```bash
ssh -i github-actions-deploy femboyz@YOUR_SERVER \
  '/usr/bin/node --version && \
   /usr/bin/npm --version && \
   git -C /srv/femboyz-cloud status --short && \
   sudo -n /usr/bin/systemctl restart femboyz-api.service femboyz-web.service'
```

There should be no Git status output and no sudo password prompt.

## 12. Operations and troubleshooting

### Deployment checkout is dirty

Inspect it; do not reset blindly:

```bash
sudo -u femboyz -H git -C /srv/femboyz-cloud status --short
```

Installed Nginx and systemd files belong under `/etc`, and application secrets
belong in ignored `.env.prod`, so normal production setup should not modify
tracked files.

### SSH has no prompt

`PTY allocation request failed` is acceptable for the deployment account.
GitHub uses command execution, not an interactive prompt:

```bash
ssh -i github-actions-deploy femboyz@YOUR_SERVER 'whoami'
```

Use `ops` with `sudo` for human administration. Do not enable direct root SSH
just for deployment.

### Nginx reports an unknown regex directive

Ensure the upload-ID regex in the installed site is quoted:

```nginx
location ~ "^/[0-9]{3}[0-9A-Z][A-Z]{4}/[0-9]+$" {
```

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### MiniUpload reports `Unexpected token '<'`

This means its JSON metadata request received the SvelteKit HTML document. The
installed Nginx site is missing the bare upload-ID content-negotiation block
from `deploy/nginx.conf`. Reinstall the generated Nginx configuration, test,
and reload it:

```bash
DOMAIN=YOUR_DOMAIN

sed "s|server_name example.com;|server_name ${DOMAIN};|" \
  /srv/femboyz-cloud/deploy/nginx.conf | \
  sudo tee /etc/nginx/sites-available/femboyz-cloud >/dev/null

sudo nginx -t
sudo systemctl reload nginx
```

Verify both representations of one real upload ID:

```bash
curl --fail -H 'Accept: application/json' \
  "https://${DOMAIN}/8040JNZU"

curl --fail -H 'Accept: text/html' \
  "https://${DOMAIN}/8040JNZU" >/dev/null
```

### MongoDB authentication fails

Changing `mongo.env` does not rotate existing database users. Authenticate as
`mongo_admin` and use the password rotation procedure in section 5. If even
root authentication fails and this is still a new empty installation, correct
the configuration and perform the documented clean reset.

### MongoDB 8.x reports kernel incompatibility

Confirm `/etc/femboyz-cloud/mongo.compose.yml` contains:

```yaml
image: mongo:7.0.34
```

Then pull and recreate the container without deleting the data volume:

```bash
sudo docker compose -f /etc/femboyz-cloud/mongo.compose.yml pull
sudo docker compose -f /etc/femboyz-cloud/mongo.compose.yml up -d
```

### Service fails after deployment

```bash
sudo systemctl status femboyz-api.service --no-pager
sudo systemctl status femboyz-web.service --no-pager
sudo journalctl -u femboyz-api.service -n 100 --no-pager
sudo journalctl -u femboyz-web.service -n 100 --no-pager
sudo docker logs --tail 100 femboyz-mongodb
```

### Backups

The upload storage directory and MongoDB named volume are separate and both
must be backed up. A Docker volume is not a backup. Establish recurring,
off-server backups before treating the deployment as production-ready.

## 13. Mail server (Stalwart)

Stalwart 0.16 receives mail for `@femboyz.cloud`. It is configured like
MongoDB: a root-owned Compose stack in `/etc/femboyz-mail/`, driven from `ops`
with `sudo`. There is no extra login user, and it doesn't run as `femboyz`.
The container runs as its own UID 2000. The overall design and the decisions
behind it are in `MAIL_PLAN.md`.

```text
/etc/femboyz-mail/docker-compose.yml   from deploy/mail/docker-compose.yml (600)
/etc/femboyz-mail/stalwart.env         STALWART_RECOVERY_ADMIN, empty normally (600)
/etc/femboyz-mail/tls/                 copy of the mx cert for UID 2000 (700)
/etc/nginx/sites-available/femboyz-mx  from deploy/mail/nginx-mx.conf
/etc/letsencrypt/renewal-hooks/deploy/femboyz-mail.sh
/etc/unbound/unbound.conf.d/femboyz-mail.conf
docker volumes femboyz-mail_stalwart_etc   config.json (data store pointer)
               femboyz-mail_stalwart_data  RocksDB: all settings, accounts, mail
```

| Port | Bound to | Purpose |
|---|---|---|
| 25 | all interfaces (Docker) | inbound SMTP |
| 443 in container | `127.0.0.1:8443` | JMAP, OAuth, WebUI; Nginx proxies `mx.femboyz.cloud` to it |
| 8080 in container | not published | bootstrap and recovery listener only, `http://172.30.25.10:8080` |
| 465, 993, 995, 4190 in container | not published | later phases |

Docker-published ports bypass UFW, so nothing that should stay private may
appear under `ports:` without `127.0.0.1:`.

Everything except `config.json` lives in the database and is changed through
the WebUI (`https://mx.femboyz.cloud/admin`) or the JMAP API.
`deploy/mail/stwjmap.py` is a small JMAP client used below. It reads the user
from `STW_USER` and prompts for the password.

### 13.1 Prerequisites

Already done in phase 0 (see `MAIL_PLAN.md`):

- Hetzner unblocked outbound port 25.
- PTR of `167.233.218.194` → `mx.femboyz.cloud` (Hetzner Cloud console).
- Namecheap: Mail Settings → **Custom MX**, `MX @ → mx.femboyz.cloud` (10),
  `A mx` and `A mail` → `167.233.218.194`. The VPS has no IPv6, so no AAAA.

```bash
dig +short MX femboyz.cloud          # 10 mx.femboyz.cloud.
dig +short -x 167.233.218.194        # mx.femboyz.cloud.
```

### 13.2 Resolver

DNS blocklists (Spamhaus, DNSWL, ...) refuse queries from shared resolvers
like Hetzner's, which silently turns those spam checks off. Stalwart resolves
through a local unbound instead, reached on the mail bridge gateway:

```bash
sudo apt install -y unbound
sudo install -m 644 /srv/femboyz-cloud/deploy/mail/unbound-femboyz-mail.conf \
  /etc/unbound/unbound.conf.d/femboyz-mail.conf
sudo unbound-checkconf && sudo systemctl restart unbound

sudo ufw allow in on br-fbzmail from 172.30.25.0/24 to 172.30.25.1 port 53 proto udp comment "stalwart -> unbound"
sudo ufw allow in on br-fbzmail from 172.30.25.0/24 to 172.30.25.1 port 53 proto tcp comment "stalwart -> unbound"
sudo ufw allow 25/tcp comment "smtp (docker publishes it regardless)"
```

### 13.3 Certificate and Nginx

Nginx keeps ports 80/443, and certbot issues the certificate. Stalwart's own
ACME stays off. The Let's Encrypt key is root-only and Stalwart runs as UID
2000, so a deploy hook copies only the mx certificate into
`/etc/femboyz-mail/tls` and restarts Stalwart on every renewal.

Get the certificate with a temporary port-80 vhost:

```bash
printf 'server {\n    listen 80;\n    listen [::]:80;\n    server_name mx.femboyz.cloud;\n    return 404;\n}\n' | \
  sudo tee /etc/nginx/sites-available/femboyz-mx >/dev/null
sudo ln -sf /etc/nginx/sites-available/femboyz-mx /etc/nginx/sites-enabled/femboyz-mx
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --nginx -d mx.femboyz.cloud --key-type ecdsa
```

Install the hook, run it once by hand, then install the real vhost:

```bash
sudo install -d -m 700 /etc/femboyz-mail
sudo install -m 755 /srv/femboyz-cloud/deploy/mail/certbot-deploy-hook.sh \
  /etc/letsencrypt/renewal-hooks/deploy/femboyz-mail.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/femboyz-mail.sh
sudo ls -la /etc/femboyz-mail/tls        # fullchain.pem + privkey.pem, owner 2000

sudo install -m 644 /srv/femboyz-cloud/deploy/mail/nginx-mx.conf \
  /etc/nginx/sites-available/femboyz-mx
sudo nginx -t && sudo systemctl reload nginx
```

The vhost re-encrypts to Stalwart's HTTPS listener and verifies its
certificate. Until Stalwart loads the real certificate (13.6), it presents a
self-signed one and Nginx answers `502`. That is expected during setup.

Test renewal, including the hook, with `sudo certbot renew --dry-run`.

### 13.4 Start Stalwart in bootstrap mode

Pin a recovery admin so bootstrap doesn't print a one-time password into the
logs:

```bash
sudo install -m 600 /srv/femboyz-cloud/deploy/mail/docker-compose.yml \
  /etc/femboyz-mail/docker-compose.yml
echo "STALWART_RECOVERY_ADMIN=recovery:$(openssl rand -hex 24)" | \
  sudo tee /etc/femboyz-mail/stalwart.env >/dev/null
sudo chmod 600 /etc/femboyz-mail/stalwart.env

sudo docker compose -f /etc/femboyz-mail/docker-compose.yml config --quiet
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml pull
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d
sudo docker logs femboyz-stalwart 2>&1 | grep -i bootstrap
```

Expected: `Server started in bootstrap mode ... Port 8080 is open for initial
setup`. Port 8080 is reachable only from the host, at
`http://172.30.25.10:8080`.

### 13.5 Setup wizard

From a trusted machine, tunnel to the bootstrap listener:

```bash
ssh -L 8080:172.30.25.10:8080 ops@femboyz
```

Open `http://localhost:8080/admin` and sign in as `recovery` with the password
from `stalwart.env`. Wizard answers:

| Step | Field | Value |
|---|---|---|
| 1 Server identity | Server hostname | `mx.femboyz.cloud` |
| | Default email domain | `femboyz.cloud` |
| | Automatically obtain TLS certificate | **off** (certbot owns TLS) |
| | Generate email signing keys | on |
| 2 Storage | all four stores | defaults (RocksDB in `/var/lib/stalwart`) |
| 3 Account directory | Directory type | **Internal**. The OIDC directory comes in phase 2, see `MAIL_PLAN.md`. |
| 4 Logging | Log destination | **Console** (Docker captures stdout) |
| 5 DNS management | DNS server type | **Manual** |

The last screen shows the generated `admin@femboyz.cloud` password exactly once.
Store it in the password manager. Then:

```bash
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml restart stalwart
sudo docker logs --tail 50 femboyz-stalwart 2>&1 | grep -E 'listen-start|DKIM'
```

Expected: listeners for smtp 25, https 443, http 8080 and others, plus two
`DKIM signature created` lines (`v1-ed25519-YYYYMMDD`, `v1-rsa-YYYYMMDD`).

The same wizard can be submitted without a browser:
`x:Bootstrap/set` with those fields, against `http://172.30.25.10:8080/jmap/`
as `recovery`. The tracer's JSON type for Console is `Stdout`. The response
holds the admin password, so write it straight to a root-only file. It is not
printed anywhere else.

### 13.6 Post-setup configuration

Run these against the internal listener as the recovery admin, before Nginx
can reach Stalwart. `List` values are maps keyed `"0"`, `"1"`, ....

```bash
cd /srv/femboyz-cloud/deploy/mail
export STW_USER=recovery
J=http://172.30.25.10:8080/jmap/
```

TLS certificate from the hook's copy, default for clients without SNI, client
IP from Nginx's `X-Forwarded-For`, and manual DKIM. Automatic DKIM rotation
needs automatic DNS, which Namecheap-by-hand isn't.

```bash
./stwjmap.py call $J <<'EOF_JMAP'
[
 ["x:Certificate/set", {"create": {"cert": {
   "certificate": {"@type": "File", "filePath": "/etc/stalwart-tls/fullchain.pem"},
   "privateKey": {"@type": "File", "filePath": "/etc/stalwart-tls/privkey.pem"}}}}, "1"],
 ["x:SystemSettings/set", {"update": {"singleton": {"defaultCertificateId": "#cert"}}}, "2"],
 ["x:Http/set", {"update": {"singleton": {"useXForwarded": true}}}, "3"]
]
EOF_JMAP

echo '[["x:Domain/get", {"properties": ["name"]}, "d"]]' | ./stwjmap.py call $J   # domain id
echo '[["x:Domain/set", {"update": {"<DOMAIN_ID>": {"dkimManagement": {"@type": "Manual"}}}}, "4"]]' | \
  ./stwjmap.py call $J
```

Sign Sieve-redirected mail with the femboyz.cloud DKIM key as well:

```bash
echo "[[\"x:SieveUserInterpreter/set\", {\"update\": {\"singleton\": {\"dkimSignDomain\": {\"else\": \"'femboyz.cloud'\"}}}}, \"s\"]]" | \
  ./stwjmap.py call $J
```

Restart so the certificate and HTTP settings load, then check both TLS paths:

```bash
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml restart stalwart
echo | openssl s_client -connect 127.0.0.1:8443 -servername mx.femboyz.cloud 2>/dev/null | \
  openssl x509 -noout -subject -enddate           # CN=mx.femboyz.cloud
echo QUIT | openssl s_client -starttls smtp -connect 167.233.218.194:25 \
  -servername mx.femboyz.cloud -verify_return_error 2>/dev/null | grep 'Verify return'
curl -s https://mx.femboyz.cloud/.well-known/openid-configuration | head -c 200
```

The issuer must be `https://mx.femboyz.cloud` (from `STALWART_PUBLIC_URL`).

### 13.7 System mailboxes and aliases

| Address | Kind | Notes |
|---|---|---|
| `admin@` | internal account, admin role | Created by the wizard. Receives request notifications. Redirects to the admin's personal address (13.9). |
| `postmaster@`, `abuse@`, `dmarc@`, `hostmaster@`, `webmaster@` | aliases of `admin@` | `postmaster` also receives Stalwart's DMARC/TLS reports (Domain `reportAddressUri`) |
| `noreply@` | internal account, user role | Fastify's sender (phase 2). Never read. |

The account ids come from `x:Account/get`; the wizard's admin was `b` and the
domain `b`. Passwords are hashed server-side (argon2id), so they can be sent in
plain text over this local hop. Generate them with `openssl rand -base64 24`
and store them in the password manager.

```bash
echo '[["x:Account/get", {"properties": ["name", "aliases"]}, "a"]]' | ./stwjmap.py call $J

./stwjmap.py call $J <<'EOF_JMAP'
[
 ["x:Account/set", {"update": {"<ADMIN_ID>": {
   "description": "femboyz admin mailbox + Stalwart administrator",
   "aliases": {
     "0": {"name": "postmaster", "domainId": "<DOMAIN_ID>", "enabled": true},
     "1": {"name": "abuse", "domainId": "<DOMAIN_ID>", "enabled": true},
     "2": {"name": "dmarc", "domainId": "<DOMAIN_ID>", "enabled": true},
     "3": {"name": "hostmaster", "domainId": "<DOMAIN_ID>", "enabled": true},
     "4": {"name": "webmaster", "domainId": "<DOMAIN_ID>", "enabled": true}}}}}, "a"],
 ["x:Account/set", {"create": {"noreply": {"@type": "User", "name": "noreply",
   "domainId": "<DOMAIN_ID>", "description": "System sender (Fastify mailer)",
   "roles": {"@type": "User"}, "permissions": {"@type": "Inherit"},
   "encryptionAtRest": {"@type": "Disabled"},
   "credentials": {"0": {"@type": "Password", "secret": "<NOREPLY_PASSWORD>"}}}}}, "n"]
]
EOF_JMAP
```

To reset a password (for example a lost wizard password), update
`"credentials": {"0": {"@type": "Password", "secret": "..."}}` on the account
the same way.

### 13.8 Close the bootstrap listener and remove the recovery admin

Once `https://mx.femboyz.cloud/admin` accepts the admin login:

```bash
echo '[["x:NetworkListener/get", {"properties": ["name", "bind"]}, "l"]]' | ./stwjmap.py call $J
echo '[["x:NetworkListener/set", {"destroy": ["<ID_OF_http_8080>"]}, "d"]]' | ./stwjmap.py call $J

: | sudo tee /etc/femboyz-mail/stalwart.env >/dev/null
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d --force-recreate
sudo docker exec femboyz-stalwart printenv | grep -c STALWART_RECOVERY   # 0
```

`restart` doesn't re-read `env_file`; `up -d --force-recreate` does. From now
on, use `STW_USER=admin@femboyz.cloud` and the default URL
(`https://mx.femboyz.cloud/jmap/`).

### 13.9 Admin redirect

`admin@` forwards a copy of every clean message to the admin's personal
address with a Sieve script, `deploy/mail/admin-redirect.sieve`. It skips
anything the spam filter flagged, and keeps DMARC/TLS reports (`dmarc@`,
`postmaster@`) local. Stalwart sends redirected mail with the **mailbox's own
address** (`admin@femboyz.cloud`) as the envelope sender, so SPF is checked
against femboyz.cloud and bounces come back to admin@.

Activate it only after the DNS records in 13.10 are live. Without SPF/DKIM,
Gmail rejects the forwarded copies.

```bash
cd /srv/femboyz-cloud/deploy/mail
sed 's/REDIRECT_TO/PERSONAL_ADDRESS/' admin-redirect.sieve > /tmp/admin-redirect.sieve
STW_USER=admin@femboyz.cloud ./stwjmap.py sieve redirect-admin /tmp/admin-redirect.sieve --activate
rm /tmp/admin-redirect.sieve
```

`--deactivate` turns it off again. Don't test the spam guard against an
external target: point `REDIRECT_TO` at `noreply@femboyz.cloud`, send a GTUBE
message, and confirm nothing lands in noreply's mailbox.

### 13.10 DNS records at Namecheap

Domain List → femboyz.cloud → **Advanced DNS** → Host Records → Add New Record
→ **TXT Record**. The host field is relative to `femboyz.cloud`. Paste each value
on a single line, without the surrounding quotes. Namecheap splits values
longer than 255 characters itself.

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `v=spf1 mx -all` |
| TXT | `mx` | `v=spf1 a -all` |
| TXT | `v1-ed25519-20261019._domainkey` | `v=DKIM1; k=ed25519; h=sha256; p=D2XHa1B/nU5l2vkG9Hjmmuz4Jd9Jvp3qTwP7Rhht4Bo=` |
| TXT | `v1-rsa-20261019._domainkey` | `v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArD5L2o6hZ+WQBuVJFaD+R+gE68HJKWFZL+c3/6yv6taEhMx83M5WSsfMwLH+nQGEJ0MhDCav5bzoZL3zsihjkGy7eaJ9Ph/lSgQXQ00JUPCgink2pW5qjHxMYHJqgu9FVScAHJlqJZS/ilttIxqPwC2yzOY7HBVV6ZSf6ABR4mVJkdhass2qtqEJ3eCK79yUH0Ntpbk8JOUXP58Q47fFjmMQSitCvAjqCQt/HkNCn5spEjzek8as+c3MpLVKUd7fpO0yjrjRimZvpCr0wL3GCyDibQF7uD3zSuwWuT8QWnx7pYqsyVj1IxWAD15ZTXv+mTurRjQOe8G6hlnjSAP2PwIDAQAB` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@femboyz.cloud` |
| TXT | `_smtp._tls` | `v=TLSRPTv1; rua=mailto:postmaster@femboyz.cloud` |

- The `mx` SPF record covers the HELO name `mx.femboyz.cloud`.
- The DKIM selectors belong to the keys generated on 2026-10-19. On a rebuild,
  take the values from the WebUI (Domains → ⋯ → View DNS Zone file) or with
  `x:Domain/get` and the `dnsZoneFile` property.
- DMARC starts at `p=none`. After a few weeks of clean aggregate reports, go to
  `p=quarantine`, then `p=reject` (phase 4).
- Leave out the records the zone file also lists:
  - TLSA/DANE: Namecheap has no DNSSEC here, and certbot changes the key on
    every renewal.
  - SRV/autoconfig/autodiscover: no IMAP for apps yet.
  - MTA-STS: needs an `mta-sts.femboyz.cloud` vhost first.

Check from anywhere:

```bash
dig +short TXT femboyz.cloud
dig +short TXT mx.femboyz.cloud
dig +short TXT v1-ed25519-20261019._domainkey.femboyz.cloud
dig +short TXT v1-rsa-20261019._domainkey.femboyz.cloud
dig +short TXT _dmarc.femboyz.cloud
```

### 13.11 Verification

- **Inbound:** mail from Gmail and Outlook to `admin@` and `postmaster@`
  arrives in the Inbox. In the WebUI it shows `spf=pass dkim=pass dmarc=pass`
  in `Authentication-Results`.
- **Redirect:** with 13.9 active, the same mail arrives at the personal address,
  not in its spam folder.
- **Outbound:** send from `noreply@` to the address mail-tester.com gives you.
  Expect SPF, DKIM and DMARC to pass and a 9/10 or better.
- **Logs:** `sudo docker logs --since 10m femboyz-stalwart 2>&1 | grep -E 'WARN|ERROR'`

### 13.12 Operations

Upgrade. `v0.16` follows patch releases. Read the changelog first.

```bash
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml pull
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d
sudo docker logs --tail 30 femboyz-stalwart
```

Recovery mode, when no admin can sign in. It also re-opens the 8080 listener:

```bash
echo "STALWART_RECOVERY_ADMIN=recovery:$(openssl rand -hex 24)" | sudo tee /etc/femboyz-mail/stalwart.env >/dev/null
echo "STALWART_RECOVERY_MODE=1" | sudo tee -a /etc/femboyz-mail/stalwart.env >/dev/null
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d --force-recreate
# fix things at http://172.30.25.10:8080 (ssh -L 8080:172.30.25.10:8080 ops@femboyz)
: | sudo tee /etc/femboyz-mail/stalwart.env >/dev/null
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d --force-recreate
```

`STALWART_RECOVERY_MODE` stops the MTA, so mail isn't accepted while it is on.
`STALWART_RECOVERY_ADMIN` alone works in normal mode too, for example to
promote an account.

Backups run nightly to S3. See 13.13.


### 13.13 Backups (restic → Hetzner Object Storage)

A systemd timer runs `femboyz-mail-backup` nightly at 03:30 UTC. The script:

1. pauses the API when accounts are enabled, then stops Stalwart (RocksDB must
   not be copied while it is written);
2. dumps MongoDB, then backs up the two mail volumes, `/etc/femboyz-mail`, the
   dump, `.env.prod` and `oidc-jwks.json` with restic to
   `s3:https://fsn1.your-objectstorage.com/femboyz-cloud-bucket/femboyz-mail`;
3. starts Stalwart and the API again, including on failure;
4. keeps 7 daily, 4 weekly and 6 monthly snapshots;
5. on Sundays, also re-reads 10% of the stored data to check it.

Mail and account operations pause during the dump and snapshot. Sending servers
retry. Stopping both writers keeps account records and mailboxes consistent.

restic encrypts the data before it uploads, so the bucket only ever holds
ciphertext. The repository password is in `/etc/femboyz-mail/restic-password`
and **must also be in the password manager**. Without it, the backups can't be
decrypted.

| File | Purpose |
|---|---|
| `/usr/local/sbin/femboyz-mail-backup` | from `deploy/mail/backup.sh` |
| `/etc/systemd/system/femboyz-mail-backup.{service,timer}` | from `deploy/mail/` |
| `/etc/femboyz-mail/backup.env` | repository URL and S3 keys (600), see `backup.env.example` |
| `/etc/femboyz-mail/restic-password` | repository password (600), not backed up |

Install:

```bash
sudo apt install -y restic
sudo install -m 755 /srv/femboyz-cloud/deploy/mail/backup.sh /usr/local/sbin/femboyz-mail-backup
sudo install -m 644 /srv/femboyz-cloud/deploy/mail/femboyz-mail-backup.service \
  /srv/femboyz-cloud/deploy/mail/femboyz-mail-backup.timer /etc/systemd/system/
openssl rand -base64 33 | sudo install -m 600 /dev/stdin /etc/femboyz-mail/restic-password
sudo install -m 600 /srv/femboyz-cloud/deploy/mail/backup.env.example /etc/femboyz-mail/backup.env
sudoedit /etc/femboyz-mail/backup.env          # access key only
sudo femboyz-mail-backup set-secret            # prompts for the S3 secret key
sudo femboyz-mail-backup init
sudo femboyz-mail-backup                       # first backup
sudo systemctl daemon-reload
sudo systemctl enable --now femboyz-mail-backup.timer
```

Check:

```bash
systemctl list-timers femboyz-mail-backup.timer
sudo journalctl -u femboyz-mail-backup.service -n 30 --no-pager
sudo femboyz-mail-backup restic snapshots
```

Restore drill (done 2026-10-19). Boot a throwaway Stalwart from the latest
snapshot. Recovery mode keeps its MTA off, and an internal network keeps it
off the internet:

```bash
sudo femboyz-mail-backup restic restore latest --tag stalwart --target /tmp/stw-restore
R=/tmp/stw-restore/var/lib/docker/volumes
sudo docker network create --internal stw-drill
sudo docker run -d --name stw-drill --network stw-drill \
  -e STALWART_RECOVERY_MODE=1 -e STALWART_RECOVERY_ADMIN=drill:CHANGE_ME \
  -v $R/femboyz-mail_stalwart_etc/_data:/etc/stalwart \
  -v $R/femboyz-mail_stalwart_data/_data:/var/lib/stalwart \
  stalwartlabs/stalwart:v0.16
# x:Account/get against http://<container-ip>:8080/jmap/ as drill should list admin@ and noreply@
sudo docker rm -f stw-drill && sudo docker network rm stw-drill && sudo rm -rf /tmp/stw-restore
```

Real restore after losing the server:

1. Rebuild per 13.2–13.4, but don't run the wizard.
2. Stop Stalwart.
3. `restic restore` the snapshot.
4. Copy the two `_data` directories into the new volumes, `chown -R 2000:2000` them, and start Stalwart.
5. `/etc/femboyz-mail` from the snapshot has the old compose file and TLS copy.

## 14. femboyz accounts (OIDC provider)

The API is also the account system: users, invites, the `/login` page and an
OIDC provider at `https://femboyz.cloud/oidc`. Stalwart authenticates mailbox
users against that provider. The plan and the reasoning are in `MAIL_PLAN.md`
section 2. Everything is off until `OIDC_ISSUER` is set, so the code can ship
before this runbook is done.

Order matters. Once Stalwart's directory is switched to OIDC (14.6), it
refuses **every** username + password login for internal accounts, including
`admin@` and `noreply@`. API keys, app passwords and the recovery admin keep
working, so create those first.

### 14.1 Credentials in Stalwart (before the switch)

Run as `admin@femboyz.cloud` against the normal URL, as in 13.6. Find the
account and domain ids with `x:Account/get` and `x:Domain/get`.

1. **Service account** for the API. It has no password: an admin gives it an
   API key. `impersonate` lets it manage Sieve scripts on user accounts.

   ```bash
   cd /srv/femboyz-cloud/deploy/mail
   export STW_USER=admin@femboyz.cloud
   ./stwjmap.py call <<'EOF_JMAP'
   [["x:Account/set", {"create": {"svc": {"@type": "User", "name": "femboyz-api",
     "domainId": "<DOMAIN_ID>", "description": "femboyz-cloud-node account management (API key only)",
     "roles": {"@type": "User"}, "encryptionAtRest": {"@type": "Disabled"},
     "permissions": {"@type": "Merge", "disabledPermissions": {}, "enabledPermissions": {
       "impersonate": true, "sysAccountCreate": true, "sysAccountUpdate": true,
       "sysAccountDestroy": true, "sysAccountGet": true, "sysAccountQuery": true, "sysDomainGet": true}}}}}, "s"]]
   EOF_JMAP
   ```

2. **Keys.** The response to each create holds the secret once. Write it
   straight into the password manager.

   ```bash
   # API key for the service account -> STALWART_API_KEY
   echo '[["x:ApiKey/set", {"accountId": "<SVC_ID>", "create": {"k": {"description": "femboyz-cloud-node", "permissions": {"@type": "Inherit"}}}}, "k"]]' | ./stwjmap.py call
   # app password for noreply@ -> SMTP_PASS
   echo '[["x:AppPassword/set", {"accountId": "<NOREPLY_ID>", "create": {"a": {"description": "femboyz-cloud-node SMTP", "permissions": {"@type": "Inherit"}}}}, "a"]]' | ./stwjmap.py call
   # API key for admin@ itself: the runbook's login after the switch (STW_TOKEN=- prompts for it)
   echo '[["x:ApiKey/set", {"accountId": "<ADMIN_ID>", "create": {"k": {"description": "runbook", "permissions": {"@type": "Inherit"}}}}, "k"]]' | ./stwjmap.py call
   ```

   API keys start with `API_`, app passwords with `app`. An admin can still
   create both after the switch, so a lost key is replaceable.

3. **Submission port.** `deploy/mail/docker-compose.yml` publishes
   `127.0.0.1:465` for the mailer. Copy it to `/etc/femboyz-mail/` and run
   `sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d`.

### 14.2 Application environment

Add to `/srv/femboyz-cloud/.env.prod`. Generate each secret separately with
`openssl rand -hex 32`.

```env
OIDC_ISSUER=https://femboyz.cloud/oidc
OIDC_JWKS_FILE=/srv/femboyz-cloud/oidc-jwks.json
OIDC_COOKIE_KEYS=REPLACE_WITH_RANDOM_HEX
OIDC_CLIENT_WEB_SECRET=REPLACE_WITH_RANDOM_HEX
EMAIL_CODE_SECRET=REPLACE_WITH_RANDOM_HEX
STALWART_URL=https://mx.femboyz.cloud
STALWART_RESOURCE=https://mx.femboyz.cloud
STALWART_API_KEY=API_...
STALWART_WEBHOOK_SECRET=REPLACE_WITH_RANDOM_HEX
SMTP_HOST=127.0.0.1
SMTP_PORT=465
SMTP_TLS_SERVERNAME=mx.femboyz.cloud
SMTP_USER=noreply@femboyz.cloud
SMTP_PASS=app...
```

The Bulwark client (`OIDC_CLIENT_BULWARK_*`) is configured in section 15.

- `OIDC_JWKS_FILE` holds the provider's private signing key. The API creates
  it on first start (mode 600). It is ignored by Git; back it up with the other
  secrets.
- Install the updated `deploy/mail/backup.sh` as `/usr/local/sbin/femboyz-mail-backup`.
  Once the signing key exists, the nightly encrypted restic snapshot also includes
  a MongoDB dump, `.env.prod`, and `oidc-jwks.json`. Run a backup after enabling
  accounts and test restoring the dump and signing keys.
- **Rotating the signing key:** `npm run oidc:keygen` prints a new key. Put it
  first in `keys`, restart, and remove the old entry a day later. Tokens signed
  with the old key stay valid until then.
- **Rotating cookie keys:** put the new key first in `OIDC_COOKIE_KEYS`
  (comma-separated) and keep the old one second for a month.

### 14.3 Nginx

Add the `/oidc/` and `/api/v2/account/stalwart/webhook` locations from
`deploy/nginx.conf` to the HTTPS server in
`/etc/nginx/sites-available/femboyz-cloud`. Certbot edited that file, so copy
the two blocks rather than regenerating it. The webhook location only allows
`172.30.25.0/24`, the mail bridge. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 14.4 Deploy and smoke-test

Merge to `main`; GitHub Actions deploys. Then:

```bash
curl -s https://femboyz.cloud/oidc/.well-known/openid-configuration | head -c 300
sudo journalctl -u femboyz-api -n 50 --no-pager | grep -E 'Accounts enabled|account indexes|OIDC'
```

The issuer must read `https://femboyz.cloud/oidc` and every endpoint must start
with it. If the endpoints lack `/oidc`, Nginx isn't passing `/oidc/` through.

### 14.5 Bounce webhook

Stalwart reports hard bounces of forwarded mail; after three, the API turns
that user's forwarding off. Run with the admin API key (`STW_TOKEN=-`):

```bash
echo '[["x:WebHook/set", {"create": {"w": {
  "url": "https://femboyz.cloud/api/v2/account/stalwart/webhook",
  "signatureKey": {"@type": "Value", "secret": "<STALWART_WEBHOOK_SECRET>"},
  "enable": true, "eventsPolicy": "include",
  "events": {"delivery.dsn-perm-fail": true}}}}, "w"]]' | STW_TOKEN=- ./stwjmap.py call
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml restart stalwart
```

Webhook settings load on restart.

### 14.6 Switch Stalwart to the OIDC directory

```bash
STW_TOKEN=- ./stwjmap.py call <<'EOF_JMAP'
[["x:Directory/set", {"create": {"o": {"@type": "Oidc", "description": "femboyz accounts",
   "issuerUrl": "https://femboyz.cloud/oidc", "requireAudience": "stalwart",
   "claimUsername": "preferred_username", "usernameDomain": "femboyz.cloud", "claimName": "name"}}}, "d"],
 ["x:Authentication/set", {"update": {"singleton": {"directoryId": "#o"}}}, "a"]]
EOF_JMAP
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml restart stalwart
```

Stalwart fetches the discovery document and keys on start. Watch for
`Issuer mismatch` or discovery errors in `sudo docker logs femboyz-stalwart`.

Undo by setting `directoryId` back to `null` and restarting. Passwords then
work again.

Stalwart provisions an account on the first OIDC login it hasn't seen. A
token for `admin` would therefore land in the internal admin mailbox. The API
refuses every internal account and alias name at signup
(`RESERVED_USERNAMES` in `src/accounts.ts`). Add any new internal account
there first.

### 14.7 Verification

Account deletion disables login immediately and destroys the mailbox after 11
minutes, once existing mail JWTs have expired. The API retries persisted deletion
jobs at startup and once a minute. This delay prevents Stalwart from recreating a
deleted mailbox from an old token. Run only one API process: account mutation and
code-send locks, like `authlimit`, are process-local.

1. `/admin` → Invites → create an invite with your external address, open the
   link, sign up.
2. Sign in at `/login` and open `/account`. The quota shows the 1 GiB mailbox.
3. Add an external address on `/account`. The code mail arrives (SMTP
   submission works). Turn forwarding on, send a message to the new
   `@femboyz.cloud` address from outside, and check it arrives at both places.
4. Request access from a private window. The notification reaches
   `admin@femboyz.cloud`, which forwards it.
5. `sudo docker logs femboyz-stalwart 2>&1 | grep -i 'auth'` shows no
   failures for `femboyz-api` or `noreply`.

### 14.8 Development setup

`docker-compose.yml` has a dev Stalwart under the `mail` profile
(`sudo docker compose --profile mail up -d`): JMAP on `127.0.0.1:18080`,
SMTP on `10025`, and submission on `10465` with a self-signed certificate
(`SMTP_TLS_INSECURE=true`).

- **Bootstrap.** Run 13.5 against `http://127.0.0.1:18080/jmap/` with the
  `STALWART_DEV_RECOVERY_ADMIN` login, then follow 14.1 and 14.6.
- **Issuer.** The dev issuer is the tailnet URL of the Vite server, which
  proxies `/oidc` and `/api` to the API like Nginx does. Set it as
  `DEV_ISSUER_HOST` in `.env`.
- **Relay.** tailscaled only accepts connections on its own interface, so the
  container reaches the issuer through a relay on `docker0`:

  ```bash
  socat TCP-LISTEN:8443,bind=172.17.0.1,reuseaddr,fork TCP:<tailnet-ip>:8443
  ```

- **Mailer.** Without `SMTP_HOST` the API only logs outgoing mail, codes
  included.


### 14.9 Production rollout record — 2026-10-19

Phase 2 was deployed from [PR #2](https://github.com/meadowlarps/femboyz-cloud-node/pull/2),
merge commit `9c2fa8577e3e60360d4affa925ed3fbc77f10236`.
[CI and deployment passed](https://github.com/meadowlarps/femboyz-cloud-node/actions/runs/39269416039).
The security review resolved six defects: parallel code guesses and sends, stale
forwarding updates, deletion with live JWTs, premature signup activation, and
incomplete mailbox rollback. Validation passed: 122 backend tests, 29 client
preview tests, Svelte check with no errors/warnings, and a production client build. Five follow-up backup regression cases verify
writer ordering, recovery after dump/snapshot/restart failures, and preservation
of an intentionally stopped API. The latest suite passes 127 backend tests and
29 client preview tests.

Production now has the service API key, noreply app password, administrator API
key, account environment, `/oidc/` nginx route, restricted signed bounce webhook,
and Stalwart OIDC directory. The admin API key is in the root-only
`/etc/femboyz-mail/credentials.txt`; the application secrets and signing key have
mode 600. The temporary Bulwark verification client was removed after testing;
the real client is now configured in section 15.

Sixteen checks passed against production with disposable accounts and controlled
external inboxes (DropMail):

- Request, admin notification (accepted by the existing Gmail redirect), approval
  and invite delivery; signup with the preverified address and with a mailed code.
- OIDC discovery/public JWKS, a real authorization-code JWT accepted by Stalwart,
  refresh, site-session SSO, quota, foreign-Origin rejection and site logout.
- Outbound JMAP submission received externally with DKIM; inbound delivery via
  unauthenticated STARTTLS on the public SMTP listener. The inbound probe ran on
  the VPS because the development machine cannot reach outbound port 25; external
  port-25 reachability was already verified in phase 1.
- Add/change/remove external email, wrong-password rejection, forwarding with and
  without a retained copy, and forwarding following the changed address.
- Three actual SMTP delivery failures after deleting the controlled external
  inbox disabled forwarding through Stalwart's signed webhook.
- Disabling and deleting a user refused an already-issued JWT. Test users were
  disabled and queued for the normal delayed deletion; the queue survives restart.

The first temporary inbox provider (mail.tm) had an expired SMTP certificate.
Certificate validation stayed enabled; testing moved to DropMail. The unused
inboxes were removed, their unused invite was revoked, and no test messages
remained queued for that provider.

The updated backup script pauses the API and Stalwart before dumping MongoDB and
snapshotting the mail volumes, environment and signing key to encrypted restic.
Snapshot `9677f387` was restored on the VPS: environment/key contents matched and
retained mode 600, and the Mongo archive was restored into an isolated, networkless
MongoDB container. It contained both test accounts, three email-code records and
OIDC storage. The drill container was then removed. The nightly 03:30 UTC timer
remains enabled. This backup covers the account/mail system; file storage still
needs the separate backup arrangement described in section 12.

Detailed verification state and rollout credentials remain root-only under
`/root/femboyz-phase2/`. Phase 3 adds Bulwark and its final SSO client (section 15). Stalwart
WebUI sign-in through an external OIDC client and promotion of the owner's personal
account remain separate follow-up work; the verified administrator API key is the
management path for phase 2.

## 15. Phase 3: Bulwark webmail

Bulwark 1.15.0-femboyz.3 is deployed at https://mail.femboyz.cloud using our
locally built image from a pinned upstream commit plus a small SSO patch
(`deploy/mail/bulwark/README.md`). It listens only
on `127.0.0.1:3100`; nginx terminates TLS using a separate certbot certificate
for mail.femboyz.cloud. The vhost template is `deploy/mail/nginx-mail.conf`.
GitHub deployment updates the API/site; container and managed-config upgrades
remain manual.

### 15.1 Configuration and credentials

Everything persistent lives under `/etc/femboyz-mail/webmail` (parent root 700):

| Path | Purpose / ownership |
| :--- | :--- |
| `bulwark.env` | runtime environment based on the committed example, root 600 |
| `admin/` | read-only policy, theme registry/CSS, and local admin password hash |
| `branding/` | copies of the site's existing webp logo and favicon, read-only |
| `state/` | writable admin runtime state, UID/GID 1001, mode 700 |
| `settings/` | writable server-synced user preferences, UID/GID 1001, mode 700 |
| `secrets/oauth`, `secrets/session` | random independent secrets, UID/GID 1001, mode 400 |

Secret files are mounted separately at `/run/secrets/bulwark_*`; never commit
them. The local Bulwark admin password is in root-only
`/etc/femboyz-mail/credentials.txt`. `admin/admin.json` stores only its scrypt
hash using Bulwark's `$scrypt$N=16384,r=8,p=1$<base64 salt>$<base64 hash>` format
(32-byte salt, 64-byte hash). Local administration is independent of mailbox
login; Stalwart admin access is disabled in webmail.

The provider's `.env.prod` registers client `bulwark`, sharing the OAuth secret,
with `OIDC_CLIENT_BULWARK_REDIRECT_URIS` containing a comma-separated exact URI
`https://mail.femboyz.cloud/<locale>/auth/callback` for each supported locale:
`ar ca cs da de en es fa fr he hu it ja ko lv mn nb nl pl pt ro ru sk tr uk zh zh-TW`.
Logout URI is exactly `https://femboyz.cloud/`, including the trailing slash.
The upstream image uses locale paths even though the source configuration's
current default is unprefixed. Recheck actual browser requests on upgrades.
Bulwark authenticates token exchange and refresh with `client_secret_post`.

### 15.2 Install/update

Obtain the hostname certificate before enabling the vhost:

```bash
sudo certbot certonly --nginx -d mail.femboyz.cloud
python3 deploy/mail/build-webmail.py /tmp/femboyz-webmail
```

Provision the directories and secrets above before installing the new compose
file (compose checks the env file even for Stalwart commands). Copy the generated
`admin/` and `branding/` trees into their matching directories, preserving
`admin/admin.json`; readable files are mode 644, directories 755 beneath the
root-only parent. Install the runtime env example and set the matching API client
environment. Restart the API after changing registration.

```bash
sudo install -m 600 deploy/mail/docker-compose.yml /etc/femboyz-mail/docker-compose.yml
sudo install -m 644 deploy/mail/nginx-mail.conf /etc/nginx/sites-available/femboyz-mail
sudo ln -s /etc/nginx/sites-available/femboyz-mail /etc/nginx/sites-enabled/femboyz-mail
sudo nginx -t
sudo systemctl reload nginx
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml config --quiet
sudo docker compose -f /etc/femboyz-mail/docker-compose.yml up -d webmail
curl --fail https://mail.femboyz.cloud/api/health
```

For later updates, rebuild and copy managed assets, then restart webmail. The
read-only policy selects the femboyz theme for everyone and provides the native
account sidebar app. Both theme variants use our dark palette. The site's Mail
button links directly to webmail. See `mail/README.md` for theme packaging.

### 15.3 Sessions, backups, rollback

SSO redirects to the site's login, then returns to the inbox. Account settings
use the site's ordinary session inside the native sidebar frame; **Open account**
opens the full page. Bulwark logout ends its local session and the provider
session. The provider also deletes this browser's site sessions by `sid` and
clears the site cookie; other browsers stay signed in.

The nightly encrypted restic snapshot already includes `/etc/femboyz-mail`, so
it includes managed config, OAuth/session secrets, admin state and user settings.
The updated backup script stops running webmail before the API and Stalwart and
restarts all three on success or failure. Install it at
`/usr/local/sbin/femboyz-mail-backup`, mode 755. Preserve numeric ownership when
restoring settings/state and secrets.

Before rollout, a fresh backup and copies of the previous compose/environment
were saved under `/root/femboyz-phase3`. For rollback, stop webmail, disable its
nginx vhost, restore the previous compose and API environment, and restart the
API. Do not roll back Stalwart or MongoDB. Keep the encrypted backup and webmail
state until the incident is resolved.

### 15.4 Production acceptance (2026-10-19)

The browser passed the complete logged-out webmail → site login → inbox flow
using a disposable invited account. A controlled message sent from noreply was
received and read. Computed theme colors were background `rgb(6, 6, 6)` and
primary `#c30f45`, with zero-radius buttons. The native account iframe established
the site session by SSO, displayed quota and email settings, and worked at mobile
width. Its header now wraps to fit narrow screens.

JMAP discovery initially exposed a missing CORS header. The mx nginx template now
allows only `https://mail.femboyz.cloud`, including on discovery redirects/errors
and OPTIONS responses, and hides upstream CORS headers to prevent duplicates.
An unrelated Origin receives no Allow-Origin header. Authentication and TLS
verification remain enforced.

Webmail sign-out returned to the site home page; `/api/v2/account/me` then returned
401. A fresh webmail tab redirected to the site's login. Regression tests also
verify another browser remains signed in. The site's Mail link targets webmail.

The post-rollout encrypted backup restarted Stalwart, the API and healthy webmail.
A restore into `/root/femboyz-phase3/restore` verified 12 webmail files, config and
secret hashes, numeric ownership and permissions. Restored encrypted user settings
were decrypted successfully with the restored session secret; live settings may
change after the snapshot. Root-only evidence is
`/root/femboyz-phase3/verification-report.json`, `backup.after.log` and the restored
tree. Local validation passed 130 backend tests, 29 client preview tests, backend
build, Svelte check (zero errors/warnings), and client build. GitHub's main workflow
was queued during rollout, so production was deployed directly with the same
commit-pinned deployment script after those checks passed locally.

### 15.5 Repeat-login fix and square logo (2026-10-19)

The upstream 1.15.0 login page kept a permanent `sso_attempted` browser flag when
its cleanup timer was destroyed by navigation to the provider. Our patch migrates
that flag, uses a bounded 30-second timestamp for failed attempts, and clears it
after successful authentication. The old ambiguous logout flag is migrated on
upgrade. Full provider logout also clears the one-shot local sign-out pause so
the next intentional mail visit starts SSO automatically.
Local-only logout still pauses automatic SSO, preventing an immediate login
through a provider session that was never ended. Retry/error and multi-server
checks remain intact.

Build and transfer `femboyz/bulwark:1.15.0-femboyz.1` following
`deploy/mail/bulwark/README.md`; compose uses `pull_policy: never`. Keep the exact
loaded image ID at `/etc/femboyz-mail/webmail/image-id.txt`. The build runs the
focused upstream regression tests, then the production Next.js build. The full
patched source archive is served from the read-only branding directory and linked
through `SOURCE_CODE_URL`. Backups include that source and the build identity, so
restoring onto a new machine can rebuild the exact source before starting compose.

The user-supplied square logo is preserved unchanged in
`mail/branding/login-logo.png` (source recorded in that directory's README).
Both login variants use it with maximum width/height 160px, replacing Bulwark's
64px default; the redundant Webmail subtitle is hidden. Configuration is in
`deploy/mail/bulwark.env.example`.

Rollback copies of compose, runtime env and branding are saved under
`/root/femboyz-phase3-login/`. To roll back, restore those files and run compose
`up -d webmail`; the old upstream image remains on the server. API, site, mailboxes,
OAuth registration and signing keys are unchanged by this rollout.

Acceptance: 30 focused regression tests passed inside the image build, followed
by the production Next.js/TypeScript build. In production, a tab seeded with both
legacy browser flags went directly to the site's login and then the inbox.
A second login after provider logout did the same without an SSO-button click;
callback guards were cleared, and the site session returned 401 after logout.
Embedded account settings continued to work. The supplied PNG rendered at
approximately 157×160px and fitted a 390px mobile viewport without horizontal
overflow. The downloadable source archive matched its build checksum. The test
account was disabled and queued for deletion after token expiry.

### 15.6 Abandoned login and checking screen (2026-10-19)

`1.15.0-femboyz.2` also covers Home → Mail → site login → Home logo → Mail
within a few seconds. The first patch incorrectly treated that unfinished login
as a failure. The current guard migrates both older pending-attempt flags and
pauses only after an actual callback error. Its 30-second failure expiry remains,
and explicit retry clears it.

The automatic single-provider login screen now shows the 160px logo, spinner and
**Checking login…**. It has no SSO/sign-in button during normal entry. Actual
callback/discovery/start errors offer **Try again**. Discovery and start requests
have a 15-second timeout, so network problems do not leave the spinner indefinitely.
Multi-server, add-account and local-only logout flows retain their original UI.

The image build runs 41 focused tests covering the guard, real callback errors,
full provider/local logout, the actual login page across an abandoned flow, and
the checking/error display. Source distribution and local image identity follow
section 15.5 using the `.2` version suffix. Rollback copies are under
`/root/femboyz-phase3-checking/`; restore its compose/env and restart only webmail
to return to `.1`.

Production acceptance for `.2`: the recorded Home → Mail → login → Home logo →
Mail sequence was repeated five times, including four immediate returns within
about ten seconds, without an SSO-button click. A recent old pending flag was
migrated. Two additional returns through the Norwegian locale also forwarded.
A delayed request in the test browser displayed **Checking login…**, its status
role and the logo, with no button; it then forwarded automatically. A deliberate
error displayed **Try again**, which resumed checking and forwarded. The public
source archive checksum matched the generated build artifact. Root-only evidence
and the backup log are under `/root/femboyz-phase3-checking/`.

### 15.7 Quiet login transitions (2026-10-19)

`1.15.0-femboyz.3` removes the PWA installation card and suppresses browser
install prompts in the head bootstrap, before React hydration. Installation
through the browser menu still works. The initial mailbox session check has
no visible loader. The login check waits 700 ms before showing a single
**Checking login…** status without a logo; real errors still show retry immediately.
The final femboyz.cloud sign-in page is unchanged.

The website's actual background is `#1b1a1a`. It is applied to the server-rendered
html/body, bundled with the full managed palette before client config loads,
and set in theme 1.0.1 and the PWA metadata. This prevents default-theme and
background flashes. Keep the bundled `app/femboyz.css` in the vendor patch in
sync with `mail/theme/theme.css`.

Build/source distribution follows 15.5 using the `.3` suffix. Rollback copies
of compose, environment, image identity and managed theme are under
`/root/femboyz-phase3-transition/`; restore those files and restart only webmail
to return to `.2`.

Acceptance: 47 focused tests passed in the image build, followed by the production
Next.js/TypeScript build. In the production browser, 435 sampled frames during a
held SSO start request kept one background and one status position, with zero
logo images or install buttons. Releasing the request forwarded to the site
sign-in page. A normal Norwegian-locale entry also forwarded successfully; its
recording showed the matching empty background during the transition. A 390px
viewport with a deliberately cached old `#060606` theme still rendered the
transition as `#1b1a1a` without overflow. Synthetic install events were cancelled,
PWA metadata matched, and the downloadable source checksum matched the build.

## 16. Phase 4: outbound limits and abuse controls

Users can send from webmail (JMAP submission) since phase 3. Stalwart runs
JMAP submissions through the same MAIL FROM / RCPT TO stages as SMTP, so the
limits below cover both. Design: `MAIL_PLAN.md` section 4, phase 4.

### 16.1 Sending limits

All limits count **recipients** per logged-in account (`authenticated_as`, the
full address, e.g. `alice@femboyz.cloud`). `noreply@` is exempt; the API
rate-limits what it sends. Inbound mail from other servers is unaffected.

| Limit | Value |
|---|---|
| Recipients per message (logged-in senders) | 25 (inbound keeps Stalwart's 100) |
| Every account | 60 per hour, 300 per day |
| New accounts (first `MAIL_NEW_SENDER_DAYS`, default 14) | 20 per hour, 100 per day |

Over a limit, Stalwart answers `452 4.4.5 Rate limit exceeded` (or
`455 4.5.3 Too many recipients`) for each extra recipient. The message still
goes to the accepted ones, and Bulwark names the rejected recipients.

"New" is the `femboyz-new-senders` memory lookup list, matched with
`key_exists('femboyz-new-senders', authenticated_as)`. The API keeps it in step
with account age at startup, every 10 minutes and after each signup
(`new_senders_sync` in `src/accounts.ts`). It then runs `ReloadLookupStores`,
because the list is static between reloads. `/admin` → Users shows
**Sending limits: New until …** for these accounts.

Rollout, as `admin@` (`STW_TOKEN=-` prompts for the runbook API key):

1. Grant the API service account the lookup and reload permissions. This also
   lets it edit other lookup lists (spam lists); it is already fully trusted
   (14.1).

   ```bash
   cd /srv/femboyz-cloud/deploy/mail
   export STW_TOKEN=-
   echo '[["x:Account/get", {"properties": ["name"]}, "a"]]' | ./stwjmap.py call   # <SVC_ID> of femboyz-api
   python3 -c 'import json; print(json.dumps([["x:Account/set", {"update": {"<SVC_ID>": {f"permissions/enabledPermissions/{p}": True for p in
     ["sysMemoryLookupKeyGet", "sysMemoryLookupKeyQuery", "sysMemoryLookupKeyCreate", "sysMemoryLookupKeyDestroy", "sysActionCreate", "actionReloadLookupStores"]}}}, "u"]]))' | \
     ./stwjmap.py call
   ```

2. Deploy the API. Its log shows `New senders: +N -0` (the first sync).
   `forbidden` errors mean step 1 is missing.
3. Apply the throttles and the recipient cap. The script is idempotent and
   matches throttles by description. `--show` only prints.

   ```bash
   ./outbound-limits.py
   ```

`ReloadSettings` re-runs OIDC discovery against the issuer, so the API must
be up when the script runs.

Verify: send from webmail to 26 recipients. The 26th fails with "Too many
recipients". An account on the list stops after 20 recipients in an hour. The
counters are fixed windows in Stalwart's in-memory store.

To change a limit, edit `THROTTLES` in `outbound-limits.py` and rerun it. A new
count or period starts a fresh counter. To trust a user early, there is no
switch: wait out the window, or lower `MAIL_NEW_SENDER_DAYS` for everyone.

**Outbound spam scoring is not possible with Stalwart alone.** 0.16 never runs
its spam classifier on authenticated sessions (`spam_classify` returns
`Disabled` when `is_authenticated()`). Options, if it is ever needed: an rspamd
milter on the DATA stage (`x:MtaMilter`), or an `x:MtaHook` to a small
classifier. For now the limits, invite-only signup and the disable switch are
the controls.

### 16.2 Abuse handling

`abuse@` and `postmaster@` are aliases of `admin@`, which forwards to the
admin's personal address (13.9). For a complaint or a blocklist notice:

1. Find the account. The complaint usually includes the headers; the
   `From:` / `Return-Path:` is `<user>@femboyz.cloud`. Check the queue for
   anything still waiting: WebUI → Queue, or
   `echo '[["x:QueuedMessage/query", {"limit": 50}, "q"]]' | ./stwjmap.py call`.
2. Disable it: `/admin` → Users → **Disable**. This withdraws Stalwart's
   `authenticate` permission immediately, so webmail, tokens and SMTP stop at
   once, and it ends all site and OIDC sessions.
3. Remove the queued spam: WebUI → Queue, filter by sender, cancel.
4. Delete the account if it was abuse rather than a compromise
   (`/admin` → Users → **Delete**). A compromised account can be re-enabled
   after the user picks a new password.
5. Check the blocklists (Spamhaus, Barracuda, SpamCop; `MAIL_PLAN.md` phase 0) and Google Postmaster Tools / SNDS (16.3).

The rules users agree to at signup are at `/terms` (`client/src/routes/terms/`).

### 16.3 Reputation monitoring and DMARC

DMARC aggregate reports go to `dmarc@` (`rua` in 13.10). Stalwart only parses
reports sent to `inboundReportAddresses`, which defaults to `postmaster@*`, so
add `dmarc@*`:

```bash
echo '[["x:ReportSettings/set", {"update": {"singleton": {"inboundReportAddresses": {"postmaster@*": true, "dmarc@*": true}}}}, "s"],
  ["x:Action/set", {"create": {"r": {"@type": "ReloadSettings"}}}, "a"]]' | ./stwjmap.py call
```

The reports still land in admin's mailbox. They are not forwarded (13.9).
Summarise them with:

```bash
./dmarc-summary.py 14      # reporter, source IP, messages, DKIM/SPF passes
```

Rows marked `<- not us` are forwarders or spoofers. Tighten `_dmarc` at
Namecheap in steps. Each step needs about two weeks of reports in which
167.233.218.194 passes DKIM or SPF for everything:

1. `v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@femboyz.cloud`
2. `v=DMARC1; p=quarantine; rua=mailto:dmarc@femboyz.cloud`
3. `v=DMARC1; p=reject; rua=mailto:dmarc@femboyz.cloud`

The admin has to sign up for the external dashboards personally:

- **Google Postmaster Tools** (https://postmaster.google.com): add
  `femboyz.cloud` and verify it with the TXT record it gives (Namecheap host `@`,
  next to the SPF record). Graphs appear only after a daily volume to Gmail of
  very roughly a hundred messages or more. An empty dashboard is normal for now.
- **Microsoft SNDS** (https://sendersupport.olc.protection.outlook.com/snds/):
  sign in with a Microsoft account → Request Access → `167.233.218.194`. Choose
  `postmaster@femboyz.cloud` as the verification address. That mail reaches the
  personal address through the admin redirect. Join JMRP from the same site
  to get Outlook.com spam complaints about our IP.
