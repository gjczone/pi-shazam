import { describe, it, expect } from "vitest";
import { redact, SECRET_PATTERNS } from "../core/redact.js";

describe("redact smoke", () => {
  it("redacts PEM private key blocks", () => {
    const input = `line1
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3...
abc123def456ghi789
-----END RSA PRIVATE KEY-----
line2`;
    const result = redact(input);
    expect(result).not.toContain("PRIVATE KEY");
    expect(result).not.toContain("MIIEp");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    // Only one [REDACTED] for the PEM block
    const redactCount = (result.match(/\[REDACTED\]/g) || []).length;
    expect(redactCount).toBe(1);
  });

  it("redacts connection strings", () => {
    // Pattern redacts credentials portion (protocol://user:pass@), host info preserved
    const cases: [string, string][] = [
      ["mongodb://admin:secret123@localhost:27017", "[REDACTED]localhost:27017"],
      // Real connection strings URL-encode @ as %40 in passwords
      ["postgresql://user:p%40ssw0rd@host/db", "[REDACTED]host/db"],
      ["postgres://user:pass@host/db", "[REDACTED]host/db"],
      ["mysql://root:password@localhost/db", "[REDACTED]localhost/db"],
      ["redis://default:mypass@localhost:6379", "[REDACTED]localhost:6379"],
    ];
    for (const [input, expected] of cases) {
      expect(redact(input)).toBe(expected);
    }
  });

  it("redacts bearer tokens", () => {
    expect(redact("bearer abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
    expect(redact("Bearer xyz1234567890abcdef_+-=")).toContain("[REDACTED]");
    expect(redact("Authorization: bearer aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_+=")).toContain("[REDACTED]");
  });

  it("combined: PEM + connections + bearer", () => {
    const input = `INFO: mongodb://user:pass@db.com
DEBUG: bearer abcdefghijklmnopqrstuvwxyz
INFO: key
-----BEGIN PRIVATE KEY-----
base64body
-----END PRIVATE KEY-----
INFO: done`;
    const result = redact(input);
    expect(result).not.toContain("mongodb://user:pass@db.com");
    expect(result).not.toContain("PRIVATE KEY");
    expect(result).not.toContain("base64body");
    expect(result).toContain("INFO: done");
  });
});
