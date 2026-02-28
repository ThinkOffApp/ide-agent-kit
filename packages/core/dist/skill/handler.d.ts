import { NextResponse } from 'next/server';
export interface SkillHandlerOptions {
    /** Inline markdown content (xfor/agentpuzzles pattern). */
    content?: string;
    /** Path to a SKILL.md file on disk (antfarm pattern). */
    filePath?: string;
    /** Cache-Control header. Default: 'no-store, max-age=0'. */
    cacheControl?: string;
    /** URL normalizations to apply when reading from file. */
    urlReplacements?: Array<{
        pattern: RegExp;
        replacement: string;
    }>;
}
/**
 * Create a GET handler for the /api/skill route.
 * Serves markdown API documentation for AI agents.
 *
 * Usage (inline content):
 *   export const GET = createSkillHandler({ content: SKILL_MD });
 *
 * Usage (file-based):
 *   export const GET = createSkillHandler({ filePath: 'public/SKILL.md' });
 */
export declare function createSkillHandler(opts: SkillHandlerOptions): () => Promise<NextResponse<unknown>>;
