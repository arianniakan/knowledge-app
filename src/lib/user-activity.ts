import { redis } from "@/lib/redis";

const KNOWN_USERS_KEY = "knowledge-app:known-users";

function lastActiveKey(namespace: string) {
  return `knowledge-app:last-active:${namespace}`;
}

export async function touchUserActivity(namespace: string) {
  await Promise.all([
    redis.sadd(KNOWN_USERS_KEY, namespace),
    redis.set(lastActiveKey(namespace), Date.now()),
  ]);
}

export async function listKnownNamespaces(): Promise<string[]> {
  return redis.smembers(KNOWN_USERS_KEY);
}

export async function getLastActive(namespace: string): Promise<number | null> {
  return redis.get<number>(lastActiveKey(namespace));
}

export async function forgetUser(namespace: string) {
  await Promise.all([redis.srem(KNOWN_USERS_KEY, namespace), redis.del(lastActiveKey(namespace))]);
}
