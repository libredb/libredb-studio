# The single-client device of server.c, built on the libmodbus Debian ships. Used only by the agent
# boundary capture; nothing in CI builds it.
FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libmodbus-dev libmodbus5 pkg-config \
  && rm -rf /var/lib/apt/lists/*
COPY server.c /src/server.c
RUN gcc -O2 -o /usr/local/bin/single-client-modbus /src/server.c $(pkg-config --cflags --libs libmodbus)
EXPOSE 502
CMD ["/usr/local/bin/single-client-modbus"]
