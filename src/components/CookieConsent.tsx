import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { Cookie } from "lucide-react";
import { withCspNonce } from "@/lib/cspNonce";
import { publicConfig, rejectPublicValue } from "@/lib/publicConfig";

const STORAGE_KEY = "agentswarms.cookie-consent.v1";

// Analytics are the OPERATOR'S, or they do not exist. The trust pages promise
// "no telemetry, no call-home", and a hardcoded vendor measurement ID made
// that false: a self-hosted deployment that clicked Accept sent its users'
// page analytics to the project author's Google Analytics property. With no
// IDs configured — the default — there is no banner, no consent to give and
// no external request to make.
//
// The IDs come from publicConfig (R464): PUBLIC_GA_ID / PUBLIC_GTM_ID at
// runtime, else the build-time VITE_GA_ID / VITE_GTM_ID. Either way an ID is used only if it
// is letters, digits and dashes, because it is written into a script URL and
// into an inline script below; a build-time value was never checked before.
function analyticsIds(): { GA_ID?: string; GTM_ID?: string } {
  const { gaId, gtmId } = publicConfig();
  return {
    GA_ID: gaId && !rejectPublicValue("gaId", gaId) ? gaId : undefined,
    GTM_ID: gtmId && !rejectPublicValue("gtmId", gtmId) ? gtmId : undefined,
  };
}

type Consent = "accepted" | "declined";

// Every tag added here carries the page's CSP nonce (R397). The default
// policy allows only the app's own scripts and nonced ones, so without it
// the operator's analytics would be refused the moment the visitor accepts.
function loadAnalytics() {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __agentswarmsAnalyticsLoaded?: boolean;
    dataLayer?: unknown[];
  };
  if (w.__agentswarmsAnalyticsLoaded) return;
  w.__agentswarmsAnalyticsLoaded = true;
  const { GA_ID, GTM_ID } = analyticsIds();

  if (GTM_ID) {
    const gtm = withCspNonce(document.createElement("script"));
    gtm.async = true;
    gtm.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
    document.head.appendChild(gtm);
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  }

  if (GA_ID) {
    const ga = withCspNonce(document.createElement("script"));
    ga.async = true;
    ga.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(ga);
    const inline = withCspNonce(document.createElement("script"));
    inline.text = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');`;
    document.head.appendChild(inline);
  }
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const { GA_ID, GTM_ID } = analyticsIds();
    if (!GA_ID && !GTM_ID) return;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY) as Consent | null;
      if (v === "accepted") {
        loadAnalytics();
      } else if (!v) {
        setVisible(true);
      }
    } catch {
      // ignore
    }
  }, []);

  const persist = (v: Consent) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
    if (v === "accepted") loadAnalytics();
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[100] px-4 pb-4 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-border bg-background/95 p-4 shadow-2xl backdrop-blur sm:flex-row sm:items-center">
        <div className="flex items-start gap-3 sm:flex-1">
          <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="text-sm text-muted-foreground">
            We use only essential cookies to keep you signed in. Optional analytics cookies
            (configured by the operator of this deployment) load only if you accept. See our{" "}
            <Link to="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => persist("declined")}>
            Decline
          </Button>
          <Button size="sm" onClick={() => persist("accepted")}>
            Accept all
          </Button>
        </div>
      </div>
    </div>
  );
}
