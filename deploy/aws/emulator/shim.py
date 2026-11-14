"""A local HTTP proxy between Terraform and AWS Emulator (deploy/aws/emulator).

It works around two of the emulator's open issues, each of which stops every
apply of these roots; delete its part when the issue is fixed upstream:

- aws/aws-emulator#46. For an all-protocols rule (IpProtocol -1), AWS ignores
  the ports in a RevokeSecurityGroupEgress; the emulator compares them. The AWS
  provider revokes a new group's default egress rule naming ports 0-0, so no
  aws_security_group can be created. This drops those ports from the request.
- aws/aws-emulator#56. Since provider 6.23 bucket tags go through S3 Control,
  whose SDK puts the account id in front of the endpoint's host
  (000000000000.127.0.0.1), which nothing resolves. Terraform reaches the
  emulator through this proxy (the provider's http_proxy), so no host is ever
  looked up: every request goes to the emulator, whatever its host.

A changed body no longer matches its SigV4 signature, so run.sh starts the
emulator with request authentication off. Standard library only.

    python -I shim.py <port> <emulator url> <emulator ca.pem>
"""

import http.client
import http.server
import ssl
import sys
import urllib.parse

PORT = int(sys.argv[1])
UPSTREAM = urllib.parse.urlsplit(sys.argv[2])
TLS = ssl.create_default_context(cafile=sys.argv[3])
# Headers that describe one hop, not the request.
HOP = {
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def without_ports_on_all_protocols(body: bytes) -> bytes:
    """#46: a RevokeSecurityGroupEgress with the ports AWS ignores removed."""
    form = urllib.parse.parse_qsl(body.decode(), keep_blank_values=True)
    if ("Action", "RevokeSecurityGroupEgress") not in form:
        return body
    every_protocol = {k.rsplit(".", 1)[0] for k, v in form if k.endswith(".IpProtocol") and v == "-1"}
    kept = [
        (k, v)
        for k, v in form
        if not (k.rsplit(".", 1)[0] in every_protocol and k.rsplit(".", 1)[-1] in ("FromPort", "ToPort"))
    ]
    return urllib.parse.urlencode(kept).encode()


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def forward(self):
        target = urllib.parse.urlsplit(self.path)
        body = self.read_body()
        if self.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
            body = without_ports_on_all_protocols(body)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Host"] = UPSTREAM.netloc
        headers["Content-Length"] = str(len(body))
        upstream = http.client.HTTPSConnection(UPSTREAM.hostname, UPSTREAM.port, context=TLS, timeout=900)
        try:
            path = (target.path or "/") + (f"?{target.query}" if target.query else "")
            upstream.request(self.command, path, body=body, headers=headers)
            answer = upstream.getresponse()
            data = answer.read()
            self.send_response_only(answer.status, answer.reason)
            for k, v in answer.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            # A HEAD answer keeps the length of what a GET would have sent.
            length = answer.getheader("Content-Length") if self.command == "HEAD" else None
            self.send_header("Content-Length", length or str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        finally:
            upstream.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_PATCH = forward

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Proxy)
    print(f"shim on 127.0.0.1:{PORT} -> {UPSTREAM.geturl()}", flush=True)
    server.serve_forever()
