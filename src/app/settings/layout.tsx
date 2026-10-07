import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The gate: a sign-in can land on a settings page, so the browser copy is recorded as the
  // signed-in account's here too, and every other tab of the browser profile follows that account.
  return <WorkspaceOwnerGate>{children}</WorkspaceOwnerGate>;
}
