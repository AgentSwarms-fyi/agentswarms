// The sandbox egress allow-list, for a proxy that pulls it (R478).
//
// On ECS and EKS the app can neither write into the proxy's files nor restart
// it, so docker/egress-proxy fetches allowed_domains and allowed_ips from here
// every half minute and has squid re-read them on change. The files are the
// ones the Compose path writes, rendered by the same code from the same
// setting.
//
// Off unless NOTEBOOK_EGRESS_PULL_TOKEN is set, and then only for that token:
// the proxy is the one caller, and the list says what sandboxes may reach.
import { createFileRoute } from "@tanstack/react-router";
import { egressFiles, egressPullTokenMatches } from "@/utils/notebookRuntime/egressApply.server";

export const Route = createFileRoute("/api/notebook/runtime/egress/$file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!egressPullTokenMatches(request.headers.get("authorization"))) {
          return new Response("Not found\n", { status: 404 });
        }
        if (params.file !== "allowed_domains" && params.file !== "allowed_ips") {
          return new Response("Not found\n", { status: 404 });
        }
        try {
          const files = await egressFiles();
          return new Response(files[params.file], {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        } catch (e) {
          // The proxy keeps the list it has; a list it could not read is not
          // an empty one.
          console.error(`[egress] the allow-list could not be read: ${(e as Error).message}`);
          return new Response("The allow-list could not be read\n", { status: 503 });
        }
      },
    },
  },
});
