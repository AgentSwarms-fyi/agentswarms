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

const STORAGE_KEY = "agentswarms.high-demand-notice-ack";

/**
 * One-time notice shown to unauthenticated visitors on the home page,
 * nudging them to use Google sign-in while email registration is degraded.
 * Acknowledgement is persisted in localStorage so it shows only once per browser.
 */
export function HighDemandNotice({ show }: { show: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!show) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      // ignore (private mode)
    }
    setOpen(true);
  }, [show]);

  const handleAck = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && handleAck()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>We're experiencing high demand</AlertDialogTitle>
          <AlertDialogDescription>
            Please use <strong>Google Sign-In</strong> to access AgentSwarms. Email registration is
            facing a temporary issue and may not work reliably right now. Thanks for your patience!
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleAck}>Acknowledge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
