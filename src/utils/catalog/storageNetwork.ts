// Object storage over private paths (private connectivity, Phase 3, R422).
//
// A bucket may be reached over the internet, over a cloud private endpoint
// (an S3 interface endpoint, a GCS Private Service Connect name, an Azure
// Private Link), or over a VPN where the public storage name resolves to a
// private address. The choice is the deployment's, and Public stays the
// default. What the app adds:
//
//   - the private endpoint shapes each cloud uses, shown in the form;
//   - which names are the clouds' own storage names: those may resolve to a
//     private address even when BLOCK_PRIVATE_NETWORK_FETCH is set, because a
//     private address there is PrivateLink or a private DNS zone, not an
//     internal service. Only storage names: an EC2 instance's public DNS name
//     also ends in amazonaws.com, and inside a VPC it resolves to that
//     instance's private address, so the whole cloud domain would be a way
//     round the switch;
//   - an optional per-source "require a private network path" rule
//     (objectStore.server.ts enforces it).
//
// PURE: the form and the server use the same rules.
import { hostOf } from "@/lib/secretHosts";

/**
 * The clouds' object-storage names: S3 (regional, legacy, dual-stack, FIPS and
 * accelerate forms, with or without a bucket in front), S3 interface endpoints,
 * GCS (the XML API's name, bucket subdomains and Private Service Connect
 * `storage-*.p.googleapis.com`), and Azure Blob / Data Lake accounts,
 * including their privatelink zone.
 */
const CLOUD_STORAGE_HOST: RegExp[] = [
  /^(?:[a-z0-9.-]+\.)?s3(?:[.-](?:dualstack|fips|accelerate))*(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/,
  /^(?:[a-z0-9.-]+\.)?s3[.-]accelerate(?:\.dualstack)?\.amazonaws\.com$/,
  /^(?:[a-z0-9-]+\.)?vpce-[a-z0-9-]+\.s3\.[a-z0-9-]+\.vpce\.amazonaws\.com$/,
  /^(?:[a-z0-9.-]+\.)?storage\.googleapis\.com$/,
  /^storage-[a-z0-9-]+\.p\.googleapis\.com$/,
  /^[a-z0-9]{3,24}\.(?:privatelink\.)?(?:blob|dfs)\.core\.windows\.net$/,
];

/** Whether `host` (a URL or a host) is one of the clouds' own object-storage names. */
export function isCloudStorageHost(host: string): boolean {
  const h = hostOf(host);
  return !!h && CLOUD_STORAGE_HOST.some((re) => re.test(h));
}

export type StorageProviderId =
  "aws" | "gcs" | "r2" | "minio" | "spaces" | "b2" | "custom" | "azure";

/**
 * How each provider is reached privately, for the form: the endpoint to enter
 * for a private endpoint, or that the usual name stays and resolves privately.
 */
export const PRIVATE_PATH_HINT: Record<StorageProviderId, string> = {
  aws:
    "AWS PrivateLink: enter the S3 interface endpoint as the Endpoint URL, e.g. " +
    "https://vpce-0abc123-d4e5f6.s3.us-east-1.vpce.amazonaws.com (the bucket is added in " +
    "front of it unless path-style is on). With private DNS for S3, leave it empty: " +
    "s3.<region>.amazonaws.com then resolves to the endpoint.",
  gcs:
    "Private Service Connect: enter the endpoint, e.g. https://storage-myendpoint.p.googleapis.com. " +
    "Over a VPN or Private Google Access, keep https://storage.googleapis.com.",
  azure:
    "Azure Private Link keeps <account>.blob.core.windows.net; the private endpoint's DNS zone " +
    "resolves it to a private address. Leave the endpoint empty.",
  r2: "Reached over the internet, or over a VPN where the endpoint resolves privately.",
  minio: "A self-hosted store: its endpoint is usually already on your network.",
  spaces: "Reached over the internet, or over a VPN where the endpoint resolves privately.",
  b2: "Reached over the internet, or over a VPN where the endpoint resolves privately.",
  custom: "Reached over the internet, or over a VPN where the endpoint resolves privately.",
};
