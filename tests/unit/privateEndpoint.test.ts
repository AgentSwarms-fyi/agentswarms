// F2 (private GenAI connectivity): endpoint overrides for the signed-auth
// cloud providers.
//
// Bedrock, Vertex and OCI build their host from a region/project and could not
// be pointed at a private endpoint. An override is now accepted, but only as an
// https origin on the provider's own domain, so a signed request cannot be
// re-aimed elsewhere (the cloudRegion() principle). The adapters are checked
// for the wiring; the signed request is always sent to the host it is signed
// for.

import { describe, expect, it } from "vitest";

import {
  azureEndpointProblem,
  endpointHosts,
  providerEndpoint,
  vertexTokenUrl,
} from "@/utils/providers/privateEndpoint";

describe("providerEndpoint accepts only the provider's own https origins", () => {
  it("accepts documented private endpoint names, returning the origin", () => {
    expect(
      providerEndpoint("bedrock", "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com"),
    ).toBe("https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com");
    expect(providerEndpoint("bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com")).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com",
    );
    expect(providerEndpoint("vertex", "https://aiplatform-ep1.p.googleapis.com")).toBe(
      "https://aiplatform-ep1.p.googleapis.com",
    );
    expect(
      providerEndpoint(
        "oci_genai",
        "https://pre.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com",
      ),
    ).toBe("https://pre.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com");
  });

  it("treats empty / missing as no override", () => {
    expect(providerEndpoint("bedrock", "")).toBeUndefined();
    expect(providerEndpoint("bedrock", "   ")).toBeUndefined();
    expect(providerEndpoint("vertex", undefined)).toBeUndefined();
    expect(providerEndpoint("oci_genai", null)).toBeUndefined();
  });

  it("refuses a host on another domain", () => {
    expect(() => providerEndpoint("bedrock", "https://bedrock-runtime.attacker.test")).toThrow(
      /Bedrock endpoint/,
    );
    expect(() => providerEndpoint("vertex", "https://aiplatform.attacker.test")).toThrow(
      /Vertex AI endpoint/,
    );
    expect(() =>
      providerEndpoint("oci_genai", "https://inference.generativeai.attacker.test"),
    ).toThrow(/OCI Generative AI endpoint/);
  });

  it("refuses the metadata address dressed as a subdomain or with a path", () => {
    expect(() =>
      providerEndpoint("bedrock", "https://amazonaws.com.169.254.169.254.nip.io"),
    ).toThrow(/Bedrock endpoint/);
    // A path/query/fragment is where a crafted host could hide; refuse them.
    expect(() =>
      providerEndpoint("bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com/../x"),
    ).toThrow(/no path/);
    expect(() =>
      providerEndpoint("vertex", "https://aiplatform-ep1.p.googleapis.com#@evil"),
    ).toThrow(/no path/);
  });

  it("refuses http, credentials, and a bare suffix match", () => {
    expect(() =>
      providerEndpoint("bedrock", "http://bedrock-runtime.us-east-1.amazonaws.com"),
    ).toThrow(/https/);
    expect(() =>
      providerEndpoint("bedrock", "https://u:p@bedrock-runtime.us-east-1.amazonaws.com"),
    ).toThrow(/credentials/);
    // host that equals the suffix with nothing before it
    expect(() => providerEndpoint("vertex", "https://googleapis.com")).toThrow(
      /Vertex AI endpoint/,
    );
  });
});

describe("azureEndpointProblem steers Private Link users to the resource hostname", () => {
  it("flags a privatelink name", () => {
    expect(azureEndpointProblem("https://myres.privatelink.openai.azure.com")).toMatch(
      /resource's own endpoint/,
    );
  });
  it("accepts the resource's own hostname", () => {
    expect(azureEndpointProblem("https://myres.openai.azure.com")).toBeNull();
  });
});

describe("vertexTokenUrl follows the API endpoint over PSC", () => {
  it("routes the token through the matching oauth2 PSC name", () => {
    expect(
      vertexTokenUrl(
        "https://aiplatform-ep1.p.googleapis.com",
        "https://oauth2.googleapis.com/token",
      ),
    ).toBe("https://oauth2-ep1.p.googleapis.com/token");
  });
  it("leaves the token URI unchanged without a PSC API endpoint", () => {
    expect(vertexTokenUrl(undefined, "https://oauth2.googleapis.com/token")).toBe(
      "https://oauth2.googleapis.com/token",
    );
    expect(
      vertexTokenUrl("https://bedrock-runtime.us-east-1.amazonaws.com", "https://x.test/t"),
    ).toBe("https://x.test/t");
  });
});

describe("endpointHosts is what the dialog shows as accepted", () => {
  it("lists each provider's domains as wildcards", () => {
    expect(endpointHosts("bedrock")).toEqual([
      "*.vpce.amazonaws.com",
      "*.amazonaws.com",
      "*.api.aws",
    ]);
    expect(endpointHosts("claude_aws")).toEqual(["*.api.aws", "*.vpce.amazonaws.com"]);
    expect(endpointHosts("vertex")).toEqual(["*.googleapis.com"]);
    expect(endpointHosts("oci_genai")).toEqual(["*.oci.oraclecloud.com"]);
  });
});

// The adapters are driven end-to-end in providerPrivateEndpoints.test.ts.
