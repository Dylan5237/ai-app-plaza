interface CatalogEntry {
  id?: string;
  kind?: string;
  label?: string;
  url?: string;
  instructionsPath?: string;
}

interface CatalogApp {
  manifest?: { entries?: CatalogEntry[]; primaryEntry?: string; summary?: string };
  entryAvailability?: Record<string, { status?: string; reason?: string }>;
  lifecycle?: { status?: string };
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

export function primaryAction(app: CatalogApp) {
  const primaryId = app.manifest?.primaryEntry;
  const entry = primaryId ? app.manifest?.entries?.find(item => item.id === primaryId) : undefined;
  let reason = '';
  if (app.lifecycle?.status && app.lifecycle.status !== 'published') reason = '应用已下架或删除，请返回刷新。';
  else if (!entry) reason = '作者指定的主入口缺失，请查看详情。';
  else if (app.entryAvailability?.[entry.id!]?.status === 'disabled') reason = app.entryAvailability[entry.id!]!.reason || '主入口已停用。';
  else if (entry.kind === 'web' && !safeHttpUrl(entry.url)) reason = '主入口地址无效或不安全。';
  else if (entry.kind === 'agent' && !entry.instructionsPath) reason = '主入口缺少接入说明。';
  else if (!['web', 'agent'].includes(entry.kind || '')) reason = '主入口类型不可用。';
  return { entry, reason, label: entry?.kind === 'web' ? '打开平台' : entry?.kind === 'agent' ? '接入我的Agent' : '入口不可用' };
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
  headingHeight: number; usage: string;
}): number {
  const { availableHeight, columns, cardHeight, gap } = options;
  const headingHeight = options.usage === 'all' ? 0 : options.headingHeight;
  const rows = Math.max(1, Math.floor((availableHeight - headingHeight + gap) / (cardHeight + gap)));
  return Math.min(100, rows * columns);
}
