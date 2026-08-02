// The notebook kernel's egress allow-list.
//
// A kernel runs operator-supplied AND user-supplied Python. Its network policy
// is a squid dstdomain ACL rendered from this module, so what this function
// accepts is the sandbox's outbound boundary.
//
// The module's own header says it is a pure module "so the rendering and
// hostname rules can be unit-tested". It had no tests.
//
// THE BUG THESE WERE WRITTEN FOR: the hostname test was
// /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, which admits digits in every label, so IP
// ADDRESSES passed. `10.0.0.1` became the ACL entry `.10.0.0.1`. squid matches
// dstdomain by DNS suffix, so that entry can never match a request to that
// address — it sits in the file doing nothing while an operator believes they
// allowed it. Fails closed, so it was never a hole; it was a control that
// silently did not do what its configuration said.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EGRESS_BASELINE,
  normalizeEgressHost,
  renderEgressAllowlist,
} from "@/utils/notebookRuntime/egress";

const entries = (s: string) => s.split("\n").filter((l) => l.trim() && !l.startsWith("#"));

describe("normalizeEgressHost accepts real hostnames", () => {
  it("adds the leading dot squid needs for subdomain matching", () => {
    // Without it, a package install redirecting to codeload.github.com fails.
    expect(normalizeEgressHost("github.com")).toBe(".github.com");
  });

  it("normalises the forms someone actually pastes", () => {
    for (const raw of [
      "github.com",
      ".github.com",
      "*.github.com",
      "https://github.com/some/path",
      "http://user:pw@github.com",
      "github.com:443",
      "  GitHub.COM  ",
    ]) {
      expect(normalizeEgressHost(raw), raw).toBe(".github.com");
    }
  });

  it("takes the host, not a lookalike hidden in the path", () => {
    // The @ strip runs after the path strip, so this is evil.com's entry.
    expect(normalizeEgressHost("evil.com/@good.com")).toBe(".evil.com");
  });

  it("allows punycode and multi-level domains", () => {
    expect(normalizeEgressHost("xn--bcher-kva.example")).toBe(".xn--bcher-kva.example");
    expect(normalizeEgressHost("files.pythonhosted.org")).toBe(".files.pythonhosted.org");
  });
});

describe("normalizeEgressHost rejects what would sit in the ACL inert", () => {
  it("rejects IP addresses, which dstdomain can never match", () => {
    for (const ip of ["192.168.1.1", "10.0.0.1", "127.0.0.1", "169.254.169.254", "8.8.8.8"]) {
      expect(normalizeEgressHost(ip), ip).toBeNull();
    }
  });

  it("rejects IPv6 forms", () => {
    for (const ip of ["::1", "[::1]", "fe80::1", "[fe80::1]:8080"]) {
      expect(normalizeEgressHost(ip), ip).toBeNull();
    }
  });

  it("rejects single-label and malformed hosts", () => {
    for (const bad of ["localhost", "", "   ", "#comment", "a..b.com", "not a host", "."]) {
      expect(normalizeEgressHost(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects labels with a leading or trailing hyphen", () => {
    // Not valid per RFC 1123; squid would carry an entry nothing resolves to.
    for (const bad of ["-lead.com", "trail-.com", "a.-b.com", "a.b-.com"]) {
      expect(normalizeEgressHost(bad), bad).toBeNull();
    }
  });

  it("rejects an over-long host or label", () => {
    expect(normalizeEgressHost(`${"a".repeat(64)}.com`)).toBeNull();
    expect(normalizeEgressHost(`${"a".repeat(60)}.`.repeat(5) + "com")).toBeNull();
  });
});

describe("renderEgressAllowlist", () => {
  it("always includes the baseline, so pip cannot be locked out", () => {
    // The runtime's purpose is running Python; no PyPI, no point.
    const out = entries(renderEgressAllowlist([]));
    for (const host of EGRESS_BASELINE) expect(out).toContain(`.${host}`);
  });

  it("keeps the baseline even when the operator's list is junk", () => {
    const out = entries(renderEgressAllowlist(["not a host", "169.254.169.254", ""]));
    expect(out).toEqual(EGRESS_BASELINE.map((h) => `.${h}`));
  });

  it("de-duplicates across the baseline and the operator's list", () => {
    const out = entries(renderEgressAllowlist(["pypi.org", ".pypi.org", "https://pypi.org/x"]));
    expect(out.filter((l) => l === ".pypi.org")).toHaveLength(1);
  });

  it("adds operator hosts alongside the baseline", () => {
    const out = entries(renderEgressAllowlist(["github.com"]));
    expect(out).toContain(".github.com");
    expect(out).toContain(".pypi.org");
  });

  it("says where the file comes from, since it is overwritten", () => {
    // An operator who hand-edits this file loses the edit on the next save.
    expect(renderEgressAllowlist([])).toMatch(/overwritten/i);
  });
});

describe("the admin UI says which entries it will discard", () => {
  // Rejecting an entry correctly is half the job on a security control; the
  // other half is telling the person who typed it. Until this, an operator
  // could type 10.0.0.1, watch it save, and believe egress to it was
  // permitted — the entry persisted in the textarea and simply never reached
  // the squid ACL. Silent either way: inert before the parser was fixed,
  // dropped after it.
  const ui = readFileSync("src/components/admin/RuntimeTab.tsx", "utf8");

  it("derives the rejected list with the SAME function that drops them", () => {
    // A second copy of the rule here would be a warning that can disagree with
    // the behaviour it is describing — which is the failure mode this codebase
    // has hit three times over.
    expect(ui).toMatch(/import \{ normalizeEgressHost \} from "@\/utils\/notebookRuntime\/egress"/);
    expect(ui).toMatch(/normalizeEgressHost\(s\) === null/);
  });

  it("does not re-implement the hostname rule in the component", () => {
    expect(ui, "a second hostname pattern is declared in the admin UI").not.toMatch(
      /\[a-z0-9-\]\+\(\\.\[a-z0-9-\]\+\)\+/,
    );
  });

  it("renders a warning only when something was rejected", () => {
    expect(ui).toMatch(/rejectedEgress\.length > 0 &&/);
    expect(ui).toMatch(/Ignored — not a hostname the proxy can match/);
  });

  it("ignores comment lines rather than reporting them as errors", () => {
    // The renderer already skips them; flagging them would be a false alarm.
    expect(ui).toMatch(/!s\.startsWith\("#"\)/);
  });
});
