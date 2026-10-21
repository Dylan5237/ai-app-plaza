interface CatalogEntry {
  id?: string;
  kind?: string;
  label?: string;
  url?: string;
  instructionsPath?: string;
}

interface CatalogApp {
  manifest?: { entries?: CatalogEntry[]; primaryEntry?: string; summary?: string };
}

export function safeHttpUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function catalogUsage(app: CatalogApp): 'platform' | 'agent' {
  return app.manifest?.entries?.some(entry => entry.kind === 'web') ? 'platform' : 'agent';
}

export function platformEntry(app: CatalogApp): CatalogEntry | undefined {
  const entries = (app.manifest?.entries || []).filter(entry => entry.kind === 'web');
  return entries.find(entry => entry.id === app.manifest?.primaryEntry && safeHttpUrl(entry.url))
    || entries.find(entry => safeHttpUrl(entry.url));
}

function declaredAgentFormats(entry: CatalogEntry): string[] {
  // Only classify the delivered entry, not tools mentioned in its compatibility requirements.
  const label = entry.label || '';
  const declared = `${label} ${entry.id || ''}`;
  const formats: string[] = [];
  if (/\bskills?\b|技能/i.test(declared) || /(?:^|\/)SKILL\.md$/i.test(entry.instructionsPath || '')) formats.push('Skill');
  if (/\bmcp\b/i.test(declared)) formats.push('MCP');
  if (/\bcli\b|命令行/i.test(declared)) formats.push('CLI');
  // A Skill that creates plugins is still a Skill; an app/entry name alone is not a plugin declaration.
  if (!formats.includes('Skill') && /\bplugins?\b|插件|扩展包/i.test(label)) formats.push('插件');
  return formats;
}

export function appFormats(app: CatalogApp): string[] {
  const entries = app.manifest?.entries || [];
  const formats = entries.some(entry => entry.kind === 'web') ? ['Web平台'] : [];
  const agentEntries = entries.filter(entry => entry.kind === 'agent');
  const agentFormats = agentEntries.flatMap(declaredAgentFormats);
  if (agentEntries.length && !agentFormats.length) {
    // Older manifests have no structured format field. Use only an explicit distribution description.
    const summary = app.manifest?.summary || '';
    if (/\bplugins?\b|插件包|插件接入|集成插件/i.test(summary)) agentFormats.push('插件');
    else if (/\bskills?\b|技能包/i.test(summary)) agentFormats.push('Skill');
    else agentFormats.push('Agent能力');
  }
  return [...new Set([...formats, ...agentFormats])];
}

export function catalogPageCapacity(options: {
  availableHeight: number; columns: number; cardHeight: number; gap: number;
  headingHeight: number; groupGap: number; usage: string;
  counts: { platform: number; agent: number };
}): number {
  const { availableHeight, columns, cardHeight, gap, headingHeight, groupGap, counts } = options;
  const groupHeight = (count: number) => {
    const rows = Math.ceil(count / columns);
    return headingHeight + rows * cardHeight + Math.max(0, rows - 1) * gap;
  };
  const rows = Math.max(1, Math.floor((availableHeight - headingHeight + gap) / (cardHeight + gap)));
  const maximum = Math.min(100, rows * columns);
  if (options.usage !== 'all' || !counts.platform || !counts.agent) return maximum;
  // The server sorts platform apps first. Only the page crossing that boundary can have two groups.
  for (let size = maximum; size > 1; size--) {
    const platformTail = counts.platform % size;
    if (!platformTail) return size;
    const agentHead = Math.min(counts.agent, size - platformTail);
    if (groupHeight(platformTail) + groupHeight(agentHead) + groupGap <= availableHeight) return size;
  }
  return 1;
}
