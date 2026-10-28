// First: Zod must be told before any schema is built (see the file).
import "./lib/zodNoEval";
import { createRouter, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { DefaultErrorComponent } from "./components/DefaultErrorComponent";
import { cspNonce } from "./lib/cspNonce";

// AgentSwarms Router
export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    // Called once per request on the server: the router stamps this nonce on
    // every inline script it renders (hydration, streaming, head scripts) and
    // on <meta property="csp-nonce">, and the header allows exactly it (R397).
    ssr: { nonce: cspNonce() },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
    // Route changes cross-fade via the View Transitions API: the old page
    // stays visible until the new one is painted, so there is no blank frame
    // and nothing jumps. A keyed CSS enter-animation was tried first and
    // produced exactly those artifacts; the browser primitive is the fix.
    // Unsupported browsers just navigate instantly — the correct fallback.
    defaultViewTransition: true,
  });

  return router;
};
