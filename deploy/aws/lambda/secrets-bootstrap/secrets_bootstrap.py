"""Fill a deployment's Secrets Manager secret with every secret it needs (deploy/aws).

Invoked once per apply by Terraform (aws_lambda_invocation) and by the
CloudFormation stack (a custom resource). The secret holds one JSON object;
this adds the keys that are missing and never changes one that is there, so a
second run is a no-op and nothing is ever rotated by accident.

Generated here, inside AWS, so that no deploy tool sees the values: Terraform's
state and CloudFormation's template hold only the secret's ARN. And the
Supabase API keys are HS256 JWTs over the JWT secret, which neither tool can
compute.

Stdlib and boto3 only (both in the Lambda runtime).
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.request

import boto3

# name -> bytes of randomness, hex-encoded (twice as many characters).
RANDOM = {
    "jwt_secret": 32,
    "provider_creds_secret": 32,
    "internal_run_secret": 32,
    "notebook_runtime_secret": 32,
    "docgen_token": 32,
    "egress_pull_token": 32,
    "spark_connect_token": 32,
    "provenance_signing_secret": 32,
    "metrics_token": 32,
    "authenticator_password": 24,
    "auth_admin_password": 24,
    "storage_admin_password": 24,
    "lakehouse_catalog_password": 24,
    # The first admin's, set by the deploy task (db-migrate create-admin).
    # Read it from the secret to sign in, then change it in the app.
    "admin_password": 16,
}

# Ten years: the keys are rotated by rotating jwt_secret, not by expiry.
KEY_LIFETIME_S = 10 * 365 * 24 * 3600


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt(secret: str, role: str, issued: int) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {"role": role, "iss": "supabase", "iat": issued, "exp": issued + KEY_LIFETIME_S}
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{body}.{b64url(signature)}"


def fill(current: dict) -> tuple[dict, list[str]]:
    """The secret with what was missing added, and the names added."""
    out = dict(current)
    added = []
    for name, size in RANDOM.items():
        if not out.get(name):
            out[name] = secrets.token_hex(size)
            added.append(name)
    # The keys follow the JWT secret: made again only if it is new or they are missing.
    issued = int(time.time())
    for name, role in (("anon_key", "anon"), ("service_role_key", "service_role")):
        if "jwt_secret" in added or not out.get(name):
            out[name] = jwt(out["jwt_secret"], role, issued)
            added.append(name)
    return out, added


def ensure(secret_id: str, client=None) -> list[str]:
    sm = client or boto3.client("secretsmanager")
    try:
        raw = sm.get_secret_value(SecretId=secret_id).get("SecretString") or "{}"
        current = json.loads(raw)
    except sm.exceptions.ResourceNotFoundException:
        # The secret exists (the stack made it) but has no value yet.
        current = {}
    if not isinstance(current, dict):
        raise ValueError(f"{secret_id} holds something other than a JSON object; refusing to overwrite it")
    out, added = fill(current)
    if added:
        sm.put_secret_value(SecretId=secret_id, SecretString=json.dumps(out))
    return added


def cfn_respond(event, context, status, reason="", data=None):
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason or f"See CloudWatch log stream {context.log_stream_name}",
            "PhysicalResourceId": event.get("PhysicalResourceId") or event["LogicalResourceId"],
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": data or {},
        }
    ).encode()
    request = urllib.request.Request(
        event["ResponseURL"], data=body, method="PUT", headers={"Content-Type": ""}
    )
    urllib.request.urlopen(request, timeout=30).read()


def handler(event, context):
    # CloudFormation custom resource: answer the presigned URL, and on Delete
    # do nothing (the stack deletes the secret itself, when it does).
    if "RequestType" in event and "ResponseURL" in event:
        try:
            added = []
            if event["RequestType"] in ("Create", "Update"):
                added = ensure(event["ResourceProperties"]["SecretId"])
            cfn_respond(event, context, "SUCCESS", data={"Added": ",".join(added)})
        except Exception as e:  # noqa: BLE001 - CloudFormation must hear back either way
            cfn_respond(event, context, "FAILED", reason=str(e)[:500])
        return
    # Terraform's aws_lambda_invocation: {"secret_id": "..."}
    added = ensure(event["secret_id"])
    # Names only, never values: the answer is kept in Terraform's state.
    return {"added": added}
