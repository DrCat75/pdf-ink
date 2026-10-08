import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const pdfjs = 'node_modules/pdfjs-dist';
mkdirSync('media', { recursive: true });
cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, 'media/pdf.worker.min.mjs');
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(`${pdfjs}/${d}`, `media/${d}`, { recursive: true });

const result = await build({
  entryPoints: ['src/webview.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !process.argv.includes('--dev'),
  sourcemap: process.argv.includes('--dev') ? 'inline' : false,
  outfile: 'media/webview.js',
  metafile: true,
  logLevel: 'info',
});

// THIRD_PARTY_NOTICES.md: every npm package that ends up in the bundle, plus the
// license files pdf.js ships with its fonts/cmaps/decoders (copied into media/ above).
const pkgs = new Set(['pdfjs-dist']); // the worker is copied, not bundled
for (const f of Object.keys(result.metafile.inputs)) {
  const m = f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (m) pkgs.add(m[1]);
}
const licenseText = (dir) => {
  const f = readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(`${dir}/${f}`, 'utf8').trim() : null;
};
let out = '# Third-party notices\n\nPDF Ink bundles the following open-source software.\n';
for (const p of [...pkgs].sort()) {
  const dir = `node_modules/${p}`;
  const pj = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const text = licenseText(dir);
  if (!text) throw new Error(`No license file found for ${p}`);
  out += `\n## ${p} ${pj.version} (${pj.license})\n\n${pj.homepage || ''}\n\n\`\`\`\n${text}\n\`\`\`\n`;
}
for (const d of ['standard_fonts', 'wasm', 'cmaps']) {
  for (const f of readdirSync(`media/${d}`).filter((n) => n.startsWith('LICENSE')).sort()) {
    out += `\n## pdf.js asset: ${d}/${f}\n\n\`\`\`\n${readFileSync(`media/${d}/${f}`, 'utf8').trim()}\n\`\`\`\n`;
  }
}
writeFileSync('THIRD_PARTY_NOTICES.md', out);
console.log(`THIRD_PARTY_NOTICES.md: ${pkgs.size} packages`);
