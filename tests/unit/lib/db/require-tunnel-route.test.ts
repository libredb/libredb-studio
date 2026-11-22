import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { requireTunnelRoute, TUNNEL_ROUTE_MISSING } from "@/lib/db/utils/require-tunnel-route";
import { type DatabaseConnection, TUNNEL_ROUTE, type WithTunnelRoute } from "@/lib/types";

/**
 * A provider that frames the SSH tunnel's route reads the one Studio's provider factory set under `TUNNEL_ROUTE`, and
 * never `sshTunnel`, so one built without the factory refuses by name rather than framing no route (FND-2 slice 5b).
 */
describe("requireTunnelRoute (FND-2 slice 5b)", () => {
  const base: DatabaseConnection = {
    id: "fnd2",
    name: "fnd2",
    type: "databend",
    host: "127.0.0.1",
    port: 41001,
    createdAt: new Date(0),
  };

  test("answers the route core set under TUNNEL_ROUTE", () => {
    const routed: DatabaseConnection & WithTunnelRoute = { ...base, [TUNNEL_ROUTE]: "4:true12:bastion.test2:224:jump" };
    expect(requireTunnelRoute(routed, "databend")).toBe("4:true12:bastion.test2:224:jump");
  });

  test("refuses a connection that carries none, naming its type and quoting no value", () => {
    const unrouted = {
      ...base,
      sshTunnel: {
        enabled: true,
        host: "bastion.test",
        port: 22,
        username: "jump",
        authMethod: "password" as const,
        password: crypto.randomUUID(),
      },
    };
    let caught: unknown;
    try {
      requireTunnelRoute(unrouted, "databend");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseConfigError);
    const refusal = caught as DatabaseConfigError;
    expect(refusal.provider).toBe("databend");
    expect(refusal.message).toBe(TUNNEL_ROUTE_MISSING);
    expect(refusal.message).not.toContain("bastion.test");
    expect(refusal.message).not.toContain(unrouted.sshTunnel.password);
    expect(TUNNEL_ROUTE_MISSING).toBe(
      "This connection carries a tunnel's far end and no tunnel route, so its provider was not built by Studio's provider factory: build it with createDatabaseProvider inside withOneShotTunnel, or get it from getOrCreateProvider",
    );
  });
});
