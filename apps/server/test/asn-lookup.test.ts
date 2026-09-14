import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createAsnLookup, loadAsnLookup } from "../src/pipeline/asn-lookup.js";

/** Four real rows from the iptoasn dump, including a "not routed" hole. */
const TSV = [
  "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
  "1.0.1.0\t1.0.3.255\t0\tNone\tNot routed",
  "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
  "2001:200::\t2001:200:ffff:ffff:ffff:ffff:ffff:ffff\t2500\tJP\tWIDE-BB",
  "2600:1f00::\t2600:1f00:ffff:ffff:ffff:ffff:ffff:ffff\t16509\tUS\tAMAZON-02"
].join("\n");

describe("createAsnLookup", () => {
  it("finds both edges of a range and nothing past them", () => {
    const lookup = createAsnLookup(TSV);
    expect(lookup.find("1.0.0.0")).toEqual({ country: "US", asn: 13335, asOrg: "CLOUDFLARENET" });
    expect(lookup.find("1.0.0.255")).toEqual({ country: "US", asn: 13335, asOrg: "CLOUDFLARENET" });
    // One past the end falls into the next range, which is a hole.
    expect(lookup.find("1.0.1.0")).toBeNull();
  });

  it("returns nothing for an address nobody announces", () => {
    const lookup = createAsnLookup(TSV);
    // Inside the "Not routed" row: the file has an entry, but it names no network.
    expect(lookup.find("1.0.2.7")).toBeNull();
    // Below every range in the file.
    expect(lookup.find("0.255.255.255")).toBeNull();
    // Above every IPv4 range in the file.
    expect(lookup.find("9.9.9.9")).toBeNull();
  });

  it("looks up IPv6, including a compressed address", () => {
    const lookup = createAsnLookup(TSV);
    expect(lookup.find("2001:200::1")).toEqual({ country: "JP", asn: 2500, asOrg: "WIDE-BB" });
    expect(lookup.find("2600:1f00:0000:0000:0000:0000:0000:0001")).toEqual({
      country: "US",
      asn: 16509,
      asOrg: "AMAZON-02"
    });
    expect(lookup.find("2400::1")).toBeNull();
  });

  it("never throws on junk input", () => {
    const lookup = createAsnLookup(TSV);
    for (const junk of ["", "not-an-ip", "1.2.3", "999.999.999.999", "::::", "1.0.0.0/24", " "]) {
      expect(lookup.find(junk)).toBeNull();
    }
  });

  it("survives a malformed file instead of refusing to start", () => {
    const lookup = createAsnLookup("garbage\n\n1.0.0.0\tnope\t\n8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE\n");
    // The one good row still works; the broken ones are skipped.
    expect(lookup.find("8.8.8.8")).toEqual({ country: "US", asn: 15169, asOrg: "GOOGLE" });
    expect(lookup.size).toBe(1);
  });

  it("reads a file written with Windows line endings", () => {
    const lookup = createAsnLookup(TSV.split("\n").join("\r\n"));
    // Without stripping the CR the organisation would come back as "GOOGLE\r".
    expect(lookup.find("8.8.8.8")).toEqual({ country: "US", asn: 15169, asOrg: "GOOGLE" });
  });

  it("rejects an ASN that cannot fit in 32 bits instead of wrapping it", () => {
    // 4294967296 wraps to 0 and would read as "not announced"; 4294967297
    // wraps to AS1, silently attributing traffic to the wrong network.
    const lookup = createAsnLookup(
      [
        "10.0.0.0\t10.0.0.255\t4294967296\tUS\tOVERFLOW-ZERO",
        "11.0.0.0\t11.0.0.255\t4294967297\tUS\tOVERFLOW-ONE",
        "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE"
      ].join("\n")
    );
    expect(lookup.size).toBe(1);
    expect(lookup.find("10.0.0.1")).toBeNull();
    expect(lookup.find("11.0.0.1")).toBeNull();
    expect(lookup.find("8.8.8.8")).toEqual({ country: "US", asn: 15169, asOrg: "GOOGLE" });
  });

  it("still answers correctly when the file arrives out of order", () => {
    // Binary search over unsorted ranges returns the wrong network silently,
    // so a hand-edited or concatenated file must be sorted on load.
    const lookup = createAsnLookup(
      [
        "203.0.113.0\t203.0.113.255\t64496\tDE\tLAST",
        "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
        "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
        "2600:1f00::\t2600:1f00:ffff:ffff:ffff:ffff:ffff:ffff\t16509\tUS\tAMAZON-02",
        "2001:200::\t2001:200:ffff:ffff:ffff:ffff:ffff:ffff\t2500\tJP\tWIDE-BB"
      ].join("\n")
    );
    expect(lookup.find("1.0.0.1")?.asOrg).toBe("CLOUDFLARENET");
    expect(lookup.find("8.8.8.8")?.asOrg).toBe("GOOGLE");
    expect(lookup.find("203.0.113.1")?.asOrg).toBe("LAST");
    expect(lookup.find("2001:200::5")?.asOrg).toBe("WIDE-BB");
    expect(lookup.find("2600:1f00::5")?.asOrg).toBe("AMAZON-02");
  });

  it("handles every IPv6 shorthand, and rejects the malformed ones", () => {
    const lookup = createAsnLookup(
      ["::\t::ffff\t100\tXX\tLOWEST", "2001:200::\t2001:200::ffff\t2500\tJP\tWIDE-BB"].join("\n")
    );
    // "::" and "::1" are the first addresses in the space.
    expect(lookup.find("::")?.asOrg).toBe("LOWEST");
    expect(lookup.find("::1")?.asOrg).toBe("LOWEST");
    // Trailing shorthand, and the fully written form of the same address.
    expect(lookup.find("2001:200::")?.asOrg).toBe("WIDE-BB");
    expect(lookup.find("2001:0200:0000:0000:0000:0000:0000:0001")?.asOrg).toBe("WIDE-BB");
    // Two "::" is not a valid address, and nine groups is one too many.
    expect(lookup.find("1::2::3")).toBeNull();
    expect(lookup.find("1:2:3:4:5:6:7:8:9")).toBeNull();
    // "::" must stand for at least one group, so a full eight plus "::" is wrong.
    expect(lookup.find("1:2:3:4:5:6:7:8::")).toBeNull();
  });

  it("is empty, not broken, when the database has no rows", () => {
    const lookup = createAsnLookup("");
    expect(lookup.size).toBe(0);
    expect(lookup.find("8.8.8.8")).toBeNull();
  });
});

describe("loadAsnLookup", () => {
  it("reads a file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asn-"));
    const file = join(dir, "ip2asn.tsv");
    await writeFile(file, TSV);
    const lookup = await loadAsnLookup(file);
    expect(lookup?.find("8.8.8.8")).toEqual({ country: "US", asn: 15169, asOrg: "GOOGLE" });
  });

  it("reads the gzipped dump so the image ships 8 MB instead of 45", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asn-gz-"));
    const file = join(dir, "ip2asn.tsv.gz");
    await writeFile(file, gzipSync(Buffer.from(TSV, "utf8")));
    const lookup = await loadAsnLookup(file);
    expect(lookup?.size).toBe(5);
    expect(lookup?.find("8.8.8.8")).toEqual({ country: "US", asn: 15169, asOrg: "GOOGLE" });
  });

  it("returns null for a corrupt archive rather than refusing to start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asn-bad-"));
    const file = join(dir, "ip2asn.tsv.gz");
    await writeFile(file, Buffer.from("this is not gzip"));
    expect(await loadAsnLookup(file)).toBeNull();
  });

  it("returns null when the file is absent — the server must still start", async () => {
    expect(await loadAsnLookup("/nonexistent/ip2asn.tsv")).toBeNull();
  });
});
