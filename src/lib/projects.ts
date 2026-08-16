import { DEMO_NAMESPACE } from "@/lib/namespace";
import { pineconeIndex } from "@/lib/pinecone";
import { redis, sourcesKey, type SourceRecord } from "@/lib/redis";

export function projectsKey(namespace: string) {
  return `knowledge-app:projects:${namespace}`;
}

export type ProjectRecord = {
  id: string;
  name: string;
  sourceIds: string[];
  createdAt: number;
  updatedAt: number;
};

export async function listProjects(namespace: string): Promise<ProjectRecord[]> {
  const entries = await redis.hgetall<Record<string, ProjectRecord>>(projectsKey(namespace));
  return Object.values(entries ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(namespace: string, projectId: string): Promise<ProjectRecord | null> {
  const project = await redis.hget<ProjectRecord>(projectsKey(namespace), projectId);
  return project ?? null;
}

async function writeProject(namespace: string, project: ProjectRecord) {
  await redis.hset(projectsKey(namespace), { [project.id]: JSON.stringify(project) });
}

export async function createProject(namespace: string, name: string): Promise<ProjectRecord> {
  const now = Date.now();
  const project: ProjectRecord = {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled project",
    sourceIds: [],
    createdAt: now,
    updatedAt: now,
  };

  await writeProject(namespace, project);
  return project;
}

export async function renameProject(
  namespace: string,
  projectId: string,
  name: string,
): Promise<ProjectRecord | null> {
  const project = await getProject(namespace, projectId);
  if (!project) return null;

  const updated: ProjectRecord = { ...project, name: name.trim() || project.name, updatedAt: Date.now() };
  await writeProject(namespace, updated);
  return updated;
}

export async function attachSource(
  namespace: string,
  projectId: string,
  sourceId: string,
): Promise<ProjectRecord | null> {
  const project = await getProject(namespace, projectId);
  if (!project) return null;

  if (project.sourceIds.includes(sourceId)) return project;

  const updated: ProjectRecord = {
    ...project,
    sourceIds: [...project.sourceIds, sourceId],
    updatedAt: Date.now(),
  };
  await writeProject(namespace, updated);
  return updated;
}

export async function detachSource(
  namespace: string,
  projectId: string,
  sourceId: string,
): Promise<ProjectRecord | null> {
  const project = await getProject(namespace, projectId);
  if (!project) return null;

  const updated: ProjectRecord = {
    ...project,
    sourceIds: project.sourceIds.filter((id) => id !== sourceId),
    updatedAt: Date.now(),
  };
  await writeProject(namespace, updated);
  return updated;
}

export async function removeSourceFromAllProjects(namespace: string, sourceId: string) {
  const projects = await listProjects(namespace);
  const affected = projects.filter((project) => project.sourceIds.includes(sourceId));

  await Promise.all(
    affected.map((project) =>
      writeProject(namespace, {
        ...project,
        sourceIds: project.sourceIds.filter((id) => id !== sourceId),
        updatedAt: Date.now(),
      }),
    ),
  );
}

export async function deleteProject(namespace: string, projectId: string) {
  await redis.hdel(projectsKey(namespace), projectId);
}

/**
 * Copies the seeded demo sources into a user's own namespace and attaches them to a
 * project, without re-embedding — reuses the demo's existing Pinecone vectors, since
 * namespaces already isolate the copies from the original.
 */
export async function seedProjectFromDemo(namespace: string, projectId: string) {
  const demoEntries = await redis.hgetall<Record<string, SourceRecord>>(sourcesKey(DEMO_NAMESPACE));
  const demoSources = Object.values(demoEntries ?? {});

  // Copy each source's vectors + registry entry in parallel — independent per-source I/O.
  const copiedSourceIds = await Promise.all(
    demoSources.map(async (demoSource) => {
      const chunkIds = Array.from(
        { length: demoSource.chunkCount },
        (_, index) => `${demoSource.id}::${index}`,
      );
      if (chunkIds.length === 0) return null;

      const { records } = await pineconeIndex.namespace(DEMO_NAMESPACE).fetch({ ids: chunkIds });
      const values = Object.values(records);
      if (values.length === 0) return null;

      await pineconeIndex.namespace(namespace).upsert({ records: values });

      const copiedSource: SourceRecord = { ...demoSource, createdAt: Date.now() };
      await redis.hset(sourcesKey(namespace), { [demoSource.id]: JSON.stringify(copiedSource) });

      return demoSource.id;
    }),
  );

  const validSourceIds = copiedSourceIds.filter((id): id is string => id !== null);
  if (validSourceIds.length === 0) return;

  // Single read-modify-write to attach everything at once, instead of one per source.
  const project = await getProject(namespace, projectId);
  if (!project) return;

  await writeProject(namespace, {
    ...project,
    sourceIds: [...new Set([...project.sourceIds, ...validSourceIds])],
    updatedAt: Date.now(),
  });
}
