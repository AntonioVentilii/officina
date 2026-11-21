import type { ProjectConfig } from './config';

/** Tool layers the onboarder turns into thin pointers to the entry document. */
export const TOOL_LAYER_DOCS = ['CLAUDE.md'] as const;

/** Whether a path is a page agents learn from: the entry document or a file in the docs folder. */
export const isStandardsPage = (config: Pick<ProjectConfig, 'docs'>, path: string): boolean =>
  path === config.docs.entry || path.startsWith(`${config.docs.standards.dir}/`);

/** Whether a path is part of the agent docs: the entry document, a tool layer or the docs folder. */
export const isAgentDocsPath = (config: Pick<ProjectConfig, 'docs'>, path: string): boolean =>
  isStandardsPage(config, path) || (TOOL_LAYER_DOCS as readonly string[]).includes(path);

/**
 * Every file a project must hold before agents build in it: the entry document, the agent docs
 * pages and every catalog page, each once.
 */
export const requiredDocs = (config: Pick<ProjectConfig, 'docs'>): string[] => [
  ...new Set([
    config.docs.entry,
    ...config.docs.standards.pages,
    ...config.docs.standards.catalogs.map((catalog) => catalog.page)
  ])
];
