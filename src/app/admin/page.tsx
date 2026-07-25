import { redirect } from "next/navigation";
import { resolveAdminRedirectPath } from "@/lib/admin-sections";

export default async function AdminIndexPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const params = await searchParams;
  redirect(resolveAdminRedirectPath(params.tab));
}
