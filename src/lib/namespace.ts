import { auth } from "@/auth";

export const DEMO_NAMESPACE = "demo";

export function userNamespace(userId: string) {
  return `user:${userId}`;
}

export async function resolveNamespace() {
  const session = await auth();

  if (session?.user?.id) {
    return { namespace: userNamespace(session.user.id), isDemo: false, userId: session.user.id };
  }

  return { namespace: DEMO_NAMESPACE, isDemo: true, userId: null };
}
