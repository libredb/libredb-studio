#!/usr/bin/env bash
# LibreDB Studio — Azure Marketplace solution template first-boot installer.
#
# Executed by the CustomScript VM extension via protectedSettings.commandToExecute.
# Every argument is base64-encoded by the ARM template, so no shell quoting or
# injection is possible regardless of what the customer typed in the portal.
#
#   $1  admin email        (base64)
#   $2  admin password     (base64)
#   $3  site address       (base64)  FQDN for HTTPS, or ":80" for plain HTTP
#   $4  ACME contact       (base64)  may be empty
set -euo pipefail

# The log stays root-only: it records the admin email and the deployment's hostname.
# Created only when absent so a re-run (VM reimage, extension re-apply) keeps
# the earlier history; chmod covers logs created by older versions.
[ -f /var/log/libredb-install.log ] || install -m 600 /dev/null /var/log/libredb-install.log
chmod 600 /var/log/libredb-install.log
exec > >(tee -a /var/log/libredb-install.log) 2>&1
echo "=== LibreDB Studio install started: $(date -Is) ==="

b64d() { printf '%s' "${1:-}" | base64 -d 2>/dev/null || true; }

APP_ADMIN_EMAIL="$(b64d "${1:-}")"
APP_ADMIN_PASSWORD="$(b64d "${2:-}")"
SITE_ADDRESS="$(b64d "${3:-}")"
ACME_EMAIL="$(b64d "${4:-}")"

# Injected by scripts/build-azure-package.mjs at package build time.
APP_IMAGE="__APP_IMAGE__"
CADDY_IMAGE="__CADDY_IMAGE__"

if [ -z "$APP_ADMIN_EMAIL" ] || [ -z "$APP_ADMIN_PASSWORD" ]; then
  echo "FATAL: admin credentials were not passed to the installer" >&2
  exit 1
fi
# The template always passes an explicit ':80' or an FQDN; an empty value here
# means the argument was lost or corrupted, and silently degrading a requested
# HTTPS deployment to plain HTTP is not an acceptable reading of that.
if [ -z "$SITE_ADDRESS" ]; then
  echo "FATAL: the site address argument is missing or not valid base64" >&2
  exit 1
fi
# The portal constrains both values to these characters; deployments driven by
# CLI/API bypass that regex, and the password lands in an env file read by
# docker --env-file, where a newline would inject an arbitrary extra line.
case "$APP_ADMIN_PASSWORD" in
  *[!A-Za-z0-9@#%^*_+=.,:?!-]*)
    echo "FATAL: the administrator password may only contain letters, digits and ! @ # % ^ * _ + = . , : ? -" >&2
    exit 1 ;;
esac
case "$APP_ADMIN_EMAIL" in
  *[![:graph:]]*)
    echo "FATAL: the administrator email must not contain whitespace or control characters" >&2
    exit 1 ;;
esac

# ---------------------------------------------------------------- packages ---
# DPkg::Lock::Timeout is not optional here: Azure's Canonical cloud images run
# apt-daily / unattended-upgrades on first boot, and the CustomScript extension
# races them. Without the timeout a lock collision fails apt, `set -e` kills the
# script, the extension reports Failed and the whole ARM deployment fails.
export DEBIAN_FRONTEND=noninteractive
# Belt: wait for cloud-init to finish its own package work before we start ours.
command -v cloud-init >/dev/null 2>&1 && cloud-init status --wait >/dev/null 2>&1 || true
# Braces: even after cloud-init, apt-daily/unattended-upgrades can hold the lock.
APT_OPTS=(-o DPkg::Lock::Timeout=600)
apt-get "${APT_OPTS[@]}" update -y
apt-get "${APT_OPTS[@]}" install -y --no-install-recommends \
  docker.io ca-certificates curl openssl
systemctl enable --now docker

# Registry hiccups must not fail the deployment on the first try.
pull_with_retry() {
  local ref="$1" i
  for i in 1 2 3 4 5; do
    if docker pull "$ref"; then return 0; fi
    echo "docker pull $ref failed (attempt $i), retrying in $((i * 10))s"
    sleep $((i * 10))
  done
  echo "FATAL: could not pull $ref" >&2
  return 1
}
pull_with_retry "$APP_IMAGE"
pull_with_retry "$CADDY_IMAGE"

# ------------------------------------------------------------------- layout ---
# The shared parents stay world-readable; the two directories holding secrets do
# not. /opt/libredb/data carries the SQLite store, whose connection records include
# plaintext passwords and connection strings, and /opt/libredb/caddy/data carries the
# TLS private keys and the ACME account key. The mode of the files inside follows the
# containers' umask, not anything this installer sets, so the directory is the control
# point: 0700 keeps both out of reach of every local account except root, which is the
# same bar /etc/libredb-studio.env already meets.
#
# Both containers still work, and neither needs a mode change: the app container starts
# as root, chowns its data dir to `nextjs` and drops privileges (docker-entrypoint.sh),
# the Caddy image runs as root, and `chown` does not touch the mode. A re-run also
# repairs a directory left at 0755 by an earlier version, because `install -d` applies
# the mode to directories that already exist.
install -d -m 0755 /opt/libredb /opt/libredb/caddy /opt/libredb/caddy/config
install -d -m 0700 /opt/libredb/data /opt/libredb/caddy/data

# ---------------------------------------------------------------- app env ---
# Strict mode: no generated credentials, everything explicit (docs/DISTRIBUTION.md).
#
# Written once and never rewritten: if the extension re-runs (VM reimage, extension
# update), regenerating JWT_SECRET would invalidate every existing session.
if [ ! -f /etc/libredb-studio.env ]; then
  # Command substitutions do not trip `set -e`, so an openssl failure would
  # otherwise write an EMPTY secret without a word of complaint.
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  if [ -z "$JWT_SECRET" ]; then
    echo "FATAL: could not generate a JWT secret" >&2
    exit 1
  fi
  (
    umask 077   # scoped to this subshell so later files keep normal modes
    # printf '%s', never a heredoc: an unquoted heredoc would shell-expand
    # $(...) and $var sequences inside the customer's password as root.
    {
      printf 'AUTH_BOOTSTRAP=off\n'
      printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
      printf 'NEXT_PUBLIC_AUTH_PROVIDER=local\n'
      printf 'ADMIN_EMAIL=%s\n' "$APP_ADMIN_EMAIL"
      printf 'ADMIN_PASSWORD=%s\n' "$APP_ADMIN_PASSWORD"
      printf 'STORAGE_PROVIDER=sqlite\n'
      printf 'STORAGE_SQLITE_PATH=/app/data/libredb-storage.db\n'
      printf 'PORT=3000\n'
      printf 'HOSTNAME=0.0.0.0\n'
      # In production the app marks its auth cookie Secure for every non-loopback
      # host, and a browser reached over plain http discards such a cookie, so the
      # login would silently loop back to the login page (src/lib/auth.ts,
      # shouldMarkCookieSecure). Only the ":80" deployment needs the override: the
      # HTTPS one always speaks https to the browser, self-signed included.
      if [ "$SITE_ADDRESS" = ":80" ]; then printf 'AUTH_COOKIE_SECURE=false\n'; fi
    } > /etc/libredb-studio.env
  )
  chmod 600 /etc/libredb-studio.env
else
  echo "/etc/libredb-studio.env already exists — keeping the existing JWT secret"
fi

# ---------------------------------------------------------------- Caddyfile ---
{
  echo '{'
  echo '	admin off'
  if [ -n "$ACME_EMAIL" ]; then printf '\temail %s\n' "$ACME_EMAIL"; fi
  echo '}'
  echo ''
  printf '%s {\n' "$SITE_ADDRESS"
  if [ "$SITE_ADDRESS" != ":80" ]; then
    # Two issuers, tried in order: "This subdirective can be specified multiple
    # times to configure multiple, redundant issuers; if one fails to issue a
    # cert, the next one will be tried" (Caddy tls directive docs). So Let's
    # Encrypt first, and Caddy's own CA as the fallback — which means a failed
    # issuance never leaves the site dead, never moves the app to another port,
    # and needs no reconfiguration here. Internal certificates are short-lived
    # (12h default), so every renewal cycle retries ACME and the deployment
    # upgrades itself the moment issuance becomes possible again.
    #
    # Port 443 may be restricted to the customer's address range, so the TLS-ALPN-01
    # challenge (which Let's Encrypt performs against :443) can fail or waste backoff
    # time. Port 80 is open by design, so pin issuance and renewal to HTTP-01 instead
    # of leaving the choice to chance. The email is repeated here because an explicit
    # issuer block does not necessarily inherit the global one.
    echo '	tls {'
    echo '		issuer acme {'
    if [ -n "$ACME_EMAIL" ]; then printf '\t\t\temail %s\n' "$ACME_EMAIL"; fi
    echo '			disable_tlsalpn_challenge'
    echo '		}'
    echo '		issuer internal'
    echo '	}'
  fi
  echo '	encode zstd gzip'
  echo '	reverse_proxy libredb-studio:3000'
  echo '}'
} > /opt/libredb/caddy/Caddyfile
chmod 644 /opt/libredb/caddy/Caddyfile

# ------------------------------------------------------------------ network ---
docker network inspect libredb >/dev/null 2>&1 || docker network create libredb

# ------------------------------------------------------------ systemd units ---
cat > /etc/systemd/system/libredb-studio.service <<EOF
[Unit]
Description=LibreDB Studio
After=docker.service network-online.target
Wants=network-online.target docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f libredb-studio
ExecStart=/usr/bin/docker run \\
  --name libredb-studio \\
  --init \\
  --network libredb \\
  -p 127.0.0.1:3000:3000 \\
  --env-file /etc/libredb-studio.env \\
  -v /opt/libredb/data:/app/data \\
  ${APP_IMAGE}
ExecStop=/usr/bin/docker stop libredb-studio
ExecStopPost=-/usr/bin/docker rm -f libredb-studio
Restart=always
RestartSec=10
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/libredb-caddy.service <<EOF
[Unit]
Description=LibreDB Studio reverse proxy (Caddy)
After=docker.service network-online.target libredb-studio.service
Wants=network-online.target docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f libredb-caddy
ExecStart=/usr/bin/docker run \\
  --name libredb-caddy \\
  --init \\
  --network libredb \\
  -p 80:80 -p 443:443 \\
  -v /opt/libredb/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
  -v /opt/libredb/caddy/data:/data \\
  -v /opt/libredb/caddy/config:/config \\
  ${CADDY_IMAGE}
ExecStop=/usr/bin/docker stop libredb-caddy
ExecStopPost=-/usr/bin/docker rm -f libredb-caddy
Restart=always
RestartSec=10
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now libredb-studio libredb-caddy

# ------------------------------------------------------------- health gate ---
# 1) The application itself must answer. Response body is {"status":"healthy",...}.
ok=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/db/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ "$ok" -ne 1 ]; then
  echo "FATAL: LibreDB Studio did not become healthy within 5 minutes" >&2
  docker logs libredb-studio --tail 200 || true
  exit 1
fi

# 2) If HTTPS was requested, SOME certificate must be in place before we advertise the
#    URL — Caddy serves a named site on :443 and 308-redirects :80 to it, so a site with
#    no usable certificate is dead on BOTH ports. The issuer chain in the Caddyfile
#    guarantees one arrives (Let's Encrypt, else Caddy's internal CA); the two probes
#    below only establish WHICH one, so the notice can be honest about the browser
#    warning. Nothing here rewrites configuration or moves the app to another port.
#    --resolve pins the connection to the local Caddy while still validating the
#    real certificate chain and SNI; Azure does not reliably hairpin a VM's own
#    public IP, so a plain https://<fqdn> probe from the VM is not a valid test.
TLS_MODE=none
if [ "$SITE_ADDRESS" != ":80" ]; then
  TLS_MODE=pending
  for _ in $(seq 1 36); do
    # -k here: any certificate ends the wait, trusted or self-signed.
    if curl -fsSk --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
         "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1; then
      TLS_MODE=ready
      break
    fi
    sleep 5
  done
  if [ "$TLS_MODE" != "ready" ]; then
    echo "FATAL: HTTPS did not become reachable within 3 minutes" >&2
    docker logs libredb-caddy --tail 100 || true
    exit 1
  fi
  # Same probe WITHOUT -k: curl validates against the VM's system trust store, so a
  # Let's Encrypt certificate passes and Caddy's internal CA — whose root exists only
  # inside the container — does not. That is the browser's verdict too.
  if curl -fsS --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
       "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1; then
    TLS_MODE=trusted
  else
    TLS_MODE=internal
    echo "WARNING: no publicly trusted certificate yet — Caddy fell back to its internal (self-signed) CA"
    docker logs libredb-caddy --tail 100 || true
  fi
fi

# ------------------------------------------------------------------- notice ---
# An HTTPS deployment is reached by its DNS name, so only the plain-HTTP one has to
# ask who it is. Azure Instance Metadata Service — link-local, no traffic leaves the
# virtual network.
if [ "$SITE_ADDRESS" = ":80" ]; then
  PUBLIC_IP="$(curl -fsS -H 'Metadata:true' --noproxy '*' \
    'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' 2>/dev/null || true)"
  APP_URL="http://${PUBLIC_IP:-<public-ip>}"
else
  APP_URL="https://${SITE_ADDRESS}"
fi

TLS_NOTE=""
if [ "$TLS_MODE" = "internal" ]; then
  TLS_NOTE="
  !! No publicly trusted certificate could be issued yet, so Caddy is serving its own
     self-signed certificate on the same port. The URL above is the right one and the
     traffic is encrypted, but your browser will warn you until a trusted certificate
     arrives. Nothing needs to be restored by hand: self-signed certificates are
     short-lived by design, and Caddy retries Let's Encrypt on every renewal cycle,
     switching over on its own as soon as issuance succeeds.
     Likely causes: a Let's Encrypt rate limit or outage, or a firewall that keeps port
     80 unreachable. Which one it was:
       docker logs libredb-caddy 2>&1 | grep -i -m5 'acme\|challenge\|rate limit'
     * A connection error or timeout while fetching the challenge means port 80 was not
       reachable from the internet. That is measurable: from ANY machine other than this
       one, run
         curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 http://${SITE_ADDRESS}/
       Any HTTP status (404 included) means port 80 is reachable and the next renewal
       cycle should succeed. A timeout means something still blocks it - that is yours
       to fix, and nothing else will help until it is.
     * A rate limit needs no action at all: Let's Encrypt limits reset on a rolling
       weekly window and the retry happens by itself.
"
fi

cat > /etc/libredb-studio.info <<EOF
LibreDB Studio is running.

  URL:   ${APP_URL}
  Admin: ${APP_ADMIN_EMAIL}   (password: the one you entered during deployment)
${TLS_NOTE}

  Service:  systemctl status libredb-studio
  Logs:     docker logs libredb-studio
  Data:     /opt/libredb/data   (SQLite storage; survives restarts)
  Config:   /etc/libredb-studio.env   (mode 0600)
  Install log: /var/log/libredb-install.log

  Docs:    https://github.com/libredb/libredb-studio#readme
  Support: https://github.com/libredb/libredb-studio/issues
EOF
cp /etc/libredb-studio.info /etc/motd

echo "=== LibreDB Studio install finished: $(date -Is) ==="
