# The SNMP fixture: a real Net-SNMP agent, not a model of one.
#
# WHY A REAL AGENT AND NOT OUR OWN. This provider's client is this repository's own code over
# `node:dgram`, so an agent written here would share the decoder it is meant to test and a defect
# in both would be invisible. Net-SNMP is the reference implementation, and the defects this
# fixture exists to catch are the ones that only a conforming agent shows: a GetBulk asking for
# zero repetitions is answered with an empty varbind list, which is exactly what this provider
# sent until 14 October 2026 and what turned every `walk` into "0 rows" with no error.
#
# PINNED TWICE. The base carries a digest, because `debian:trixie-slim` is a moving tag, and the
# two packages carry their exact versions, because a Debian point release replaces them under the
# same tag. Both were read on 15 October 2026 from the archive this build uses.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    snmpd=5.9.4+dfsg-2+deb13u1 \
    snmp=5.9.4+dfsg-2+deb13u1 \
  && rm -rf /var/lib/apt/lists/*

COPY snmpd.conf /etc/snmp/snmpd.conf
COPY playpen.sh /usr/local/bin/playpen.sh
RUN chmod +x /usr/local/bin/playpen.sh

# 161 inside the container; the compose file moves it above the privileged range on the host.
EXPOSE 161/udp

# Foreground, logging to stdout, reading ONLY the configuration file this image carries: without
# `-C` the agent also reads /var/lib/snmp and the packaged defaults, and a fixture that answers
# from a file nobody wrote is a fixture that cannot be reasoned about.
CMD ["/usr/sbin/snmpd", "-f", "-Lo", "-C", "-c", "/etc/snmp/snmpd.conf"]
