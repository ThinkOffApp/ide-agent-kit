// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
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
export function createSkillHandler(opts) {
    return async function GET() {
        let content;
        if (opts.content) {
            content = opts.content;
        }
        else if (opts.filePath) {
            const candidates = [
                opts.filePath,
                path.join(process.cwd(), opts.filePath),
                path.join(process.cwd(), 'public', 'SKILL.md'),
            ];
            const found = candidates.find((p) => fs.existsSync(p));
            if (!found) {
                return new NextResponse('Skill file not found', { status: 404 });
            }
            content = fs.readFileSync(found, 'utf8');
        }
        else {
            return new NextResponse('No skill content configured', { status: 500 });
        }
        if (opts.urlReplacements) {
            for (const { pattern, replacement } of opts.urlReplacements) {
                content = content.replace(pattern, replacement);
            }
        }
        return new NextResponse(content, {
            headers: {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Cache-Control': opts.cacheControl ?? 'no-store, max-age=0',
            },
        });
    };
}
