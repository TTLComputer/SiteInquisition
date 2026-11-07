import type { CoreClient as Client, ReproDefinition, Reproduction } from '../api';

/**
 * Save an editor's contents as a saved reproduction: a new one the first
 * time, then a new revision of the same one. `saved` is the revision the
 * editor started from, so a save made meanwhile by someone else is refused
 * instead of overwritten.
 */
export async function saveReproduction(
  client: Client,
  opts: { label: string; definition: ReproDefinition; exchangeId?: string; saved?: { id: string; revision: number } },
): Promise<Reproduction> {
  const list = await client.reproductions();
  const cur = opts.saved && list.find((r) => r.id === opts.saved!.id);
  if (cur) return client.saveReproduction({ ...cur, definition: opts.definition }, opts.saved!.revision);
  const taken = new Set(list.map((r) => r.name));
  let name = opts.label;
  for (let i = 2; taken.has(name); i++) name = `${opts.label} ${i}`;
  const endpoint = opts.exchangeId ? await client.noteFor(opts.exchangeId).then((n) => n?.key, () => undefined) : undefined;
  return client.saveReproduction({ name, definition: opts.definition, ...(opts.exchangeId ? { source: { exchangeId: opts.exchangeId } } : {}), ...(endpoint ? { endpoints: [endpoint] } : {}) });
}
