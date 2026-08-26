import { ResetPasswordForm } from "./reset-password-form";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  return <ResetPasswordForm errorCode={firstQueryValue(params.error)} token={firstQueryValue(params.token)} />;
}
