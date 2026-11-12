import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function assertFile(filePath, description) {
    try {
        await access(filePath);
    } catch {
        throw new Error(`${description} is missing: ${path.relative(root, filePath)}`);
    }
}

const userscriptPath = path.join(root, 'dist', 'chuck.user.js');
await assertFile(userscriptPath, 'Userscript bundle');
const userscript = await readFile(userscriptPath, 'utf8');
if (!userscript.startsWith('// ==UserScript==')) {
    throw new Error('Userscript metadata header is missing from dist/chuck.user.js');
}
const userscriptVersion = userscript.match(/^\/\/ @version\s+(.+)$/m)?.[1]?.trim();
if (userscriptVersion !== packageJson.version) {
    throw new Error(`Userscript version ${userscriptVersion ?? '(missing)'} does not match package version ${packageJson.version}`);
}

for (const target of ['chrome', 'firefox']) {
    const outputRoot = path.join(root, 'dist', target);
    const manifestPath = path.join(outputRoot, 'manifest.json');
    await assertFile(manifestPath, `${target} manifest`);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== packageJson.version) {
        throw new Error(`${target} manifest version ${manifest.version} does not match package version ${packageJson.version}`);
    }

    const matches = manifest.content_scripts?.flatMap((entry) => entry.matches ?? []) ?? [];
    if (!matches.some((match) => match.includes('facebook.com'))) {
        throw new Error(`${target} manifest does not enable the implemented Facebook integration`);
    }

    const referencedFiles = new Set([
        manifest.action?.default_popup,
        ...Object.values(manifest.action?.default_icon ?? {}),
        ...Object.values(manifest.icons ?? {}),
        manifest.background?.service_worker,
        ...(manifest.background?.scripts ?? []),
        ...(manifest.content_scripts?.flatMap((entry) => entry.js ?? []) ?? []),
        ...(manifest.content_scripts?.flatMap((entry) => entry.css ?? []) ?? []),
        ...(manifest.web_accessible_resources?.flatMap((entry) => entry.resources ?? []) ?? []),
    ].filter(Boolean));

    for (const relativePath of referencedFiles) {
        await assertFile(path.join(outputRoot, relativePath), `${target} manifest resource`);
    }

    if (target === 'chrome') {
        const iconPaths = [...Object.values(manifest.action?.default_icon ?? {}), ...Object.values(manifest.icons ?? {})];
        if (iconPaths.some((iconPath) => path.extname(iconPath).toLowerCase() === '.svg')) {
            throw new Error('Chrome manifest icons must use a supported raster format');
        }
    }
}

console.log('Build verification passed for userscript, Chrome, and Firefox artifacts.');
