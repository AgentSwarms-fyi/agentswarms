// Cloud region / location names, checked before they are put into a hostname.
//
// Bedrock, OCI and Vertex build their endpoint host from a field the user typed:
// `bedrock-runtime.${region}.amazonaws.com`. A value outside the region alphabet
// rewrites that host: `169.254.169.254.nip.io#` makes it
// `bedrock-runtime.169.254.169.254.nip.io` — a name the user picked, which
// wildcard DNS resolves to the cloud metadata address — and the rest of the
// template falls into the fragment. (The `x@host/` userinfo spelling is refused
// by fetch itself; a `/`, `#` or `?` is not.) So a region is a lowercase,
// dash-separated token and nothing else (R386).

const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The region, normalised to lowercase, or an error naming the field. */
export function cloudRegion(value: string, label: string): string {
  const v = value.trim().toLowerCase();
  if (v.length > 40 || !REGION.test(v)) {
    throw new Error(
      `${label} "${value}" is not a region name — expected something like us-east-1.`,
    );
  }
  return v;
}
