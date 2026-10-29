import { createFileRoute } from "@tanstack/react-router";
import LabShell from "@/components/lab/LabShell";

export const Route = createFileRoute("/estudiante")({
  ssr: false,
  head: () => ({ meta: [{ title: "Mi horario · Laboratorio" }] }),
  component: () => <LabShell role="student" />,
});