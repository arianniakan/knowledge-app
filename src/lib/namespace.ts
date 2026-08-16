import { auth } from "@/auth";
import { touchUserActivity } from "@/lib/user-activity";

export const DEMO_NAMESPACE = "demo";

export function userNamespace(userId: string) {
  return `user:${userId}`;
}

export async function resolveNamespace() {
  const session = await auth();

  if (session?.user?.id) {
    const namespace = userNamespace(session.user.id);
    await touchUserActivity(namespace);
    return { namespace, isDemo: false, userId: session.user.id };
  }

  return { namespace: DEMO_NAMESPACE, isDemo: true, userId: null };
}
