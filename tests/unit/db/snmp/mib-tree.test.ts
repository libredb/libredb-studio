/**
 * The object catalog the provider lists and describes, read from the bundled MIB modules alone.
 *
 * Three claims, each with its own block. The generated definitions agree with the name index they
 * sit beside, so a table, an entry and a column are where `MIB_NAMES` says they are. The listing is
 * in agent order, which is proved on data where the textual order differs, not asserted on data
 * both orders would satisfy. And a description carries what the module declares (the syntax, its
 * base type, the access, the object identifier and the INDEX clause) and nothing the agent said.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { MIB_NAMES } from "@/lib/db/providers/network/snmp/mib-names";
import { MIB_SCALAR_GROUPS, MIB_TABLES } from "@/lib/db/providers/network/snmp/mib-objects";
import { catalogObjects, describeCatalogObject } from "@/lib/db/providers/network/snmp/mib-tree";
import { compareOidAsText } from "@/lib/db/providers/network/snmp/objects";
import { parseDefinitions, renderMibObjects } from "../../../../scripts/generate-snmp-mib-objects";

const oid = (name: string): readonly number[] => {
  const found = MIB_NAMES.get(name);
  if (found === undefined) throw new Error(`${name} is not in MIB_NAMES`);
  return found;
};

describe("the generated definitions agree with the name index", () => {
  test("every table, entry and column is a name the index carries, at the place the tree implies", () => {
    expect(MIB_TABLES.length).toBe(36);
    for (const table of MIB_TABLES) {
      expect(oid(table.entry)).toEqual([...oid(table.name), 1]);
      for (const column of table.columns) expect(oid(column.name)).toEqual([...oid(table.entry), column.subId]);
    }
  });

  test("every scalar sits directly under its group", () => {
    expect(MIB_SCALAR_GROUPS.length).toBe(16);
    for (const group of MIB_SCALAR_GROUPS) {
      for (const scalar of group.scalars) expect(oid(scalar.name)).toEqual([...oid(group.name), scalar.subId]);
    }
  });

  test("an AUGMENTS entry carries the index of the entry it augments", () => {
    const ifX = MIB_TABLES.find((table) => table.name === "ifXTable");
    expect(ifX?.augments).toBe("ifEntry");
    expect(ifX?.index).toEqual(["ifIndex"]);
  });
});

describe("the listing is the bundled tree, in agent order", () => {
  test("tables are listed by sub-identifier, which is not their textual order", () => {
    const tables = catalogObjects("table");
    expect(tables.map((object) => object.name)).toHaveLength(MIB_TABLES.length);
    const textual = [...tables].sort((a, b) => compareOidAsText(a.oid, b.oid)).map((object) => object.name);
    expect(tables.map((object) => object.name)).not.toEqual(textual);
    expect(tables[0]).toEqual({ kind: "table", name: "sysORTable", module: "SNMPv2-MIB", oid: oid("sysORTable") });
    expect(tables.findIndex((t) => t.name === "ifTable")).toBeLessThan(
      tables.findIndex((t) => t.name === "hrStorageTable"),
    );
  });

  test("scalar groups are listed by sub-identifier too, with their module", () => {
    const groups = catalogObjects("scalars");
    expect(groups.map((object) => object.name).slice(0, 3)).toEqual(["system", "interfaces", "ip"]);
    expect(groups.find((object) => object.name === "snmpEngine")?.module).toBe("SNMP-FRAMEWORK-MIB");
  });

  test("a deprecated table says so, and a current one carries no status", () => {
    const tables = catalogObjects("table");
    expect(tables.find((object) => object.name === "udpTable")?.status).toBe("deprecated");
    expect(tables.find((object) => object.name === "ifTable")).not.toHaveProperty("status");
  });
});

describe("a description is what the module declares", () => {
  test("a table's columns carry the syntax, the base type, the access and the identifier", () => {
    const detail = describeCatalogObject("ifTable", "table");
    expect(detail.path).toEqual(["ifTable"]);
    expect(detail.columns.map((column) => column.name).slice(0, 3)).toEqual(["ifIndex", "ifDescr", "ifType"]);
    expect(detail.columns[0]).toEqual({
      name: "ifIndex",
      type: "InterfaceIndex",
      baseType: "Integer32",
      declaredType: "InterfaceIndex, read-only, 1.3.6.1.2.1.2.2.1.1",
      nullable: false,
      isPrimary: true,
    });
    // A column with no textual convention has no base type to name.
    const inOctets = detail.columns.find((column) => column.name === "ifInOctets");
    expect(inOctets).toEqual({
      name: "ifInOctets",
      type: "Counter32",
      declaredType: "Counter32, read-only, 1.3.6.1.2.1.2.2.1.10",
      nullable: true,
      isPrimary: false,
    });
    expect(detail.indexes).toEqual([{ name: "ifEntry", columns: ["ifIndex"], unique: true }]);
    expect(detail.foreignKeys).toEqual([]);
  });

  test("an index column that cannot be read is not offered for projection", () => {
    const detail = describeCatalogObject("ipAddressTable", "table");
    const addrType = detail.columns.find((column) => column.name === "ipAddressAddrType");
    expect(addrType?.isPrimary).toBe(true);
    expect(addrType?.projectable).toBe(false);
    expect(addrType?.declaredType).toContain("not-accessible");
    expect(detail.indexes).toEqual([
      { name: "ipAddressEntry", columns: ["ipAddressAddrType", "ipAddressAddr"], unique: true },
    ]);
  });

  test("an augmenting table's index names a column it does not hold, so none of its own is primary", () => {
    const detail = describeCatalogObject("ifXTable", "table");
    expect(detail.columns.some((column) => column.isPrimary)).toBe(false);
    expect(detail.indexes).toEqual([{ name: "ifXEntry", columns: ["ifIndex"], unique: true }]);
  });

  test("a scalar group's columns are its scalars, with no index", () => {
    const detail = describeCatalogObject("system", "scalars");
    expect(detail.columns.map((column) => column.name)).toEqual([
      "sysDescr",
      "sysObjectID",
      "sysUpTime",
      "sysContact",
      "sysName",
      "sysLocation",
      "sysServices",
      "sysORLastChange",
    ]);
    expect(detail.columns[4]).toEqual({
      name: "sysName",
      type: "DisplayString",
      baseType: "OCTET STRING",
      declaredType: "DisplayString, read-write, 1.3.6.1.2.1.1.5",
      nullable: true,
      isPrimary: false,
    });
    expect(detail.indexes).toEqual([]);
  });

  test("a scalar meant only for notifications is not offered for projection either", () => {
    const trapOid = describeCatalogObject("snmpTrap", "scalars").columns.find((c) => c.name === "snmpTrapOID");
    expect(trapOid?.projectable).toBe(false);
  });

  test("a name the bundled modules do not define is refused with the reason", () => {
    expect(() => describeCatalogObject("entPhysicalTable", "table")).toThrow(QueryError);
    expect(() => describeCatalogObject("noSuchTable", "table")).toThrow(/not in any module this build carries/);
  });

  test("a name of the other kind is refused by its kind, not described as this one", () => {
    expect(() => describeCatalogObject("system", "table")).toThrow(/`system` is a group of scalars, not a table/);
    expect(() => describeCatalogObject("ifTable", "scalars")).toThrow(/`ifTable` is a table, not a group of scalars/);
    expect(() => describeCatalogObject("sysDescr", "scalars")).toThrow(
      /`sysDescr` is not a table or a group of scalars in the bundled modules/,
    );
  });
});

describe("the generator reads snmptranslate the way the committed module was written", () => {
  const SAMPLE = [
    "SNMPv2-MIB::system",
    "system OBJECT-TYPE",
    "  -- FROM\tSNMPv2-MIB",
    "::= { iso(1) org(3) dod(6) internet(1) mgmt(2) mib-2(1) 1 }",
    "",
    "SNMPv2-MIB::sysDescr",
    "sysDescr OBJECT-TYPE",
    "  -- FROM\tSNMPv2-MIB",
    "  -- TEXTUAL CONVENTION DisplayString",
    "  SYNTAX\tOCTET STRING (0..255) ",
    "  MAX-ACCESS\tread-only",
    "  STATUS\tcurrent",
    "::= { iso(1) org(3) dod(6) internet(1) mgmt(2) mib-2(1) system(1) 1 }",
    "",
    "IP-MIB::ipAddressEntry",
    "ipAddressEntry OBJECT-TYPE",
    "  -- FROM\tIP-MIB",
    "  MAX-ACCESS\tnot-accessible",
    "  INDEX\t\t{ ipAddressAddrType, IMPLIED ipAddressAddr }",
    "",
  ].join("\n");

  test("a block yields its module, convention, base syntax, access and index", () => {
    expect(parseDefinitions(SAMPLE)).toEqual([
      { name: "system", module: "SNMPv2-MIB" },
      {
        name: "sysDescr",
        module: "SNMPv2-MIB",
        textualConvention: "DisplayString",
        syntax: "OCTET STRING",
        access: "read-only",
        status: "current",
      },
      {
        name: "ipAddressEntry",
        module: "IP-MIB",
        access: "not-accessible",
        index: ["ipAddressAddrType", "ipAddressAddr"],
      },
    ]);
  });

  test("an entry with no table above it is refused rather than dropped", () => {
    expect(() =>
      renderMibObjects([{ name: "ipAddressEntry", module: "IP-MIB", access: "not-accessible", index: ["x"] }]),
    ).toThrow(/has no table above it/);
  });
});
