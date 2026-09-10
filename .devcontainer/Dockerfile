FROM mcr.microsoft.com/devcontainers/javascript-node:5-24-bookworm

# Keep these versions aligned with .github/workflows/ci.yml.
ARG BUN_VERSION=1.4.2
ARG HELM_VERSION=4.1.3

USER root

# The standalone Windows archive tests invoke 7z on every development platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --allow-scripts=bun bun@${BUN_VERSION}

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    archive="helm-v${HELM_VERSION}-linux-${arch}.tar.gz"; \
    cd /tmp; \
    curl -fsSLO "https://get.helm.sh/${archive}"; \
    curl -fsSLO "https://get.helm.sh/${archive}.sha256sum"; \
    sha256sum --check "${archive}.sha256sum"; \
    tar -xzf "${archive}"; \
    install -m 0755 "linux-${arch}/helm" /usr/local/bin/helm; \
    rm -rf "linux-${arch}" "${archive}" "${archive}.sha256sum"

USER node
