import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// FOUND IN THE UI TEST (R527). While a dialog or sheet is open the page sets
// pointer-events: none on everything outside it, toasts included: a toast was
// drawn on top of the approvals inbox but could not be clicked, and a click on
// its Review button went THROUGH it to the Approve button of the card beneath,
// approving something nobody meant to. Toasts take their own clicks, always.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group pointer-events-auto"
      toastOptions={{
        classNames: {
          toast:
            "group toast pointer-events-auto group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
