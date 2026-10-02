// Integrations: a disconnect whose write failed is said as a failure, and the
// provider or channel is shown as what it still is — connected.
//
// FOUND FROM THE UI. With every DELETE to provider_credentials rejected,
// "Provider disconnected" toasted and the list reloaded with the provider
// still connected. The notification channel's disconnect did the same over
// an update.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/integrations.tsx", "utf8");

describe("disconnecting a provider", () => {
  it("keeps the delete's error and says the key is still stored", () => {
    expect(page).toContain(
      'const { error } = await supabase.from("provider_credentials").delete().eq("provider", encId);',
    );
    expect(page).toContain('toast.error("Could not disconnect the provider"');
    expect(page).toContain("The key is still stored and the provider is still connected.");
    const block = page.slice(page.indexOf('from("provider_credentials").delete()'));
    expect(block.indexOf("return;")).toBeLessThan(
      block.indexOf('toast.success("Provider disconnected")'),
    );
  });

  it("on the integrations-row path too, which is the one OpenRouter takes", () => {
    const branch = page.slice(
      page.indexOf("const existing = integrations.find((i) => i.provider === providerId);"),
      page.indexOf("async function saveGateway()"),
    );
    expect(branch).toContain("const { error } = await supabase");
    expect(branch).toContain(".update({ is_active: false, config: {} })");
    expect(branch).toContain('toast.error("Could not disconnect the provider"');
    expect(branch.indexOf("return;")).toBeLessThan(
      branch.indexOf('toast.success("Provider disconnected")'),
    );
    // Both provider paths say it; the multi-line bare await is gone.
    expect((page.match(/toast\.error\("Could not disconnect the provider"/g) ?? []).length).toBe(2);
    expect(page).not.toMatch(
      /^\s*await supabase\s*\n\s*\.from\("integrations"\)\s*\n\s*\.update\(/m,
    );
  });
});

describe("disconnecting a notification channel", () => {
  it("keeps the update's error and says the channel is still connected", () => {
    const fn = page.slice(
      page.indexOf("async function disconnectNotifChannel"),
      page.indexOf("const sharedFor ="),
    );
    expect(fn).toContain("const { error } = await supabase");
    expect(fn).toContain('toast.error("Could not disconnect the channel"');
    expect(fn.indexOf("return;")).toBeLessThan(fn.indexOf('toast.success("Channel disconnected")'));
  });

  it("leaves no bare write statement on the page", () => {
    expect(page).not.toMatch(
      /^\s*await supabase\.from\("[a-z_]+"\)\.(update|delete|insert|upsert)\([^\n]*;\s*$/m,
    );
  });
});
