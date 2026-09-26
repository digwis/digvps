// Extract template literals from project-scaffold.ts into .tmpl files.
// Usage: node scripts/extract-scaffold-templates.cjs
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const SRC = path.join(__dirname, "..", "src/main/services/project-scaffold.ts");
const OUT_DIR = path.join(__dirname, "..", "src-tauri", "scaffold-templates");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

const source = fs.readFileSync(SRC, "utf8");
const sf = ts.createSourceFile("project-scaffold.ts", source, ts.ScriptTarget.Latest, true);

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

function templateRaw(node) {
  // Reconstruct the template body with ${exprSource} placeholders verbatim.
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.rawText ?? node.text;
  }
  let out = node.head.rawText ?? node.head.text;
  for (const span of node.templateSpans) {
    const exprSrc = span.expression.getText(sf);
    out += "${" + exprSrc + "}" + (span.literal.rawText ?? span.literal.text);
  }
  return out;
}

function walkFunctions(node, fnName, results) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node !== sf) {
    const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : fnName;
    // collect templates inside this function
    const templates = [];
    function collect(n) {
      if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        templates.push(n);
      }
      ts.forEachChild(n, collect);
    }
    ts.forEachChild(node, collect);
    results.push({ name, node, templates });
    return; // don't descend into nested named functions beyond what we collected
  }
  ts.forEachChild(node, (c) => walkFunctions(c, fnName, results));
}

const fns = [];
walkFunctions(sf, null, fns);

const manifest = {};
const seen = new Set();
for (const fn of fns) {
  if (!fn.name) continue;
  const files = [];
  fn.templates.forEach((tpl, i) => {
    const raw = templateRaw(tpl);
    const fname = `${fn.name}.${i}.tmpl`;
    fs.writeFileSync(path.join(OUT_DIR, fname), raw);
    // collect ${expr} placeholders
    const placeholders = [];
    if (ts.isTemplateExpression(tpl)) {
      for (const span of tpl.templateSpans) {
        placeholders.push(span.expression.getText(sf));
      }
    }
    files.push({ file: fname, placeholders });
  });
  if (files.length) {
    manifest[fn.name] = files;
  }
  seen.add(fn.name);
}

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log("functions with templates:", Object.keys(manifest).length);
console.log("total templates:", Object.values(manifest).reduce((a, b) => a + b.length, 0));
// list all unique placeholders
const ph = new Map();
for (const files of Object.values(manifest))
  for (const f of files) for (const p of f.placeholders) ph.set(p, (ph.get(p) || 0) + 1);
const sorted = [...ph.entries()].sort((a, b) => b[1] - a[1]);
fs.writeFileSync(path.join(OUT_DIR, "placeholders.txt"), sorted.map(([k, v]) => `${v}\t${k}`).join("\n"));
console.log("unique placeholders:", sorted.length);
