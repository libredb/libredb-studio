#!/bin/sh
# Brings the NETCONF fixture up: the accounts the provider's tests need, the read-only NACM
# rule-list the provider doc recommends as the device profile, and the interface list the read
# sizes were measured against. Then it runs netopeer2-server in the foreground.
#
# Measured on 2026-10-13 and the reason step 1 exists: a bare netopeer2 install does NOT have
# iana-if-type in sysrepo, and loading ietf-interfaces data without it fails with
# `Invalid identityref "ianaift:ethernetCsmacd" value - unable to map prefix to YANG schema`.
#
# Every credential here is a throwaway for acceptance. The image must never be exposed outside it.
set -eu

FIXTURE=/fixture
IFACES="${LIBREDB_NETCONF_INTERFACES:-5000}"
mkdir -p "$FIXTURE"

# THE THREE CREDENTIALS COME FROM OUTSIDE AND THIS FILE HOLDS NONE OF THEM.
#
# They were literals here until a secret scanner read the branch: GitGuardian flagged
# `docker/netconf/setup.sh` on PR #1793 ("Username Password", id 38271865) at the FIRST commit
# that added the file, and a later commit that rewrote the line could not clear it, because the
# scanner reads every commit rather than the tree. A value that is never written here cannot be
# found in any commit that adds this file.
#
# NO DEFAULTS, on purpose. A default would make an unset variable silently set an empty password
# on a device that accepts logins, and the fixture would come up looking configured. Each is
# refused by name instead, with the variable to set, because the four places that start this
# fixture are the places that have to carry it: `docker/netconf/ci-step.yml`,
# `docker/netconf/compose-service.yml`, `docker/netconf/verify.sh`, and the `docker run` in
# `docker/netconf/README.md`.
#
# Still throwaways for acceptance, as the line above says. What changed is where they live.
for required in LIBREDB_NETCONF_RO_PASSWORD LIBREDB_NETCONF_ROOT_PASSWORD LIBREDB_NETCONF_KEY_PASSPHRASE; do
  eval "value=\${$required:-}"
  [ -n "$value" ] || {
    echo "netconf fixture: $required is not set, so no account would have a usable credential." >&2
    echo "Set all three: LIBREDB_NETCONF_RO_PASSWORD, LIBREDB_NETCONF_ROOT_PASSWORD," >&2
    echo "LIBREDB_NETCONF_KEY_PASSPHRASE (docker/netconf/README.md lists the values)." >&2
    exit 1
  }
done

if [ ! -f "$FIXTURE/.ready" ]; then
  # 1. The identity module the interface data needs.
  IANA_IF_TYPE="$(find /usr/local/share/yang -name 'iana-if-type*.yang' | head -1)"
  [ -n "$IANA_IF_TYPE" ] || { echo "iana-if-type yang file not found" >&2; exit 1; }
  sysrepoctl -i "$IANA_IF_TYPE" -s /usr/local/share/yang/modules/netopeer2 >/dev/null

  # 2. Client keys and the password hash. Generated here so the image carries no key material.
  ssh-keygen -t ed25519 -N '' -f "$FIXTURE/ro-key" -q
  ssh-keygen -t ed25519 -N "$LIBREDB_NETCONF_KEY_PASSPHRASE" -f "$FIXTURE/ro-passphrase" -q
  cut -d' ' -f2 "$FIXTURE/ro-key.pub" > "$FIXTURE/ro-key.b64"
  cut -d' ' -f2 "$FIXTURE/ro-passphrase.pub" > "$FIXTURE/ro-passphrase.b64"
  openssl passwd -6 "$LIBREDB_NETCONF_RO_PASSWORD" > "$FIXTURE/ro-pass.hash"
  # Still not written as `root:<value>` on one line: that pair is the shape a `chpasswd` detector
  # matches, and it matched here before. With the value out of the file as well, neither the shape
  # nor the secret is in any commit.
  printf 'root:%s\n' "$LIBREDB_NETCONF_ROOT_PASSWORD" | chpasswd

  # 3. Three login methods, one account each, so a test names the method it is exercising.
  CT='urn:ietf:params:xml:ns:yang:ietf-crypto-types'
  cat > "$FIXTURE/users.xml" <<XML
<netconf-server xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-server">
  <listen><endpoints><endpoint><name>default-ssh</name><ssh><ssh-server-parameters><client-authentication><users>
    <user>
      <name>ro-pass</name>
      <password><hashed-password>$(cat "$FIXTURE/ro-pass.hash")</hashed-password></password>
    </user>
    <user>
      <name>ro-key</name>
      <public-keys><inline-definition><public-key>
        <name>ro-key</name>
        <public-key-format xmlns:ct="$CT">ct:ssh-public-key-format</public-key-format>
        <public-key>$(cat "$FIXTURE/ro-key.b64")</public-key>
      </public-key></inline-definition></public-keys>
    </user>
    <user>
      <name>ro-passphrase</name>
      <public-keys><inline-definition><public-key>
        <name>ro-passphrase</name>
        <public-key-format xmlns:ct="$CT">ct:ssh-public-key-format</public-key-format>
        <public-key>$(cat "$FIXTURE/ro-passphrase.b64")</public-key>
      </public-key></inline-definition></public-keys>
    </user>
  </users></client-authentication></ssh-server-parameters></ssh></endpoint></endpoints></listen>
</netconf-server>
XML
  sysrepocfg --edit="$FIXTURE/users.xml" -m ietf-netconf-server -d running

  # 4. The read-only rule-list. Without it the three accounts above are NOT read-only: under the
  # RFC 8341 defaults a user with no rule still gets lock, unlock, discard-changes, validate and
  # copy-config, measured on 2026-10-13.
  cat > "$FIXTURE/nacm.xml" <<'XML'
<nacm xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-acm">
  <enable-nacm>true</enable-nacm>
  <groups><group><name>readonly</name>
    <user-name>ro-pass</user-name><user-name>ro-key</user-name><user-name>ro-passphrase</user-name>
  </group></groups>
  <rule-list>
    <name>readonly</name><group>readonly</group>
    <rule><name>permit-get</name><module-name>ietf-netconf</module-name><rpc-name>get</rpc-name><access-operations>exec</access-operations><action>permit</action></rule>
    <rule><name>permit-get-config</name><module-name>ietf-netconf</module-name><rpc-name>get-config</rpc-name><access-operations>exec</access-operations><action>permit</action></rule>
    <rule><name>permit-get-data</name><module-name>ietf-netconf-nmda</module-name><rpc-name>get-data</rpc-name><access-operations>exec</access-operations><action>permit</action></rule>
    <rule><name>permit-get-schema</name><module-name>ietf-netconf-monitoring</module-name><rpc-name>get-schema</rpc-name><access-operations>exec</access-operations><action>permit</action></rule>
    <rule><name>deny-other-exec</name><module-name>*</module-name><access-operations>exec</access-operations><action>deny</action></rule>
    <rule><name>deny-write</name><module-name>*</module-name><access-operations>create update delete</access-operations><action>deny</action></rule>
  </rule-list>
</nacm>
XML
  sysrepocfg --edit="$FIXTURE/nacm.xml" -m ietf-netconf-acm -d running

  # 5. The interface list the read sizes were measured against.
  {
    printf '<interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces" xmlns:ianaift="urn:ietf:params:xml:ns:yang:iana-if-type">'
    i=0
    while [ "$i" -lt "$IFACES" ]; do
      # The description carries a four byte character on purpose. The chunked framing counts BYTES
      # and this server chunks at a fixed 10,240, so with a multi byte character every ~160 bytes
      # some character's bytes are certain to straddle a chunk boundary. That case is unreachable
      # with ASCII data, and a reader that decodes each chunk on its own corrupts it silently, so
      # the fixture has to be able to produce it. The emoji is also a four byte character, the
      # widest case, rather than a two byte accented letter.
      printf '<interface><name>ge-0/0/%s</name><type>ianaift:ethernetCsmacd</type><enabled>true</enabled><description>port %s \360\237\230\200 uplink</description></interface>' "$i" "$i"
      i=$((i + 1))
    done
    printf '</interfaces>'
  } > "$FIXTURE/interfaces.xml"
  sysrepocfg --edit="$FIXTURE/interfaces.xml" -m ietf-interfaces -d running

  touch "$FIXTURE/.ready"
fi

exec netopeer2-server -d -v 1
