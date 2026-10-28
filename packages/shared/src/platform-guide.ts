import type { SkillFile, SyncSkill } from './skill.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import content from './eat-platform-guide/SKILL.md';
import openaiMetadata from './eat-platform-guide/agents/openai.yaml';
import access from './eat-platform-guide/references/access.md';
import environment from './eat-platform-guide/references/environment.md';
import oss from './eat-platform-guide/references/oss.md';
import databases from './eat-platform-guide/references/databases.md';
import llmApi from './eat-platform-guide/references/llm-api.md';
import applications from './eat-platform-guide/references/applications.md';
import folio from './eat-platform-guide/references/folio.md';
import skillsAndMcp from './eat-platform-guide/references/skills-and-mcp.md';
import collaboration from './eat-platform-guide/references/collaboration.md';
import updates from './eat-platform-guide/references/updates.md';

/** Built-in skill: sources are real Markdown files, embedded at build time for browser/CLI/server. */
export const PLATFORM_GUIDE_SLUG = 'eat-platform-guide';
/** Increment whenever the entry, metadata, or any reference file changes. */
export const PLATFORM_GUIDE_VERSION = 47;

const metadata = parseSkillFrontmatter(content);
const files: Record<string, string> = {
  'agents/openai.yaml': openaiMetadata,
  'references/access.md': access,
  'references/environment.md': environment,
  'references/databases.md': databases,
  'references/oss.md': oss,
  'references/llm-api.md': llmApi,
  'references/applications.md': applications,
  'references/folio.md': folio,
  'references/skills-and-mcp.md': skillsAndMcp,
  'references/collaboration.md': collaboration,
  'references/updates.md': updates,
};

/** The existing sync protocol carries the entry plus files; no filesystem access at runtime. */
export function platformGuideSyncSkill(): SyncSkill {
  return {
    slug: PLATFORM_GUIDE_SLUG,
    name: 'eat 平台使用指南',
    description: metadata.description ?? '',
    source: 'builtin',
    relation: 'builtin',
    version: PLATFORM_GUIDE_VERSION,
    content,
    files: Object.entries(files).map(
      ([path, content]): SkillFile => ({
        path,
        content,
        encoding: 'utf8',
        executable: false,
      }),
    ),
  };
}
