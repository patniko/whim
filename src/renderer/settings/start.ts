type Load = () => Promise<unknown>;

/** Only the active settings panel may start network/runtime discovery. */
export function startSettings(
  loaders: Record<string, Load[]>,
  showError: (error: string) => void,
): { refresh: () => Promise<void> } {
  const loaded = new Set<string>();
  const flights = new Map<string, Promise<void>>();
  function load(name: string, force = false): Promise<void> {
    if (flights.has(name)) return flights.get(name)!;
    if (!force && loaded.has(name)) return Promise.resolve();
    const work = Promise.all((loaders[name] ?? []).map(load => load())).then(() => {
      loaded.add(name);
    }).catch(error => {
      showError(error instanceof Error ? error.message : 'Settings could not load');
    }).finally(() => { flights.delete(name); });
    flights.set(name, work);
    return work;
  }
  function active(): string {
    return document.querySelector<HTMLElement>('.settings-tab-btn.active')?.dataset.tab ?? 'general';
  }
  document.querySelectorAll<HTMLElement>('.settings-tab-btn').forEach(tab => {
    tab.addEventListener('click', () => { void load(tab.dataset.tab ?? 'general'); });
  });
  void load(active());
  return { refresh: () => { loaded.clear(); return load(active(), true); } };
}
