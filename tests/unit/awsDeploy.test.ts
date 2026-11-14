// The AWS deploys (deploy/aws/terraform, deploy/helm/agentswarms), checked
// without an AWS account: what they promise in one file holds in the others,
// and the properties they exist for are still in them. `terraform validate`,
// `helm lint` and kubeconform check the syntax (R480); these check the intent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const TF = "deploy/aws/terraform";
const ROOTS = ["ecs", "vm", "eks"] as const;
const sizes = JSON.parse(rd("deploy/aws/spec/sizes.json")) as {
  tiers: Record<string, Record<string, unknown>>;
};
const module = (name: string) =>
  readdirSync(join(TF, "modules", name))
    .filter((f) => f.endsWith(".tf"))
    .map((f) => rd(join(TF, "modules", name, f)))
    .join("\n");

describe("the size tiers", () => {
  it("are the four the roots accept, each with every value a root reads", () => {
    expect(Object.keys(sizes.tiers)).toEqual(["dev", "small", "medium", "large"]);
    for (const [name, t] of Object.entries(sizes.tiers)) {
      for (const k of [
        "azs",
        "single_nat",
        "interface_endpoint_azs",
        "rds",
        "ecs",
        "vm",
        "eks",
        "monthly_usd",
      ]) {
        expect(t, `${name}.${k}`).toHaveProperty(k);
      }
      expect(Object.keys(t.monthly_usd as object).sort(), name).toEqual(["ecs", "eks", "vm"]);
      const ecs = t.ecs as Record<string, unknown>;
      for (const k of [
        "instance_type",
        "instances",
        "web",
        "analytics",
        "supabase",
        "gateway_count",
        "internal_count",
        "egress_count",
      ]) {
        expect(ecs, `${name}.ecs.${k}`).toHaveProperty(k);
      }
      for (const k of [
        "instance_type",
        "min",
        "max",
        "desired",
        "sandbox_instance_type",
        "sandbox_max",
      ]) {
        expect(t.eks, `${name}.eks.${k}`).toHaveProperty(k);
      }
    }
  });

  it("are highly available above dev: Multi-AZ, a NAT per AZ, two of everything", () => {
    for (const name of ["small", "medium", "large"]) {
      const t = sizes.tiers[name] as {
        single_nat: boolean;
        rds: { multi_az: boolean };
        ecs: {
          web: { min: number };
          analytics: { count: number };
          supabase: { count: number };
          egress_count: number;
        };
      };
      expect(t.rds.multi_az, name).toBe(true);
      expect(t.single_nat, name).toBe(false);
      expect(t.ecs.web.min, name).toBeGreaterThanOrEqual(2);
      expect(t.ecs.analytics.count, name).toBeGreaterThanOrEqual(2);
      expect(t.ecs.supabase.count, name).toBeGreaterThanOrEqual(2);
      expect(t.ecs.egress_count, name).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("pins", () => {
  it("every root pins its providers exactly, and the same versions", () => {
    const pins = ROOTS.map((r) => {
      const v = rd(join(TF, r, "versions.tf"));
      const found = [
        ...v.matchAll(/source\s*=\s*"hashicorp\/(\w+)"\s*\n\s*version\s*=\s*"([^"]+)"/g),
      ];
      for (const [, , version] of found) expect(version, r).toMatch(/^\d+\.\d+\.\d+$/);
      return Object.fromEntries(found.map((m) => [m[1], m[2]]));
    });
    for (const p of pins) {
      expect(p.aws).toBe(pins[0].aws);
      expect(p.random).toBe(pins[0].random);
      expect(p.archive).toBe(pins[0].archive);
    }
  });

  it("names Supabase's images by the same digests in the module, the VM root and the chart", () => {
    const digests = (s: string) =>
      [
        ...s.matchAll(
          /((?:supabase\/gotrue|postgrest\/postgrest|supabase\/storage-api|nginx):[\w.-]+@sha256:[0-9a-f]{64})/g,
        ),
      ]
        .map((m) => m[1])
        .sort();
    const fromModule = digests(module("supabase"));
    expect(fromModule).toHaveLength(4);
    expect(digests(rd(join(TF, "vm", "main.tf")))).toEqual(fromModule);
    expect(digests(rd("deploy/helm/agentswarms/values.yaml"))).toEqual(fromModule);
  });

  it("uses the one gateway template, from the chart, everywhere", () => {
    for (const m of ["supabase", "app-vm"]) {
      expect(module(m), m).toContain("helm/agentswarms/files/supabase-gateway.conf.template");
    }
    expect(rd("deploy/helm/agentswarms/templates/supabase.yaml")).toContain(
      'Files.Get "files/supabase-gateway.conf.template"',
    );
  });
});

describe("what the deploys exist for", () => {
  it("keeps every secret out of Terraform: the Lambda makes them, the state holds an ARN", () => {
    const secrets = module("secrets");
    expect(secrets).toContain("aws_lambda_invocation");
    expect(secrets).not.toContain("random_password");
    expect(secrets).not.toMatch(/aws_secretsmanager_secret_version/);
    const lambda = rd("deploy/aws/lambda/secrets-bootstrap/secrets_bootstrap.py");
    // It answers Terraform with names, never values.
    expect(lambda).toContain('return {"added": added}');
  });

  it("runs sandboxes with no AWS identity, a read-only root and no capabilities", () => {
    const s = module("sandboxes");
    const td = s.slice(s.indexOf('resource "aws_ecs_task_definition" "sandbox"'));
    const block = td.slice(0, td.indexOf('\nresource "'));
    expect(block).not.toContain("task_role_arn");
    expect(block).toMatch(/readonlyRootFilesystem\s*=\s*true/);
    expect(block).toMatch(/drop\s*=\s*\["ALL"\]/);
    expect(block).toMatch(/user\s*=\s*"1000:1000"/);
    // The subnets they run in have no route out.
    const net = module("network");
    expect(net).toMatch(
      /resource "aws_route_table" "isolated" \{\s*vpc_id\s*=\s*aws_vpc\.this\.id\s*tags/,
    );
  });

  it("hands the app the ECS backend's settings by the names it reads", () => {
    const env = module("sandboxes");
    const ecs = rd("src/utils/notebookRuntime/ecs.server.ts");
    const names = [...env.matchAll(/^\s+(NOTEBOOK_ECS_[A-Z_]+)\s*=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of names) expect(ecs, n).toContain(n);
    expect(env).toMatch(/NOTEBOOK_EGRESS_MODE\s*=\s*"pull"/);
  });

  it("keeps the scheduler off the web tier and on analytics", () => {
    const ecs = module("app-ecs");
    expect(ecs).toContain(
      '{ name = "DISABLE_INPROCESS_SCHEDULER", value = each.key == "web" ? "1" : "" }',
    );
    expect(ecs).toContain('{ name = "APP_ROLE", value = each.key }');
    const chart = rd("deploy/helm/agentswarms/templates/app.yaml");
    expect(chart).toContain('- { name: DISABLE_INPROCESS_SCHEDULER, value: "1" }');
    expect(chart).toContain("- { name: APP_ROLE, value: {{ $tier }} }");
  });

  it("sizes workers with WEB_CONCURRENCY, which server.mjs reads (not AGENTSWARMS_WORKERS, which it writes)", () => {
    for (const f of [
      join(TF, "modules/app-ecs/main.tf"),
      join(TF, "modules/app-vm/main.tf"),
      "deploy/helm/agentswarms/templates/app.yaml",
    ]) {
      expect(rd(f), f).toContain("WEB_CONCURRENCY");
      expect(rd(f), f).not.toContain("AGENTSWARMS_WORKERS");
    }
    expect(rd("server.mjs")).toContain("process.env.WEB_CONCURRENCY");
  });

  it("checks health locally, so a database failover does not empty the pool", () => {
    expect(module("edge")).toContain('path                = "/api/health/ready?scope=local"');
    expect(rd("deploy/helm/agentswarms/templates/app.yaml")).toContain(
      'path: "/api/health/ready?scope=local"',
    );
    expect(module("edge")).toMatch(/idle_timeout\s*=\s*120/);
  });

  it("migrates and makes the admin before anything starts, on every target", () => {
    expect(module("supabase")).toContain('command   = ["deploy"]');
    expect(module("supabase")).toContain("aws_lambda_invocation");
    expect(rd(join(TF, "ecs/main.tf"))).toContain("schema_deploy = module.supabase.deployed");
    expect(rd(join(TF, "vm/main.tf"))).toContain("AGENTSWARMS_SCHEMA_DEPLOY");
    const job = rd("deploy/helm/agentswarms/templates/deploy-job.yaml");
    expect(job).toContain("helm.sh/hook: pre-install,pre-upgrade");
    expect(job).toContain("args: [deploy]");
    expect(rd(join(TF, "eks/main.tf"))).toMatch(/atomic\s*=\s*true/);
  });

  it("lets only the app and the gateway open a sandbox on EKS, and sandboxes reach only DNS, the proxy and the app", () => {
    const np = rd("deploy/helm/agentswarms/templates/sandboxes.yaml");
    expect(np).toContain("values: [web, analytics, notebook-gateway]");
    expect(np).toContain("ports: [{ protocol: TCP, port: 8888 }]");
    expect(np).toContain(
      "podSelector: { matchLabels: { app.kubernetes.io/component: egress-proxy } }",
    );
    expect(rd(join(TF, "eks/main.tf"))).toContain('enableNetworkPolicy = "true"');
  });
});

describe("a first apply", () => {
  it("never counts a thing by whether another module's id is null yet (R484)", () => {
    // `count = var.x == null ? 0 : 1` cannot be planned while x is an id
    // another module has yet to make, so the first apply fails at its plan,
    // which `terraform validate` does not reach. Rehearsing on AWS Emulator
    // (deploy/aws/emulator) found one in modules/sandboxes.
    const roots = ROOTS.map((r) => rd(join(TF, r, "main.tf"))).join("\n");
    const offenders: string[] = [];
    for (const name of readdirSync(join(TF, "modules"))) {
      for (const m of module(name).matchAll(
        /(?:count|for_each)\s*=\s*var\.(\w+)\s*[!=]=\s*null/g,
      )) {
        if (new RegExp(`^\\s*${m[1]}\\s*=\\s*module\\.`, "m").test(roots)) {
          offenders.push(`modules/${name}: var.${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("describes security groups and their rules only in the characters EC2 accepts (R484)", () => {
    // CreateSecurityGroup and the rule calls refuse anything outside this set
    // (an apostrophe, say) with InvalidParameterValue, after the plan passed:
    // the AWS Emulator rehearsal found four.
    const allowed = /^[a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]*$/;
    const offenders: string[] = [];
    for (const name of readdirSync(join(TF, "modules"))) {
      let kind = "";
      for (const line of module(name).split("\n")) {
        kind = /^(?:resource|data) "([a-z0-9_]+)"/.exec(line)?.[1] ?? kind;
        if (!/security_group/.test(kind)) continue;
        const text = /\bdescription\s*=\s*"(.*)"\s*$/.exec(line)?.[1];
        if (text !== undefined && !allowed.test(text.replace(/\$\{[^}]*\}/g, "x"))) {
          offenders.push(`modules/${name}: ${text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
