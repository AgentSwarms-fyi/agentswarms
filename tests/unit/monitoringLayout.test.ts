// What the Monitoring page puts first.
//
// The page is opened when something looks wrong, so its order is triage order:
// the machine, then what is down, then what is stored. It did not start that
// way. "Materialised data" sat between the resource cards and the service list
// and rendered EVERY dataset in the workspace — a dozen rows saying "Not
// mirrored", i.e. holding nothing — which pushed service health a screen and a
// half down the page. A per-dataset storage control is configuration; it should
// not outrank service status on the page you open in an incident.
//
// Layout has no runtime assertion to fail, so it regresses silently. These pin
// the two decisions.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/monitoring.tsx"),
  "utf8",
);
const panel = readFileSync(resolve(process.cwd(), "src/components/data/CapacityPanel.tsx"), "utf8");

describe("Monitoring is ordered for triage", () => {
  it("puts service health above the storage panel", () => {
    const services = page.indexOf('<p className="text-sm font-semibold">Services</p>');
    const capacity = page.indexOf("<CapacityPanel");
    expect(services, "Services heading not found — this test needs updating").toBeGreaterThan(-1);
    expect(capacity).toBeGreaterThan(-1);
    expect(services, "service health must render before the storage panel").toBeLessThan(capacity);
  });

  it("puts the machine's resource cards above both", () => {
    expect(page.indexOf("{/* Hardware */}")).toBeLessThan(
      page.indexOf('<p className="text-sm font-semibold">Services</p>'),
    );
  });

  it("names the instance the figures came from", () => {
    // Behind a load balancer each refresh may be answered by a different
    // replica; unlabelled, the CPU number looks like it is jumping about. On
    // Kubernetes the hostname is the pod name.
    expect(page).toContain("Reporting from");
    expect(page).toContain("metrics.hostname");
    expect(page).toContain("metrics.workers");
  });
});

describe("the storage panel shows what is using something", () => {
  it("lists only datasets holding bytes until expanded", () => {
    expect(panel).toContain("const visible = expanded ? (rows ?? []) : held");
    expect(panel).toContain("const hiddenCount = (rows?.length ?? 0) - held.length");
  });

  it("still offers the per-dataset control behind a disclosure", () => {
    // Hiding the rows must not remove the ability to change a storage mode —
    // that would be fixing a layout problem by deleting a feature.
    expect(panel).toContain("setExpanded");
    expect(panel).toContain("holding nothing, to change how they are stored");
    expect(panel).toContain('<SelectItem value="direct">Direct</SelectItem>');
  });

  it("says so plainly when nothing is mirrored", () => {
    expect(panel).toContain("Nothing is mirrored");
  });
});
