import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useIsMobile } from "@/hooks/use-mobile";

const STORAGE_KEY = "agentswarms.mobile-lab-notice-dismissed";

/**
 * Shown once per browser when an authenticated user opens the lab on a
 * mobile-sized viewport. The lab UIs (swarm canvas, knowledge graph, traces)
 * are tuned for desktop, so we nudge them to switch devices.
 */
export function MobileLabNotice() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isMobile) return;
    try {
      if (window.sessionStorage.getItem(STORAGE_KEY)) return;
    } catch {
      // ignore (private mode)
    }
    setOpen(true);
  }, [isMobile]);

  const handleDismiss = () => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && handleDismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Best on a larger screen</AlertDialogTitle>
          <AlertDialogDescription>
            For the best lab experience, please open the lab menus on a desktop, laptop, or tablet.
            Some builders (swarm canvas, knowledge graph, traces) are designed for wider screens.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleDismiss}>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
