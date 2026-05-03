import { describe, expect, it } from "vitest";
import { formatReport, type DoctorReport } from "./doctor.js";

describe("doctor formatting", () => {
  it("renders an OK report cleanly", () => {
    const r: DoctorReport = {
      ok: true,
      probes: [
        { name: "config", ok: true, message: "config schema OK" },
        { name: "pg.connect", ok: true, message: "connected" },
      ],
    };
    const out = formatReport(r);
    expect(out).toContain("memory-postgres doctor: OK");
    expect(out).toMatch(/\[OK\]\s+config: config schema OK/);
    expect(out).toMatch(/\[OK\]\s+pg\.connect: connected/);
  });

  it("marks failures and overall status", () => {
    const r: DoctorReport = {
      ok: false,
      probes: [
        { name: "config", ok: true, message: "config schema OK" },
        { name: "pg.connect", ok: false, message: "ECONNREFUSED" },
      ],
    };
    const out = formatReport(r);
    expect(out).toContain("memory-postgres doctor: FAIL");
    expect(out).toMatch(/\[FAIL\]\s+pg\.connect: ECONNREFUSED/);
  });
});
