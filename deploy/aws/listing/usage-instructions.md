# LibreDB Studio - usage instructions

Pasted into the AWS Marketplace Management Portal's usage instructions field.
AWS grades this field: the items below are the ones its guide makes mandatory
for an AMI product, so nothing here is optional prose.

## 1. Launch

Launch the AMI with the recommended security group: TCP 3000 and TCP 22, both
scoped to your own CIDR. The instance needs no user data and no AWS credentials;
it assumes no IAM role and the seller has no access to it.

First boot takes about a minute. It generates an administrator password that is
unique to this instance, starts the application, then publishes a banner.

## 2. Sign in

Open `http://<instance-public-ip>:3000`.

Retrieve the generated password in either of two ways:

- No SSH key pair: EC2 console -> Actions -> Monitor and troubleshoot -> Get
  system log. The first-boot banner is printed there. This is the one place the
  password is published; anyone holding `ec2:GetConsoleOutput` on the account
  can read it.
- SSH: log in as `ubuntu` and run `sudo cat /etc/libredb-studio.info`. The login
  greeting shows the same banner with the password line replaced by that
  pointer, because the greeting is cached in a world-readable file.

Sign in as `admin@libredb.org` with that password.

## 3. Change the password immediately after first login

The application has no in-app password change today, so rotation is a file edit:

    sudo nano /etc/libredb-studio.env
    sudo systemctl restart libredb-studio

Change the `ADMIN_PASSWORD` line, and `ADMIN_EMAIL` too if you want your own
address. The file is plain `KEY=value` lines read by `docker --env-file`: write
the value bare, with no quotes and no line breaks. Edit the file rather than
running a `sed` one-liner - a password containing `/` or `&` corrupts the line.

Rotating `JWT_SECRET` is a different operation, and a destructive one: it
invalidates every session AND makes every saved connection credential
unreadable, because the key that seals them in the store is derived from it.
Rotate it only on a fresh instance, or accept that the saved connections have to
be entered again.

## 4. Where your data lives

| What | Where |
|---|---|
| Saved connections. The secret fields - database passwords, connection strings, TLS keys, SSH keys - are sealed with AES-256-GCM before they are written, under a key derived from `JWT_SECRET`. The rest of the record (host, port, database name, query history) is stored as written. | `/opt/libredb/data/libredb-storage.db` (mode 0700 directory) |
| Administrator password and `JWT_SECRET` | `/etc/libredb-studio.env` (mode 0600) |
| First-boot banner | `/etc/libredb-studio.info` (mode 0600) |
| A copy of the environment file, held by the container runtime | `/var/lib/docker/containers/<container id>/config.v2.json` (root only). It also appears in `sudo docker inspect libredb-studio` output, so redact that before pasting it into a support ticket. |

The store is placed by `STORAGE_PROVIDER=sqlite` and
`STORAGE_SQLITE_PATH=/app/data/libredb-storage.db`; `/opt/libredb/data` on the
instance is mounted into the container as `/app/data`.

Encryption: the AMI ships with an unencrypted snapshot, as AWS Marketplace
requires, and you can enable EBS encryption for the volume at launch. Inside the
instance, the credential fields in the store are already encrypted at rest as
described above; the key lives in `/etc/libredb-studio.env`, outside the store
file, so a copy of the database file alone does not disclose them. Both files
sit on the instance's single root volume, so an EBS snapshot captures the key
along with the data - treat a snapshot with the same care as the credentials
themselves.

Backup and restore: back up the data directory **and** the environment file
together. The environment file holds `JWT_SECRET`, and without it the saved
credentials in the data file cannot be decrypted on the instance you restore to.

    sudo systemctl stop libredb-studio
    sudo tar czf libredb-backup.tar.gz -C / opt/libredb/data etc/libredb-studio.env
    sudo systemctl start libredb-studio

Restore both files with the service stopped, then start it again. An EBS
snapshot of the whole volume captures both, because the environment file is on
the same volume.

## 5. Health and proper function

    sudo docker inspect -f '{{.State.Running}}' libredb-studio   # container up
    curl -fsS http://127.0.0.1:3000/api/db/health                # server answers
    curl -fsS http://127.0.0.1:3000/login                        # app serves pages
    systemctl status libredb-studio
    sudo docker logs libredb-studio

The health route answers with a static payload without touching the database or
the auth configuration, so it proves the server process is up and nothing more.
The three checks together are what tells you the instance is healthy. EC2's own
status checks cover the instance.

Every `docker` command above needs `sudo`: the daemon socket is root-owned, and
the `ubuntu` user is deliberately not in the `docker` group.

## 6. The public address changes across a stop and start

Stopping and starting the instance assigns a new public IP. The credentials are
unaffected and the login greeting shows the current address. Attach an Elastic
IP, or put a load balancer in front, if you need a stable one.

## 7. TLS

The standalone AMI serves plain HTTP on port 3000 and sets
`AUTH_COOKIE_SECURE=false`, because an instance with no DNS name of its own
cannot obtain a publicly trusted certificate at first boot. The session cookie
therefore travels in cleartext: keep the security group scoped to your own CIDR,
and put an Application Load Balancer or CloudFront with an ACM certificate in
front of the instance if you need TLS.

## 8. External dependencies

A normal launch reaches no registry: the application image is baked into the AMI
and pinned by digest. The only outbound connections are the ones you configure -
your own database endpoints, and an LLM endpoint if you set `LLM_API_URL`. The
product ships with no model provider configured and is fully functional with AI
switched off, so no external subscription is required to use it.

## 9. What the instance costs

The software is free. You pay AWS for the EC2 instance hours, the EBS volume
(20 GiB gp3 by default) and data transfer, at the published AWS rates. T-family
instances launch in unlimited credit mode by default, which converts credit
exhaustion into a surcharge rather than a slowdown.

## 10. Service quotas

One instance, one 20 GiB volume and one security group. If your account is at
its EC2 instance or EBS volume quota, request an increase in Service Quotas
before launching.

## 11. SSH access

The AMI ships with SSH password authentication disabled and root password login
disabled; you log in as `ubuntu` with the key pair you chose at launch, and that
user has passwordless `sudo`. This is the state of the image as published - the
instance is yours, so its owner can re-enable password logins through user data
or by editing the configuration, and nothing in the image prevents that.

The seller has no access to your instance: no key, no agent and no callback ship
in the image.

## 12. Release notes

Each version's notes are published on the listing's version page and link to the
matching GitHub release. They carry one of the labels AWS uses:

- `Critical` - a security fix. Update as soon as you can.
- `Important` - a bug fix or a change in behaviour worth planning for.
- `Optional` - new features and routine maintenance.

Version 0.14.0 is the initial listing and is labelled `Optional`.

## 13. Upgrades

New versions ship as new AMI versions in this listing. To move to one, launch an
instance from the new version, copy `/opt/libredb/data` and
`/etc/libredb-studio.env` across from the old instance - both, for the reason in
section 4 - and start the service.
There is no in-place upgrade path on a running instance.
