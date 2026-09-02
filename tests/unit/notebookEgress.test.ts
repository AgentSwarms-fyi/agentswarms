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

import { loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  EGRESS_BASELINE,
  normalizeEgressHost,
  normalizeEgressIp,
  renderEgressAllowlist,
  renderEgressIpAllowlist,
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

  it("derives the rejected list with the SAME functions that drop them", () => {
    // A second copy of the rule here would be a warning that can disagree with
    // the behaviour it is describing — which is the failure mode this codebase
    // has hit three times over.
    //
    // BOTH normalisers, because the list renders into two ACL files. Asking
    // only the hostname one is how the warning came to report a working LAN
    // address as ignored.
    expect(ui).toMatch(
      /import \{ normalizeEgressHost, normalizeEgressIp \} from "@\/utils\/notebookRuntime\/egress"/,
    );
    expect(ui).toMatch(/normalizeEgressHost\(s\) === null/);
    expect(ui).toMatch(/normalizeEgressIp\(s\) === null/);
  });

  it("does not re-implement the hostname rule in the component", () => {
    expect(ui, "a second hostname pattern is declared in the admin UI").not.toMatch(
      /\[a-z0-9-\]\+\(\\.\[a-z0-9-\]\+\)\+/,
    );
  });

  it("renders a warning only when something was rejected", () => {
    expect(ui).toMatch(/rejectedEgress\.length > 0 &&/);
    expect(ui).toMatch(/Ignored — neither a hostname nor an IP address/);
  });

  it("ignores comment lines rather than reporting them as errors", () => {
    // The renderer already skips them; flagging them would be a false alarm.
    expect(ui).toMatch(/!s\.startsWith\("#"\)/);
  });
});

describe("destinations the platform itself needs", () => {
  // THE BUG THESE WERE WRITTEN FOR: the DuckDB extension registry was
  // hand-added to the GENERATED allowed_domains file. That file is rewritten
  // from scratch whenever an administrator saves runtime settings, so the
  // entry vanished on the next save and every ETL lakehouse node started
  // failing with "Failed to download extension ducklake (HTTP 403)" — a squid
  // denial wearing a DuckDB error message. A platform requirement has to live
  // in the baseline, not in the file the baseline generates.
  it("keeps the DuckDB extension registry in the baseline", () => {
    expect(EGRESS_BASELINE).toContain("duckdb.org");
    const out = renderEgressAllowlist([]);
    expect(out).toContain(".duckdb.org");
  });

  it("still permits PyPI, whatever the operator sets", () => {
    // An operator who clears the field must not lock kernels out of pip.
    const out = renderEgressAllowlist(["example.com"]);
    expect(out).toContain(".pypi.org");
    expect(out).toContain(".files.pythonhosted.org");
    expect(out).toContain(".example.com");
  });

  it("the generated file warns that hand edits are overwritten", () => {
    // The whole failure above came from someone (us) editing it by hand.
    expect(renderEgressAllowlist([])).toMatch(/overwritten whenever an administrator saves/);
  });

  it("adds the lakehouse object store without the operator listing it", () => {
    const apply = readFileSync("src/utils/notebookRuntime/egressApply.server.ts", "utf8");
    // A self-hosted MinIO endpoint is usually a raw IP, which squid can only
    // match through the dst file — and DuckDB reports the resulting 403 as an
    // authentication failure, sending you after a credential bug that is not
    // there.
    expect(apply).toContain("LAKEHOUSE_S3_ENDPOINT");
    expect(apply).toContain("export function platformEgressHosts()");
    // Both files must be rendered from the combined list, not just one.
    expect(apply).toContain("const all = [...(hosts ?? []), ...platformEgressHosts()]");
    expect(apply).toContain("renderEgressAllowlist(all)");
    expect(apply).toContain("renderEgressIpAllowlist(all)");
  });

  it("routes a host:port endpoint to the dst file, not dstdomain", () => {
    // dstdomain cannot match an address, so an IP endpoint belongs in the IP
    // file with its port stripped — and must NOT end up in allowed_domains.
    expect(renderEgressIpAllowlist(["192.168.1.10:19000"])).toContain("192.168.1.10");
    expect(renderEgressAllowlist(["192.168.1.10:19000"])).not.toContain("192.168.1.10");
    // A real hostname endpoint goes the other way.
    expect(renderEgressAllowlist(["minio.internal:9000"])).toContain(".minio.internal");
    expect(renderEgressIpAllowlist(["minio.internal:9000"])).not.toContain("minio.internal");
  });
});

// FOUND FROM THE UI. The admin field showed "Ignored — not a hostname the proxy
// can match: 192.168.1.10" while squid was, on the very next line of its access
// log, ALLOWING that address out of the dst file. The warning asked only
// normalizeEgressHost, which rejects addresses by design because they are inert
// as dstdomain entries — true of one file, false of the pair. An operator
// reading it concludes IP allow-listing is impossible and goes hunting a
// problem that does not exist.
describe("the admin warning agrees with what the proxy actually honours", () => {
  // The predicate the UI filters on, kept identical to RuntimeTab's.
  const ignored = (s: string) => normalizeEgressHost(s) === null && normalizeEgressIp(s) === null;

  it("does not call an entry ignored when a rendered ACL contains it", () => {
    for (const raw of [
      "192.168.1.10",
      "192.168.1.10:19000",
      "http://192.168.1.10:19000",
      "10.0.0.1",
      "github.com",
      "minio.internal:9000",
    ]) {
      const written =
        entries(renderEgressAllowlist([raw])).some((l) =>
          l.includes(raw.replace(/^\w+:\/\//, "").replace(/:\d+$/, "")),
        ) || entries(renderEgressIpAllowlist([raw])).length > 0;
      expect(ignored(raw), `${raw} is written to an ACL but reported as ignored`).toBe(!written);
    }
  });

  it("still flags what neither file can take", () => {
    // The warning has to keep earning its place: a typo must still be called
    // out, or it saves silently and the operator believes egress is permitted.
    for (const raw of ["not a host", "-lead.com", "999.1.1.1", "localhost"]) {
      expect(ignored(raw), `${raw} should be reported as ignored`).toBe(true);
    }
  });

  it("is wired into the admin field, not just available to it", () => {
    const tab = readFileSync("src/components/admin/RuntimeTab.tsx", "utf8");
    expect(tab).toContain("normalizeEgressIp(s) === null");
    // The old copy told operators an IP "cannot be used here". It can.
    expect(tab).not.toContain("An IP address cannot be");
  });
});

// The live allow-list files are GENERATED, and used to be tracked in git.
//
// THE BUG THESE WERE WRITTEN FOR: the app rewrites allowed_domains and
// allowed_ips whenever an administrator saves Admin -> Developer runtime. Both
// were tracked, so every install had a permanently dirty working tree, and the
// contents — which for allowed_ips are by definition raw addresses inside the
// operator's own network — were staged for commit like source. A LAN address
// reached three commits of this repo that way before anyone noticed.
describe("the generated allow-list files stay out of git", () => {
  const gitignore = readFileSync(".gitignore", "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8");
  const squid = readFileSync("deploy/notebooks/egress/squid.conf", "utf8");
  const LIVE = ["allowed_domains", "allowed_ips"];

  it("ships a tracked template for each generated file", () => {
    for (const f of LIVE) {
      const body = readFileSync(`deploy/notebooks/egress/${f}.default`, "utf8");
      expect(body).toContain("TEMPLATE");
    }
  });

  it("ignores the live pair", () => {
    for (const f of LIVE) {
      expect(gitignore, `${f} must be gitignored`).toContain(`deploy/notebooks/egress/${f}`);
    }
  });

  it("starts a fresh install with no raw IPs allowed", () => {
    // An IP in the template would be allow-listed on every install that ever
    // clones this repo — which is exactly how somebody's LAN address becomes
    // everybody's default.
    const entries = readFileSync("deploy/notebooks/egress/allowed_ips.default", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(entries).toEqual([]);
  });

  it("mounts the DIRECTORY into squid, never the two files by name", () => {
    // Docker silently creates a directory at a bind-mount source that does not
    // exist. Mounting the generated files by name meant a fresh clone that
    // skipped setup.sh got two directories in its working tree and a squid that
    // would not start — a failure introduced by untracking them.
    expect(compose).toContain("./deploy/notebooks/egress:/etc/squid/egress:ro");
    for (const f of LIVE) {
      expect(compose).not.toContain(`./deploy/notebooks/egress/${f}:/etc/squid/${f}`);
    }
  });

  it("points squid's ACLs at the mounted directory", () => {
    // Verified live: squid restarted clean, TCP_TUNNEL/200 for an allowed
    // domain and TCP_DENIED/403 for one that is not.
    expect(squid).toContain('dstdomain "/etc/squid/egress/allowed_domains"');
    expect(squid).toContain('dst "/etc/squid/egress/allowed_ips"');
  });

  it("seeds the live pair from the templates in both setup scripts", () => {
    // Compose needs them to exist BEFORE it runs, so the app cannot be the one
    // to create them first.
    const sh = readFileSync("scripts/setup.sh", "utf8");
    const ps = readFileSync("scripts/setup.ps1", "utf8");
    for (const f of LIVE) {
      expect(sh, `setup.sh must seed ${f}`).toContain(f);
      expect(ps, `setup.ps1 must seed ${f}`).toContain(f);
    }
    expect(sh).toContain("deploy/notebooks/egress/$f.default");
    expect(ps).toContain('Copy-Item "$live.default" $live');
  });
});

// Kubernetes ships a SECOND copy of the egress proxy config, inline in a
// ConfigMap, because there is no host directory to bind-mount there.
//
// THE BUG THESE WERE WRITTEN FOR: that copy had silently drifted. It was
// missing .duckdb.org, the dst ACL for raw IPs, and the object-store
// Safe_ports — so a notebook that worked under Compose failed on Kubernetes,
// and failed misleadingly: DuckDB reports a squid 403 on an S3 read as
// "Authentication Failure ... credentials did not work", which sends you after
// a credentials bug that does not exist. Nothing caught it because a drifted
// ConfigMap is still perfectly valid YAML.
describe("the Kubernetes egress config stays level with the Compose one", () => {
  const manifest = readFileSync("deploy/k8s/notebooks/notebook-runtime.yaml", "utf8");
  const docs = (loadAll(manifest) as Record<string, any>[]).filter(Boolean);
  const cm = docs.find((d) => d.kind === "ConfigMap" && d.metadata?.name === "notebook-egress");
  const dep = docs.find((d) => d.kind === "Deployment" && d.metadata?.name === "notebook-egress");

  it("defines all three config keys", () => {
    expect(Object.keys(cm.data).sort()).toEqual(["allowed_domains", "allowed_ips", "squid.conf"]);
  });

  it("mounts nothing it does not define", () => {
    // A subPath with no matching key mounts an EMPTY FILE rather than failing,
    // so squid starts with an ACL that matches nothing and every kernel loses
    // the network — with no error anywhere saying so.
    for (const m of dep.spec.template.spec.containers[0].volumeMounts ?? []) {
      expect(cm.data[m.subPath], `${m.mountPath} <- ${m.subPath}`).toBeDefined();
    }
  });

  it("allows the same domains as the Compose template", () => {
    const k8s = entries(cm.data.allowed_domains).map((l) => l.trim());
    const compose = entries(
      readFileSync("deploy/notebooks/egress/allowed_domains.default", "utf8"),
    ).map((l) => l.trim());
    expect(k8s).toEqual(compose);
  });

  it("carries the raw-IP ACL and the object-store ports", () => {
    // Verified with the real binary: `squid -k parse` against the extracted
    // ConfigMap exits 0 and loads the domain ACL.
    const conf = cm.data["squid.conf"] as string;
    expect(conf).toContain('acl allowed_ips dst "/etc/squid/allowed_ips"');
    expect(conf).toContain("http_access allow allowed_ips");
    for (const port of [9000, 19000]) {
      expect(conf, `Safe_ports ${port}`).toContain(`acl Safe_ports port ${port}`);
    }
    // Default-deny must still be the last word.
    expect(
      conf
        .trimEnd()
        .split("\n")
        .filter((l) => l.startsWith("http_access"))
        .pop(),
    ).toBe("http_access deny all");
  });

  it("starts with no raw IPs allowed", () => {
    expect(entries(cm.data.allowed_ips)).toEqual([]);
  });
});

// On Kubernetes the NetworkPolicy IS the egress boundary, not a second opinion.
//
// The kernel's NO_PROXY contains `.svc` and `.cluster.local`, because a kernel
// has to reach the app's own API without looping through the proxy. That means
// the proxy is bypassed for every in-cluster address — fine, and only fine,
// because the shipped NetworkPolicy permits egress to exactly three things.
//
// NetworkPolicy is enforced by the CNI, not by Kubernetes, and several common
// setups do not enforce it. On such a cluster the manifest applies cleanly,
// reports nothing, and does nothing — and the kernels can then reach the
// Supabase gateway, Postgres and the lakehouse catalog directly. An unenforced
// policy is the failure mode that looks exactly like a working one, which is
// why the doc has to say so where the guarantee is made.
describe("the Kubernetes kernel boundary", () => {
  const manifest = readFileSync("deploy/k8s/notebooks/notebook-runtime.yaml", "utf8");
  const service = readFileSync("src/utils/notebookRuntime/service.server.ts", "utf8");
  const doc = readFileSync("docs/DEVELOPER_WORKSPACE_RUNTIME.md", "utf8");

  it("bypasses the proxy for in-cluster addresses", () => {
    // Stated as a fact the NetworkPolicy has to cover, not as a defect.
    expect(service).toContain('".svc", ".cluster.local"');
  });

  it("denies everything except DNS, the proxy, and the app", () => {
    const policy = manifest.slice(manifest.indexOf("kind: NetworkPolicy"));
    expect(policy).toContain("policyTypes: [Ingress, Egress]");
    expect(policy).toContain("{ protocol: TCP, port: 3128 }");
    expect(policy).toContain("app: notebook-egress");
    // Nothing else in the cluster: no blanket `- to: []` outside the DNS rule.
    const blanket = policy.match(/- to: \[\]/g) ?? [];
    expect(blanket.length, "only the DNS rule may target everything").toBe(1);
  });

  it("says the guarantee depends on the CNI, where the guarantee is made", () => {
    // Someone reading "no direct internet route" must not have to already know
    // that a NetworkPolicy is inert on flannel or Docker Desktop's default.
    expect(doc).toMatch(/enforced by the CNI, not by Kubernetes/);
    expect(doc).toMatch(/Calico, Cilium/);
    expect(doc).toMatch(/applies cleanly.*does nothing|does nothing/);
  });

  it("notes that Compose does not share the gap", () => {
    // Kernels there sit on an `internal` network with no gateway — nothing to
    // bypass. Saying so stops the warning being read as universal.
    expect(doc).toMatch(/Compose does not have this gap/);
  });
});
