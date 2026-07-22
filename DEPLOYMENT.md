# Production deployment

The production stack is GitHub Actions, SSH, systemd, and Nginx. A push to
`main` is tested on GitHub, then the server fast-forwards to that exact commit,
builds both applications, restarts them, and verifies their health endpoints.

## Server setup

The checked-in templates assume Linux, Node.js 24, and this layout:

```text
/srv/femboyz-cloud       repository, owned by femboyz:femboyz
127.0.0.1:3000           Fastify API
127.0.0.1:3001           SvelteKit Node server
Nginx                     public HTTP/HTTPS entry point
MongoDB                   managed separately
```

Create a `femboyz` user, install Node.js 24, Git, Nginx, and curl, then clone
the repository:

```bash
sudo useradd --create-home --shell /bin/bash femboyz
sudo install -d -o femboyz -g femboyz /srv/femboyz-cloud
sudo -u femboyz git clone git@github.com:meadowlarps/femboyz-cloud-node.git /srv/femboyz-cloud
```

Create `/srv/femboyz-cloud/.env.prod` with the existing production backend
configuration. Keep it untracked. In particular, set `BASE_URL` to the public
HTTPS origin, keep `EMPTY_STORAGE_DIR_ON_STARTUP=false`, and set a random admin
key:

```bash
openssl rand -hex 32
```

Store the result as `AUTH_ADMIN_KEY` in `.env.prod`. The private admin page is
then available at `/admin`; the key is never needed by the SvelteKit process.

Replace `example.com` in both `deploy/nginx.conf` and
`deploy/femboyz-web.service`. Install and enable the service files:

```bash
sudo cp /srv/femboyz-cloud/deploy/femboyz-api.service /etc/systemd/system/
sudo cp /srv/femboyz-cloud/deploy/femboyz-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now femboyz-api.service femboyz-web.service
```

Install the Nginx configuration, test it, and reload Nginx:

```bash
sudo cp /srv/femboyz-cloud/deploy/nginx.conf /etc/nginx/sites-available/femboyz-cloud
sudo ln -s /etc/nginx/sites-available/femboyz-cloud /etc/nginx/sites-enabled/femboyz-cloud
sudo nginx -t
sudo systemctl reload nginx
```

Issue the HTTPS certificate with your normal ACME client after DNS points at
the server. The SvelteKit `ORIGIN` and backend `BASE_URL` must match that HTTPS
origin.

Allow only the two deployment restarts without a password by adding this with
`sudo visudo -f /etc/sudoers.d/femboyz-deploy`:

```text
femboyz ALL=(root) NOPASSWD: /usr/bin/systemctl restart femboyz-api.service femboyz-web.service
```

## GitHub configuration

Create a GitHub environment named `production`, then add these environment
secrets:

- `DEPLOY_HOST`: server hostname or IP.
- `DEPLOY_PORT`: SSH port; omit it to use 22.
- `DEPLOY_USER`: `femboyz`.
- `DEPLOY_SSH_KEY`: private key whose public key is in the server user's
  `authorized_keys`.
- `DEPLOY_KNOWN_HOSTS`: the server host-key line produced by `ssh-keyscan -H`.

The server also needs read access to the GitHub repository. For a private
repository, add a separate read-only repository deploy key to the server; do
not reuse the GitHub Actions login key.

Run the first install and build before enabling CI deployment:

```bash
cd /srv/femboyz-cloud
npm ci
npm run build
npm --prefix client ci
npm --prefix client run build
```

After setup, every successful push to `main` deploys automatically. Failed
tests do not touch production, a dirty server checkout refuses deployment,
and an older workflow skips itself if a newer commit has already reached
`main`.
