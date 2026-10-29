import { createFileRoute } from "@tanstack/react-router";
import LabShell from "@/components/lab/LabShell";

export const Route = createFileRoute("/admin")({
  ssr: false,
  head: () => ({ meta: [{ title: "Panel de maestros · Laboratorio" }] }),
  component: () => <LabShell role="admin" />,
});