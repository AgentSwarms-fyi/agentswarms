// The registered email templates render as their callers render them (R345).
//
// /api/contact, the budget alert and /api/email/send take a template from the
// registry and render it from data they put together: React.createElement on
// the entry's component, then React Email's render, with the subject from the
// entry. R345 typed each template against its own props (defineTemplate) and
// erased them for the registry; nothing rendered a registered template in a
// test before, so this renders each, from its preview and from nothing.
import { render } from "@react-email/components";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/lib/email-templates/registry";

const subjectOf = (name: string, data: Record<string, unknown>) => {
  const entry = TEMPLATES[name];
  return typeof entry.subject === "function" ? entry.subject(data) : entry.subject;
};

describe("each registered template", () => {
  for (const [name, entry] of Object.entries(TEMPLATES)) {
    it(`${name} renders its preview to HTML and text, and has a subject`, async () => {
      const data = entry.previewData ?? {};
      const element = React.createElement(entry.component, data);
      const html = await render(element);
      const text = await render(element, { plainText: true });
      expect(html).toMatch(/<html/i);
      expect(text.trim().length).toBeGreaterThan(20);
      expect(subjectOf(name, data).length).toBeGreaterThan(5);
    }, 30_000);
  }

  it("are the four the routes name", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      "budget-alert",
      "contact-admin-notification",
      "contact-confirmation",
      "welcome",
    ]);
  });
});

describe("a subject from the data it is given", () => {
  it("the admin notification names the visitor's subject, then their name, then neither", () => {
    expect(subjectOf("contact-admin-notification", { subject: "Pricing", name: "Ana" })).toBe(
      "[AgentSwarms] New contact: Pricing",
    );
    expect(subjectOf("contact-admin-notification", { name: "Ana" })).toBe(
      "[AgentSwarms] New contact: Ana",
    );
    expect(subjectOf("contact-admin-notification", {})).toBe(
      "[AgentSwarms] New contact: visitor message",
    );
  });

  it("the budget alert names a team's scope, and reads no field it was not given", () => {
    expect(subjectOf("budget-alert", { kind: "exceeded", scopeLabel: "Data team" })).toBe(
      "Data team has reached its monthly AgentSwarms AI spend cap",
    );
    expect(subjectOf("budget-alert", { percentUsed: 89.6 })).toBe(
      "You've used 90% of your AgentSwarms AI budget",
    );
    expect(subjectOf("budget-alert", {})).toBe("You've used 0% of your AgentSwarms AI budget");
  });

  it("the confirmation's and the welcome's are fixed", () => {
    expect(subjectOf("contact-confirmation", {})).toMatch(/^Thanks for contacting /);
    expect(subjectOf("welcome", {})).toMatch(/^Welcome to AgentSwarms/);
  });
});
