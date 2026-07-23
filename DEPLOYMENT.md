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
```

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
