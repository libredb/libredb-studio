import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";
import Studio from "@/components/Studio";

export default function Page() {
  return (
    <WorkspaceOwnerGate>
      <Studio />
    </WorkspaceOwnerGate>
  );
}
