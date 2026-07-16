import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/certification")({
  component: CertificationLayout,
});

function CertificationLayout() {
  return <Outlet />;
}