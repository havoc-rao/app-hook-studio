/** This source is emitted into the target renderer, never evaluated in the host. */
export function domRuntime(id: string, selector: string, config: unknown, actions: string): string {
  return `;(() => {
  const token = ${JSON.stringify(id)};
  const registry = globalThis.__appHookStudioDom || (globalThis.__appHookStudioDom = new Map());
  if (registry.has(token)) return;
  const config = ${JSON.stringify(config)};
  const actions = [${actions}];
  const last = new Map(), busy = new Set();
  const reset = () => last.clear();
  const listener = async (event) => {
    if (event.repeat) return;
    if (event.defaultPrevented || event.isComposing) { reset(); return; }
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root || !root.getClientRects().length || !root.contains(event.target)) { reset(); return; }
    for (let i = 0; i < config.length; i++) {
      const c = config[i];
      if (!c.enabled) continue;
      let match = false;
      if (c.trigger === 'double-escape') {
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          const previous = last.get(i), time = performance.now();
          last.set(i, { time, target: event.target });
          if (previous && previous.target === event.target && time - previous.time <= c.withinMs) {
            match = true; last.delete(i);
          }
        } else last.delete(i);
      } else {
        const k = c.key;
        match = event.code === k.code && event.metaKey === k.meta && event.ctrlKey === k.ctrl && event.altKey === k.alt && event.shiftKey === k.shift;
      }
      if (!match) continue;
      reset();
      event.preventDefault(); event.stopPropagation();
      if (busy.has(i)) return;
      busy.add(i);
      try { await actions[i](event, root); }
      catch (error) { console.error('[App Hook Studio]', error); }
      finally { busy.delete(i); }
      break;
    }
  };
  document.addEventListener('keydown', listener);
  document.addEventListener('focusin', reset);
  document.addEventListener('visibilitychange', reset);
  registry.set(token, { listener, reset });
})();\n`;
}
