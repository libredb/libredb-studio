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
#   $5  web source prefix  (base64)  "Internet" or a CIDR — decides how the TLS
#                                    fallback may degrade without widening access
set -euo pipefail

# The log stays root-only: it records the admin email and the network scope.
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
WEB_SOURCE="$(b64d "${5:-}")"
# Fail CLOSED. This value decides whether the TLS fallback may serve plain HTTP
# on the internet-open port 80, so a missing or undecodable argument must land
# on the restrictive branch (self-signed on :443), never on the permissive one.
# The template always sends a value; anything else is a bug upstream.
[ -n "$WEB_SOURCE" ] || WEB_SOURCE="restricted"

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
install -d -m 0755 /opt/libredb /opt/libredb/data /opt/libredb/caddy \
                   /opt/libredb/caddy/data /opt/libredb/caddy/config

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

# 2) If HTTPS was requested, the certificate must actually exist — otherwise the URL
#    we are about to advertise is dead on both ports (Caddy serves a named site on
#    :443 and 308-redirects :80 to it, so a failed certificate breaks BOTH).
#    --resolve pins the connection to the local Caddy while still validating the
#    real certificate chain and SNI; Azure does not reliably hairpin a VM's own
#    public IP, so a plain https://<fqdn> probe from the VM is not a valid test.
TLS_OK=1
FALLBACK_MODE=none
if [ "$SITE_ADDRESS" != ":80" ]; then
  TLS_OK=0
  for _ in $(seq 1 36); do
    if curl -fsS --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
         "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1; then
      TLS_OK=1
      break
    fi
    sleep 5
  done
  if [ "$TLS_OK" -ne 1 ]; then
    # Degrade rather than leave an unreachable deployment behind — but NEVER degrade in a
    # way that reaches more people than the customer allowed. Port 80 is open to the
    # internet by design (ACME), so moving the app onto :80 is only safe when the customer
    # left port 443 open to the internet too.
    #
    # Remaining causes at this point (port 80 is guaranteed reachable by the template):
    # Let's Encrypt rate limit, a Let's Encrypt outage, or a firewall the customer added.
    docker logs libredb-caddy --tail 100 || true
    # Keep the HTTPS config verbatim so restoring it later also restores the ACME
    # contact address — rewriting only the site line would silently drop `email`.
    cp /opt/libredb/caddy/Caddyfile /opt/libredb/caddy/Caddyfile.https

    # "0.0.0.0/0" is spelled differently but means exactly what "Internet" means; treat
    # both as unrestricted. Anything else (a CIDR, VirtualNetwork, AzureLoadBalancer) is
    # narrower than the internet, so it takes the conservative branch.
    if [ "$WEB_SOURCE" = "Internet" ] || [ "$WEB_SOURCE" = "0.0.0.0/0" ]; then
      FALLBACK_MODE=http
      echo "WARNING: no valid TLS certificate after 3 minutes — falling back to plain HTTP on :80"
      printf '{\n\tadmin off\n}\n\n:80 {\n\tencode zstd gzip\n\treverse_proxy libredb-studio:3000\n}\n' \
        > /opt/libredb/caddy/Caddyfile
    else
      # The customer restricted port 443. Falling back to :80 would publish the
      # application to the entire internet. Stay on 443 with a self-signed certificate:
      # the restriction holds and the traffic stays encrypted. The browser will warn.
      FALLBACK_MODE=selfsigned
      echo "WARNING: no valid TLS certificate after 3 minutes — staying on :443 with a self-signed certificate (source range is restricted to ${WEB_SOURCE})"
      printf '{\n\tadmin off\n}\n\n%s {\n\ttls internal\n\tencode zstd gzip\n\treverse_proxy libredb-studio:3000\n}\n' \
        "$SITE_ADDRESS" > /opt/libredb/caddy/Caddyfile
    fi

    # Freeze the working fallback config here, not in the operator's restore hint. If the
    # operator makes the backup by hand and re-runs the restore block after a failed
    # attempt, the second run would overwrite the escape hatch with the broken HTTPS
    # config and there would be no way back short of re-running this installer.
    cp /opt/libredb/caddy/Caddyfile /opt/libredb/caddy/Caddyfile.fallback

    systemctl restart libredb-caddy
    # The fallback must be verified exactly like the primary paths: exhausting
    # this loop and then writing "LibreDB Studio is running" would advertise a
    # dead URL while the deployment reports Succeeded.
    fallback_ok=0
    for _ in $(seq 1 24); do
      if [ "$FALLBACK_MODE" = "http" ]; then
        if curl -fsS "http://127.0.0.1/api/db/health" >/dev/null 2>&1; then
          fallback_ok=1
          break
        fi
      else
        # -k on purpose: the certificate is deliberately self-signed here.
        if curl -fsSk --resolve "${SITE_ADDRESS}:443:127.0.0.1" \
             "https://${SITE_ADDRESS}/api/db/health" >/dev/null 2>&1; then
          fallback_ok=1
          break
        fi
      fi
      sleep 5
    done
    if [ "$fallback_ok" -ne 1 ]; then
      echo "FATAL: the ${FALLBACK_MODE} fallback did not become reachable within 2 minutes" >&2
      docker logs libredb-caddy --tail 100 || true
      exit 1
    fi
  fi
fi

# ------------------------------------------------------------------- notice ---
# Azure Instance Metadata Service — link-local, no traffic leaves the virtual network.
PUBLIC_IP="$(curl -fsS -H 'Metadata:true' --noproxy '*' \
  'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' 2>/dev/null || true)"

case "$FALLBACK_MODE" in
  http)       APP_URL="http://${PUBLIC_IP:-<public-ip>}" ;;
  selfsigned) APP_URL="https://${SITE_ADDRESS}" ;;
  *)          if [ "$SITE_ADDRESS" = ":80" ]; then APP_URL="http://${PUBLIC_IP:-<public-ip>}"
              else APP_URL="https://${SITE_ADDRESS}"; fi ;;
esac

RESTORE_HINT="     First find out WHY the certificate failed - the answer decides what to do:
       docker logs libredb-caddy 2>&1 | grep -i -m5 'acme\|challenge\|rate limit'
     * A connection error or timeout while fetching the challenge means port 80 was not
       reachable from the internet. That is measurable: from ANY machine other than this
       one, run
         curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 http://${SITE_ADDRESS}/
       Any HTTP status (404 included) means port 80 is reachable now. A timeout means it
       is still blocked - do not restore yet.
     * A rate limit cannot be probed at all. Let's Encrypt limits reset on a rolling
       weekly window, so the only remedy is to wait for the window to pass.
     Then restore. The working fallback config is already saved as Caddyfile.fallback, so
     a premature restore is recoverable:
       cp /opt/libredb/caddy/Caddyfile.https /opt/libredb/caddy/Caddyfile
       systemctl restart libredb-caddy
     If HTTPS still fails, go back with:
       cp /opt/libredb/caddy/Caddyfile.fallback /opt/libredb/caddy/Caddyfile
       systemctl restart libredb-caddy"

TLS_NOTE=""
if [ "$FALLBACK_MODE" = "http" ]; then
  TLS_NOTE="
  !! HTTPS was requested but no certificate could be issued, so the application is
     being served over plain HTTP on port 80. Port 443 was open to the internet in
     this deployment, so nothing is reachable that was not reachable before.
     Likely causes: a Let's Encrypt rate limit or outage, or a firewall added after
     deployment.
${RESTORE_HINT}
"
elif [ "$FALLBACK_MODE" = "selfsigned" ]; then
  TLS_NOTE="
  !! HTTPS was requested but no certificate could be issued. Because you restricted
     access to ${WEB_SOURCE}, the application was NOT moved to port 80 - that port is
     open to the internet for the certificate challenge, and moving there would have
     published the application to everyone. It is still served on port 443, inside your
     allowed range, with a SELF-SIGNED certificate, so your browser will warn you.
     Likely causes: a Let's Encrypt rate limit or outage, or a firewall added after
     deployment.
${RESTORE_HINT}
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
