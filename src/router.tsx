import { createRouter, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { DefaultErrorComponent } from "./components/DefaultErrorComponent";

// AgentSwarms Router
export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
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
