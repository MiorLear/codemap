#!/usr/bin/env node
/**
 * codemap build — convierte un proyecto (TypeScript/JavaScript y Python) en un mapa navegable:
 *
 *   sistema (grupos) > archivos > funciones > flujo interno de una funcion
 *
 * La estructura sale del compilador de TypeScript y del `ast` de Python, igual que "Ir a
 * definicion" en un editor: imports resueltos, llamadas resueltas a su declaracion, rutas de
 * Express montadas con su prefijo real. Nada de eso lo inventa un modelo. Las descripciones salen
 * de los comentarios de documentacion del propio codigo y, si faltan, de `.codemap/ai-notes.json`
 * (resumenes que escribe el agente, atados al hash del codigo para saber cuando quedaron viejos).
 *
 *   node src/build.mjs [--project dir] [--base main] [--plan id]
 *   node src/build.mjs --only ruta/archivo.ts [--depth 1]     mapa de un solo archivo
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadPlans, formatPlan } from "./plans.mjs";
import { loadConfig, listFiles, isSource, paths as projectPaths } from "./project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const ONLY = args.only ? path.resolve(args.only) : null;
const { cfg, root: ROOT, detected } = loadConfig({ project: args.project ?? (ONLY ? path.dirname(ONLY) : undefined), config: args.config });
const P = projectPaths(ROOT);
const OUT = path.resolve(args.out ?? P.out);
const BASE = args.base ?? cfg.base ?? "HEAD";
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const BUILTINS = new Set(builtinModules);
const TS_FILE = /.(tsx?|jsx?|mjs|cjs)$/;

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  baseUrl: ROOT,
  paths: cfg.paths ?? {},
};

/* ───────────────────────── 1. Archivos del proyecto ───────────────────────── */

let fileList;
let focus = null;
if (ONLY) {
  // Mapa de un archivo: el archivo y lo que importa directamente (--depth niveles), para que
  // sus llamadas a otros archivos se puedan resolver y dibujar
  if (!fs.existsSync(ONLY)) throw new Error(`No existe ${args.only}`);
  focus = rel(ONLY);
  fileList = neighborhood(focus, Number(args.depth ?? 1));
  cfg.include = fileList;
} else {
  fileList = listFiles(ROOT).filter(
    (f) => cfg.include.some((p) => f.startsWith(p)) && isSource(f, cfg) && fs.existsSync(path.join(ROOT, f)),
  );
}
const fileSet = new Set(fileList);

const program = ts.createProgram(
  fileList.filter((f) => TS_FILE.test(f)).map((f) => path.join(ROOT, f)),
  options,
);
const checker = program.getTypeChecker();

/* ───────────────────────── 2. Modelo ───────────────────────── */

const graph = {
  meta: {
    name: cfg.name ?? path.basename(ROOT),
    root: ROOT.split(path.sep).join("/"),
    base: BASE,
    focus,
    detected,
    layers: cfg.layers ?? [],
    generatedAt: new Date().toISOString(),
  },
  groups: {},
  files: {},
  fns: {},
  externals: {},
  routes: [],
  http: [],
};

const declToFn = new Map(); // nodo de declaracion -> id de funcion
const routers = new Map(); // "archivo::variable" -> true
const apps = new Map(); // "archivo::variable" -> archivo del servidor
const mounts = []; // app.use / router.use
const pendingRoutes = []; // se completan cuando se conocen todos los montajes
const fnBodies = new Map(); // id -> nodo cuyo cuerpo se analiza

const aiNotes = readJson(P.notes, {});

for (const g of cfg.groups) {
  graph.groups[g.id] ??= { id: g.id, name: g.name, desc: g.desc ?? "", layer: g.layer ?? "", files: [] };
  if (g.name) Object.assign(graph.groups[g.id], { name: g.name, desc: g.desc ?? "", layer: g.layer ?? "" });
}

function groupOf(file) {
  let best = null;
  for (const g of cfg.groups) {
    if (file.startsWith(g.prefix) && (!best || g.prefix.length > best.prefix.length)) best = g;
  }
  if (best) return best.id;
  const dir = path.posix.dirname(file);
  graph.groups[dir] ??= { id: dir, name: dir, desc: "", layer: "", files: [] };
  return dir;
}

/* ───────────────────────── 3. Primera pasada: declaraciones ───────────────────────── */

for (const file of fileList) {
  const sf = program.getSourceFile(path.join(ROOT, file));
  if (!sf) continue;
  const group = groupOf(file);
  const fileDoc = fileDocOf(sf);
  const lines = sf.getLineAndCharacterOfPosition(sf.end).line + 1;

  graph.groups[group].files.push(file);
  graph.files[file] = {
    id: file,
    group,
    name: path.posix.basename(file),
    summary: summarize(fileDoc),
    doc: fileDoc,
    lines,
    imports: [],
    fns: [],
    warnings: fileDoc ? [] : [warn("sin-descripcion", "El archivo no explica para que existe (falta JSDoc de cabecera).")],
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) {
      recordImport(file, sf, st);
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      addFn(file, sf, st.name.text, st, st, st, { exported: isExported(st) });
    } else if (ts.isClassDeclaration(st) && st.name) {
      for (const m of st.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) && m.body && m.name) {
          addFn(file, sf, `${st.name.text}.${m.name.getText(sf)}`, m, m, m, {
            exported: isExported(st),
            kind: "method",
          });
        }
      }
    } else if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const init = unwrap(decl.initializer);
        const key = `${file}::${name}`;
        if (isFunctionLike(init)) {
          addFn(file, sf, name, decl, init, st, { exported: isExported(st) });
        } else if (ts.isCallExpression(init) && /(^|\.)Router$/.test(init.expression.getText(sf))) {
          routers.set(key, true);
        } else if (ts.isCallExpression(init) && init.expression.getText(sf) === "express") {
          apps.set(key, file);
        } else if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            const pname = p.name?.getText(sf);
            if (ts.isMethodDeclaration(p) && p.body) {
              addFn(file, sf, `${name}.${pname}`, p, p, p, { exported: isExported(st), kind: "method" });
            } else if (ts.isPropertyAssignment(p) && isFunctionLike(unwrap(p.initializer))) {
              addFn(file, sf, `${name}.${pname}`, p, unwrap(p.initializer), p, { exported: isExported(st), kind: "method" });
            }
          }
        }
      }
    } else if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
      recordTopLevelCall(file, sf, st, st.expression);
    }
  }
}

function addFn(file, sf, name, declNode, fnNode, docNode, extra = {}) {
  const id = `${file}#${name}`;
  const doc = docOf(docNode, sf);
  const start = sf.getLineAndCharacterOfPosition(docNode.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(docNode.getEnd()).line + 1;
  const code = docNode.getText(sf);
  const isComponent = file.endsWith(".tsx") && /^[A-Z]/.test(name);
  const fn = {
    id,
    file,
    name,
    kind: extra.kind ?? (isComponent ? "component" : "function"),
    exported: !!extra.exported,
    async: !!fnNode?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    line: start,
    endLine: end,
    summary: summarize(doc),
    summarySource: doc ? "jsdoc" : null,
    doc,
    code: code.split("\n").length > 300 ? code.split("\n").slice(0, 300).join("\n") + "\n// …" : code,
    hash: hash(code),
    calls: [],
    calledBy: [],
    flow: null,
    warnings: [],
    ...extra.more,
  };
  if (extra.route) fn.route = extra.route;
  graph.fns[id] = fn;
  graph.files[file].fns.push(id);
  declToFn.set(declNode, id);
  if (fnNode) fnBodies.set(id, fnNode);
  return fn;
}

function recordTopLevelCall(file, sf, st, call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const ownerKey = keyOfExpr(callee.expression);
  const [first, ...rest] = call.arguments;

  // router.get("/ruta", mw, handler)
  if (/^(get|post|put|patch|delete|all)$/.test(method) && first && ts.isStringLiteralLike(first)) {
    const handler = rest.at(-1);
    const mws = rest.slice(0, -1).map((a) => mwLabel(a, sf));
    const verb = method.toUpperCase();
    const fn = addFn(file, sf, `${verb} ${first.text}`, st, handler && isFunctionLike(unwrap(handler)) ? unwrap(handler) : null, st, {
      kind: "route",
      route: { method: verb, path: first.text, owner: ownerKey, middlewares: mws, mounts: [] },
    });
    fn.pos = st.getStart(sf);
    if (handler && isFunctionLike(unwrap(handler))) {
      fn.async = !!unwrap(handler).modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    } else if (handler) {
      fn.handlerRef = handler; // se resuelve en la segunda pasada
    }
    fn.middlewareNodes = rest.slice(0, -1);
    pendingRoutes.push(fn);
    return;
  }

  // app.use("/prefijo", mw, routerA, routerB)  |  app.use(mw)
  if (method === "use") {
    const hasPrefix = first && ts.isStringLiteralLike(first);
    const items = (hasPrefix ? rest : call.arguments).map((a) => ({
      text: mwLabel(a, sf),
      key: keyOfExpr(a),
    }));
    mounts.push({ file, owner: ownerKey, prefix: hasPrefix ? first.text : null, items, pos: st.getStart(sf) });
    return;
  }

  // plataforma.extend(() => <Card/>), app.mount(() => ...) y similares: punto de entrada
  const fnArg = call.arguments.find((a) => isFunctionLike(unwrap(a)));
  if (fnArg) {
    addFn(file, sf, callee.getText(sf), st, unwrap(fnArg), st, { kind: "entry" });
  }
}

function recordImport(file, sf, st) {
  if (!st.moduleSpecifier || !ts.isStringLiteralLike(st.moduleSpecifier)) return;
  const spec = st.moduleSpecifier.text;
  let typeOnly = false;
  let names = [];
  if (ts.isImportDeclaration(st)) {
    const clause = st.importClause;
    typeOnly = !!clause?.isTypeOnly;
    if (clause?.name) names.push(clause.name.text);
    const nb = clause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      names.push(...nb.elements.map((e) => e.name.text));
      if (!typeOnly && nb.elements.length && nb.elements.every((e) => e.isTypeOnly) && !clause.name) typeOnly = true;
    }
  } else {
    typeOnly = st.isTypeOnly;
  }

  const resolved = ts.resolveModuleName(spec, sf.fileName, options, ts.sys).resolvedModule;
  let target = resolved ? rel(resolved.resolvedFileName) : null;
  if (target && cfg.fileAliases?.[target]) target = cfg.fileAliases[target];
  if (target && fileSet.has(target)) {
    graph.files[file].imports.push({ to: target, internal: true, typeOnly, names });
    return;
  }
  if (spec.startsWith(".")) {
    // Relativo pero fuera del alcance del mapa: se muestra, pero no se sigue.
    graph.files[file].imports.push({ to: spec, internal: false, typeOnly, names, outOfScope: true });
    return;
  }
  const bare = spec.replace(/^node:/, "");
  const pkg = BUILTINS.has(bare.split("/")[0]) ? `node:${bare.split("/")[0]}` : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  graph.files[file].imports.push({ to: pkg, internal: false, typeOnly, names });
  (graph.externals[pkg] ??= { name: pkg, builtin: pkg.startsWith("node:"), usedBy: [] }).usedBy.push(file);
}

/* ───────────────────────── 4. Segunda pasada: llamadas, rutas, flujos ───────────────────────── */

for (const [id, body] of fnBodies) {
  const fn = graph.fns[id];
  const calls = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const t = resolveFn(n.expression);
      if (t) calls.add(t);
      for (const a of n.arguments ?? []) {
        if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) {
          const r = resolveFn(a);
          if (r) calls.add(r);
        }
      }
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const t = resolveFn(n.tagName);
      if (t) calls.add(t);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  calls.delete(id);
  fn.calls = [...calls];
  fn.flow = buildFlow(body, body.getSourceFile());
}

// Handlers pasados por referencia y middlewares de cada ruta
for (const fn of pendingRoutes) {
  if (fn.handlerRef) {
    const t = resolveFn(fn.handlerRef);
    if (t) fn.calls.push(t);
    delete fn.handlerRef;
  }
  for (const m of fn.middlewareNodes ?? []) {
    const t = resolveFn(ts.isCallExpression(m) ? m.expression : m);
    if (t && !fn.calls.includes(t)) fn.calls.push(t);
  }
  delete fn.middlewareNodes;
}

// Prefijo real de cada ruta, siguiendo los app.use(...) hasta el servidor
// `before` es la posicion del montaje hijo: un app.use(mw) escrito despues no le aplica.
function prefixesOf(ownerKey, before, seen = new Set()) {
  if (!ownerKey || seen.has(ownerKey)) return [];
  seen.add(ownerKey);
  if (apps.has(ownerKey)) {
    const global = mounts
      .filter((m) => m.owner === ownerKey && m.prefix === null && m.pos < before)
      .flatMap((m) => m.items.filter((i) => !routers.has(i.key)).map((i) => i.text));
    return [{ server: apps.get(ownerKey), prefix: "", middlewares: global }];
  }
  const out = [];
  for (const m of mounts) {
    const idx = m.items.findIndex((i) => i.key === ownerKey);
    if (idx === -1) continue;
    const mws = m.items.slice(0, idx).filter((i) => !routers.has(i.key)).map((i) => i.text);
    for (const parent of prefixesOf(m.owner, m.pos, new Set(seen))) {
      out.push({
        server: parent.server,
        prefix: joinPath(parent.prefix, m.prefix ?? ""),
        middlewares: [...parent.middlewares, ...mws],
      });
    }
  }
  return out;
}

for (const fn of pendingRoutes) {
  const r = fn.route;
  const pre = prefixesOf(r.owner, fn.pos);
  r.mounts = pre.map((p) => ({ server: p.server, fullPath: joinPath(p.prefix, r.path), middlewares: [...p.middlewares, ...r.middlewares] }));
  r.fullPath = r.mounts[0]?.fullPath ?? r.path;
  r.server = r.mounts[0]?.server ?? null;
  if (!r.mounts.length) fn.warnings.push(warn("ruta-sin-montar", "No se encontro un app.use(...) que monte este router: la ruta podria no estar expuesta."));
  graph.routes.push(fn.id);
}

// Llamadas HTTP del frontend al backend: fetch(`${BACKEND}/api/...`), cliente.fetch(...)
for (const [id, body] of fnBodies) {
  const sf = body.getSourceFile();
  const visit = (n) => {
    if (ts.isCallExpression(n) && /(^|\.)fetch$/.test(n.expression.getText(sf).replace(/\s/g, "")) && n.arguments[0]) {
      const url = urlPattern(n.arguments[0], sf);
      const opts = n.arguments[1];
      let method = "GET";
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const m = opts.properties.find((p) => p.name?.getText(sf) === "method");
        if (m && ts.isPropertyAssignment(m) && ts.isStringLiteralLike(m.initializer)) method = m.initializer.text.toUpperCase();
      }
      if (url) {
        const target = pendingRoutes.find((r) => (r.route.method === method || r.route.method === "ALL") && r.route.mounts.some((mt) => routeRegex(mt.fullPath).test(url)));
        graph.http.push({ from: id, to: target?.id ?? null, method, url });
        if (target && !graph.fns[id].calls.includes(target.id)) graph.fns[id].calls.push(target.id);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
}

mergePython();

for (const fn of Object.values(graph.fns)) {
  for (const c of fn.calls) graph.fns[c]?.calledBy.push(fn.id);
}
// APIs de terceros a las que se llama por HTTP, agrupadas por host
graph.apis = {};
for (const h of graph.http) {
  if (h.to || !/^https?:\/\//.test(h.url)) continue;
  const host = new URL(h.url.replace(/:p/g, "x")).host;
  const api = (graph.apis[host] ??= { host, calls: [] });
  api.calls.push({ from: h.from, method: h.method, url: h.url });
  (graph.fns[h.from].apiCalls ??= []).push(host);
}

/* ───────────────────────── 5. Lineamientos ───────────────────────── */

for (const fn of Object.values(graph.fns)) {
  const lines = fn.endLine - fn.line + 1;
  if (!fn.doc && fn.exported && fn.kind !== "route") {
    fn.warnings.push(warn("sin-descripcion", "Funcion exportada sin JSDoc: quien la use no sabe que promete."));
  }
  if (lines > (cfg.rules?.longFunctionLines ?? 80)) {
    fn.warnings.push(warn("funcion-larga", `${lines} lineas. Dificil de revisar de un vistazo; candidata a dividirse.`));
  }
  if (cfg.rules?.express4AsyncErrors && fn.kind === "route" && fn.async && fnBodies.has(fn.id) && hasUnguardedAwait(fnBodies.get(fn.id))) {
    fn.warnings.push(
      warn("async-sin-try", "Handler async con un await fuera de try/catch. Express 4 no captura promesas rechazadas: si falla, la peticion se queda sin respuesta."),
    );
  }
  // Resumen escrito por el agente, valido solo si el codigo no cambio desde que se escribio
  const note = aiNotes[fn.id];
  if (!fn.summary && note) {
    fn.summary = note.summary;
    fn.summarySource = note.hash === fn.hash ? "ia" : "ia-desactualizado";
  }
}
for (const f of Object.values(graph.files)) {
  const note = aiNotes[f.id];
  if (!f.summary && note) f.summary = note.summary;
}

/* ───────────────────────── 6. Que cambio ───────────────────────── */

const changes = changedRanges(BASE);
for (const [file, ch] of changes) {
  const f = graph.files[file];
  if (!f) continue;
  f.change = ch.status;
  for (const id of f.fns) {
    const fn = graph.fns[id];
    if (ch.status === "nuevo" || ch.ranges.some(([a, b]) => a <= fn.endLine && b >= fn.line)) {
      fn.change = ch.status === "nuevo" ? "nuevo" : "modificado";
    }
  }
}
graph.meta.changedFiles = [...changes.keys()].filter((f) => graph.files[f]);

/* ───────────────────────── Diagrama primero ───────────────────────── */

graph.plans = ONLY ? [] : loadPlans(P.plans, graph);

graph.meta.stats = {
  groups: Object.values(graph.groups).filter((g) => g.files.length).length,
  files: Object.keys(graph.files).length,
  fns: Object.keys(graph.fns).length,
  routes: graph.routes.length,
  warnings: Object.values(graph.fns).reduce((n, f) => n + f.warnings.length, 0),
};

/* ───────────────────────── 7. Salida ───────────────────────── */

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "graph.json"), JSON.stringify(graph, null, 1));
const template = fs.readFileSync(path.join(HERE, "viewer.html"), "utf8");
const data = JSON.stringify(graph).replace(/</g, "\\u003c");
const page = ONLY ? `archivo-${focus.replace(/[^\w.-]+/g, "_")}.html` : "codemap.html";
fs.writeFileSync(path.join(OUT, page), template.replace("/*__CODEMAP_DATA__*/null", () => data));

const s = graph.meta.stats;
console.log(
  `codemap: ${s.groups} grupos · ${s.files} archivos · ${s.fns} funciones · ${s.routes} rutas · ${s.warnings} avisos · ${graph.meta.changedFiles.length} archivos cambiados desde ${BASE}`,
);
console.log(`→ ${path.join(OUT, page)}`);
if (detected && !ONLY) console.log("(config detectada automáticamente: `codemap init` la guarda en .codemap/config.json para que puedas ajustarla)");
for (const p of graph.plans) {
  if (args.plan === p.id) console.log("\n" + formatPlan(p));
  else console.log(`plan ${p.id}: ${p.estado} · ${p.cumplimiento.ok}/${p.cumplimiento.total} pasos cumplidos${p.cumplimiento.extras ? ` · ${p.cumplimiento.extras} no previstos` : ""}`);
}

/* ───────────────────────── Python ───────────────────────── */

/**
 * El lado Python lo analiza `py_extract.py` con el `ast` de la libreria estandar y devuelve
 * archivos y funciones con la misma forma que las de TypeScript. Aqui solo se anaden al grafo.
 */
function mergePython() {
  const pyFiles = fileList.filter((f) => f.endsWith(".py"));
  if (!pyFiles.length) return;
  const [cmd, ...cmdArgs] = (cfg.python?.cmd ?? "python").split(" ");
  let out;
  try {
    const raw = execFileSync(cmd, [...cmdArgs, path.join(HERE, "py_extract.py")], {
      input: JSON.stringify({ root: ROOT, files: pyFiles, roots: cfg.python?.roots ?? [] }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    out = JSON.parse(raw);
  } catch (e) {
    console.warn(`codemap: no se pudo analizar Python (${cmd}): ${String(e.message).split("\n").slice(0, 3).join(" ")}`);
    return;
  }
  for (const f of Object.values(out.files)) {
    const group = groupOf(f.id);
    graph.groups[group].files.push(f.id);
    graph.files[f.id] = { ...f, group, summary: summarize(f.doc) };
  }
  for (const fn of Object.values(out.fns)) {
    graph.fns[fn.id] = { ...fn, summary: fn.summary ?? summarize(fn.doc), hash: hash(fn.code) };
    if (fn.kind === "route") graph.routes.push(fn.id);
  }
  for (const [name, ext] of Object.entries(out.externals)) {
    const e = (graph.externals[name] ??= { name, builtin: ext.builtin, usedBy: [] });
    e.usedBy.push(...ext.usedBy);
  }
}

/* ───────────────────────── Flujo interno de una funcion ───────────────────────── */

function buildFlow(fnNode, sf) {
  if (!fnNode?.body) return null;
  const nodes = [];
  const edges = [];
  const add = (kind, label, extra = {}) => {
    const id = `f${nodes.length}`;
    nodes.push({ id, kind, label, ...extra });
    return id;
  };
  const link = (preds, to) => preds.forEach((p) => edges.push({ from: p.id, to, label: p.label ?? null, dashed: !!p.dashed }));
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const params = fnNode.parameters?.map((p) => p.name.getText(sf)).join(", ") ?? "";
  const start = add("start", params ? `entrada: ${shortText(params, 50)}` : "inicio");

  if (!ts.isBlock(fnNode.body)) {
    const id = add("return", `devuelve ${shortText(fnNode.body.getText(sf), 60)}`, { calls: callsIn(fnNode.body), line: lineOf(fnNode.body) });
    link([{ id: start }], id);
    return { nodes, edges };
  }

  const exits = seq(fnNode.body.statements, [{ id: start }]);
  if (exits.length) link(exits, add("end", "fin"));
  return { nodes, edges };

  function seq(stmts, preds) {
    let cur = preds;
    let buffer = [];
    const flush = () => {
      if (!buffer.length) return;
      const id = add("action", buffer.map((b) => b.label).join("\n"), { line: buffer[0].line, calls: [] });
      link(cur, id);
      cur = [{ id }];
      buffer = [];
    };
    const own = (kind, label, n, extra = {}) => {
      flush();
      const id = add(kind, label, { line: lineOf(n), calls: callsIn(n), ...extra });
      link(cur, id);
      cur = [{ id }];
      return id;
    };

    for (const s of stmts) {
      if (!cur.length) break; // lo que sigue a un return es inalcanzable

      if (ts.isIfStatement(s)) {
        const d = own("decision", `¿${shortText(s.expression.getText(sf), 70)}?`, s.expression);
        const t = seq(blockOf(s.thenStatement), [{ id: d, label: "sí" }]);
        const e = s.elseStatement ? seq(blockOf(s.elseStatement), [{ id: d, label: "no" }]) : [{ id: d, label: "no" }];
        cur = [...t, ...e];
      } else if (ts.isReturnStatement(s)) {
        if (!s.expression) {
          flush();
          // `res.json(...); return;` — la respuesta ya es el final visible del camino
          const last = nodes.at(-1);
          if (!(last?.kind === "respond" && cur.some((c) => c.id === last.id))) link(cur, add("return", "return", { line: lineOf(s) }));
        } else {
          const r = responseLabel(s.expression, sf);
          own(r ? "respond" : "return", r ?? `devuelve ${shortText(s.expression.getText(sf), 60)}`, s);
        }
        cur = [];
      } else if (ts.isThrowStatement(s)) {
        own("throw", `lanza ${shortText(s.expression.getText(sf), 60)}`, s);
        cur = [];
      } else if (ts.isTryStatement(s)) {
        const t = own("try", "try", s.tryBlock, { calls: [] });
        const te = seq(s.tryBlock.statements, [{ id: t }]);
        let ce = [];
        if (s.catchClause) {
          const c = add("catch", `catch${s.catchClause.variableDeclaration ? ` (${s.catchClause.variableDeclaration.name.getText(sf)})` : ""}`, { line: lineOf(s.catchClause) });
          link([{ id: t, label: "error", dashed: true }], c);
          ce = seq(s.catchClause.block.statements, [{ id: c }]);
        }
        cur = [...te, ...ce];
        if (s.finallyBlock) cur = seq(s.finallyBlock.statements, cur.length ? cur : [{ id: t, label: "finally" }]);
      } else if (ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isForStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s)) {
        const l = own("loop", loopLabel(s, sf), s, { calls: [] });
        const be = seq(blockOf(s.statement), [{ id: l, label: "cada" }]);
        link(be.map((b) => ({ ...b, label: null, dashed: true })), l);
        cur = [{ id: l, label: "fin" }];
      } else if (ts.isSwitchStatement(s)) {
        const d = own("decision", `según ${shortText(s.expression.getText(sf), 50)}`, s.expression);
        const out = [];
        let fall = [];
        let hasDefault = false;
        for (const clause of s.caseBlock.clauses) {
          const lbl = ts.isDefaultClause(clause) ? "otro" : shortText(clause.expression.getText(sf), 30);
          hasDefault ||= ts.isDefaultClause(clause);
          const body = clause.statements.filter((x) => !ts.isBreakStatement(x));
          const ends = clause.statements.some((x) => ts.isBreakStatement(x) || ts.isReturnStatement(x) || ts.isThrowStatement(x));
          const ex = body.length ? seq(body, [{ id: d, label: lbl }, ...fall]) : [{ id: d, label: lbl }, ...fall];
          if (ends || clause === s.caseBlock.clauses.at(-1)) { out.push(...ex); fall = []; } else fall = ex;
        }
        if (!hasDefault) out.push({ id: d, label: "otro" });
        cur = out;
      } else if (ts.isBlock(s)) {
        flush();
        cur = seq(s.statements, cur);
      } else if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
        flush();
        return cur;
      } else {
        const r = ts.isExpressionStatement(s) ? responseLabel(s.expression, sf) : null;
        if (r) {
          own("respond", r, s);
          continue;
        }
        const calls = callsIn(s);
        const label = simpleLabel(s, sf);
        if (calls.length) {
          own("action", label, s, { calls });
        } else {
          buffer.push({ label, line: lineOf(s) });
          if (buffer.length === 3) flush();
        }
      }
    }
    flush();
    return cur;
  }

  function callsIn(n) {
    const out = new Set();
    const visit = (x) => {
      if (ts.isCallExpression(x) || ts.isNewExpression(x)) {
        const t = resolveFn(x.expression);
        if (t) out.add(t);
      } else if (ts.isJsxOpeningElement(x) || ts.isJsxSelfClosingElement(x)) {
        const t = resolveFn(x.tagName);
        if (t) out.add(t);
      }
      ts.forEachChild(x, visit);
    };
    visit(n);
    return [...out];
  }
}

function mwLabel(a, sf) {
  if (isFunctionLike(unwrap(a))) return "(función inline)";
  if (ts.isCallExpression(a)) {
    const argText = a.arguments.map((x) => x.getText(sf)).join(", ");
    return `${a.expression.getText(sf)}(${argText.length > 24 ? "…" : argText})`;
  }
  return shortText(a.getText(sf), 40);
}

/**
 * Mapa de un solo archivo: el archivo mas los archivos del proyecto que importa, hasta `depth`
 * niveles. Solo hacia afuera (lo que usa), no hacia adentro (quien lo usa): encontrar quien lo
 * importa obligaria a analizar el proyecto entero, que es justo lo que este modo evita.
 */
function neighborhood(start, depth) {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const f of frontier) {
      for (const dep of importsOf(f)) {
        if (!seen.has(dep)) { seen.add(dep); next.push(dep); }
      }
    }
    frontier = next;
  }
  return [...seen];
}

function importsOf(file) {
  const abs = path.join(ROOT, file);
  const text = fs.readFileSync(abs, "utf8");
  const found = [];
  const keep = (absTarget) => {
    if (!absTarget) return;
    const r = rel(absTarget);
    if (!r.startsWith("..") && !r.includes("node_modules/") && isSource(r, cfg) && fs.existsSync(absTarget)) found.push(r);
  };
  if (TS_FILE.test(file)) {
    for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
      keep(ts.resolveModuleName(imp.fileName, abs, options, ts.sys).resolvedModule?.resolvedFileName);
    }
  } else if (file.endsWith(".py")) {
    // Paquete del archivo: se sube mientras haya __init__.py
    let pkgDir = path.dirname(abs);
    while (fs.existsSync(path.join(path.dirname(pkgDir), "__init__.py"))) pkgDir = path.dirname(pkgDir);
    const pyRoots = [path.dirname(pkgDir), ...(cfg.python?.roots ?? []).map((r) => path.join(ROOT, r))];
    const asModule = (base, dotted) => {
      const p = path.join(base, ...dotted.split("."));
      return [p + ".py", path.join(p, "__init__.py")].find((x) => fs.existsSync(x));
    };
    // Los nombres importados: hasta el final de la linea, o entre parentesis si ocupan varias
    const re = /^[ \t]*(?:from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)|import[ \t]+([\w.]+))/gm;
    for (const m of text.matchAll(re)) {
      if (m[4]) {
        for (const r of pyRoots) keep(asModule(r, m[4]));
        continue;
      }
      const dots = m[1].length;
      let base = null;
      if (dots) {
        base = path.dirname(abs);
        for (let i = 1; i < dots; i++) base = path.dirname(base);
      }
      const names = m[3].replace(/[()\\]/g, "").split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
      for (const r of base ? [base] : pyRoots) {
        const mod = m[2] ? asModule(r, m[2]) : null;
        if (mod && !mod.endsWith("__init__.py")) keep(mod);
        else for (const n of names) keep(asModule(m[2] ? path.join(r, ...m[2].split(".")) : r, n)); // from . import modulo
      }
    }
  }
  return [...new Set(found)];
}

function blockOf(s) {
  return ts.isBlock(s) ? s.statements : [s];
}

function loopLabel(s, sf) {
  if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
    return `para cada ${shortText(s.initializer.getText(sf).replace(/^(const|let|var)\s+/, ""), 30)} de ${shortText(s.expression.getText(sf), 40)}`;
  }
  if (ts.isWhileStatement(s) || ts.isDoStatement(s)) return `mientras ${shortText(s.expression.getText(sf), 50)}`;
  return `repetir: ${shortText(s.getText(sf).split("{")[0].replace(/^for\s*/, ""), 50)}`;
}

function simpleLabel(s, sf) {
  if (ts.isVariableStatement(s)) {
    return s.declarationList.declarations
      .map((d) => {
        const name = shortText(d.name.getText(sf).replace(/\s+/g, " "), 40);
        if (!d.initializer) return name;
        let init = unwrap(d.initializer);
        const awaited = ts.isAwaitExpression(init);
        if (awaited) init = unwrap(init.expression);
        if (isFunctionLike(init)) return `define ${name}()`;
        if (ts.isCallExpression(init) || ts.isNewExpression(init)) {
          return `${name} ← ${awaited ? "await " : ""}${shortText(init.expression.getText(sf), 40)}()`;
        }
        return `${name} = ${shortText(init.getText(sf), 45)}`;
      })
      .join("; ");
  }
  if (ts.isExpressionStatement(s)) {
    let e = s.expression;
    const awaited = ts.isAwaitExpression(e);
    if (awaited) e = e.expression;
    if (ts.isCallExpression(e)) return `${awaited ? "await " : ""}${shortText(e.expression.getText(sf), 50)}()`;
  }
  return shortText(s.getText(sf), 60);
}

/** Traduce `res.status(400).json({ error: "…" })` a algo que se lee sin saber Express. */
function responseLabel(expr, sf) {
  const text = expr.getText(sf).replace(/\s+/g, " ");
  const m = /^(?:await )?res\s*(?:\.status\((\d+)\))?\s*\.(json|send|sendFile|redirect|end|sendStatus|type\([^)]*\)\s*\.send)\b/.exec(text);
  if (!m) return null;
  const code = m[1] ?? (m[2] === "redirect" ? "302" : "200");
  const how = { json: "JSON", send: "", sendFile: "archivo", redirect: "redirige", end: "", sendStatus: "" }[m[2]] ?? "";
  const err = /error:\s*("[^"]{1,60}"|'[^']{1,60}'|`[^`]{1,60}`)/.exec(text);
  return `responde ${code}${how ? ` · ${how}` : ""}${err ? ` · ${err[1]}` : ""}`;
}

function hasUnguardedAwait(fnNode) {
  let found = false;
  const visit = (n, inTry) => {
    if (found) return;
    if (n !== fnNode && isFunctionLike(n)) return; // un await dentro de un callback es otro asunto
    if (ts.isTryStatement(n)) {
      visit(n.tryBlock, true);
      if (n.catchClause) visit(n.catchClause, inTry);
      if (n.finallyBlock) visit(n.finallyBlock, inTry);
      return;
    }
    if (ts.isAwaitExpression(n) && !inTry) {
      found = true;
      return;
    }
    ts.forEachChild(n, (c) => visit(c, inTry));
  };
  visit(fnNode.body ?? fnNode, false);
  return found;
}

/* ───────────────────────── Utilidades ───────────────────────── */

function resolveFn(expr) {
  if (!expr) return null;
  const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  let sym;
  try {
    sym = checker.getSymbolAtLocation(target);
  } catch {
    return null;
  }
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  for (const d of sym?.declarations ?? []) {
    if (declToFn.has(d)) return declToFn.get(d);
  }
  return null;
}

function keyOfExpr(expr) {
  if (!expr || !(ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr))) return null;
  let sym;
  try {
    sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  } catch {
    return null;
  }
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym?.declarations?.[0];
  if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) return `${rel(d.getSourceFile().fileName)}::${d.name.text}`;
  return null;
}

function urlPattern(arg, sf) {
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (!ts.isTemplateExpression(arg)) return null;
  let out = arg.head.text;
  arg.templateSpans.forEach((span, i) => {
    const lit = span.literal.text;
    // `${BACKEND}/api/...` — la base del backend al principio no forma parte de la ruta
    out += i === 0 && out === "" && lit.startsWith("/") ? "" : ":p";
    out += lit;
  });
  return out.split("?")[0];
}

function routeRegex(p) {
  return new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]\w*(\\\.[a-z]+)?/g, (_, ext) => `[^/]+${ext ?? ""}`) + "/?$");
}

function joinPath(a, b) {
  const j = `${a}/${b}`.replace(/\/+/g, "/");
  return j.length > 1 ? j.replace(/\/$/, "") : j;
}

function fileDocOf(sf) {
  const ranges = ts.getLeadingCommentRanges(sf.text, 0) ?? [];
  const r = ranges.find((c) => sf.text.startsWith("/**", c.pos));
  return r ? cleanDoc(sf.text.slice(r.pos, r.end)) : null;
}

function docOf(node, sf) {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const r = ranges.filter((c) => sf.text.startsWith("/**", c.pos)).at(-1);
  if (!r) return null;
  if (r.pos === 0 && fileDocOf(sf)) {
    // El comentario de cabecera del archivo no describe la primera funcion.
    const after = ranges.filter((c) => c.pos > 0 && sf.text.startsWith("/**", c.pos)).at(-1);
    return after ? cleanDoc(sf.text.slice(after.pos, after.end)) : null;
  }
  return cleanDoc(sf.text.slice(r.pos, r.end));
}

function cleanDoc(raw) {
  return raw
    .replace(/^\/\*\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

function summarize(doc) {
  if (!doc) return null;
  const paras = doc.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const p = paras.find((x) => !/^(GET|POST|PUT|PATCH|DELETE|ALL)\s+\//.test(x) && !x.startsWith("@")) ?? paras[0];
  if (!p) return null;
  const plain = p.replace(/\*\*/g, "").replace(/`/g, "");
  return plain.length > 220 ? plain.slice(0, 217).replace(/\s\S*$/, "") + "…" : plain;
}

function changedRanges(base) {
  const out = new Map();
  let diff = "";
  let untracked = "";
  try {
    // --relative: rutas relativas a ROOT aunque el proyecto sea una subcarpeta del repo
    diff = git(["diff", "--relative", "-U0", "--no-color", "--no-ext-diff", base, "--", ...cfg.include]);
    untracked = git(["ls-files", "-o", "--exclude-standard"]);
  } catch (e) {
    // Sin git (o sin commits todavia) el mapa sale igual, solo sin resaltar cambios
    console.warn(`codemap: sin comparación de cambios (${e.message.split("\n")[0]})`);
  }
  let cur = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = { status: "modificado", ranges: [] };
      out.set(m[1], cur);
    } else if (line.startsWith("new file mode") && cur) {
      cur.status = "nuevo";
    } else if (line.startsWith("@@") && cur) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      cur.ranges.push([start, start + Math.max(len, 1) - 1]);
    }
  }
  for (const f of untracked.split("\n").filter(Boolean)) {
    if (fileSet.has(f)) out.set(f, { status: "nuevo", ranges: [] });
  }
  return out;
}

function unwrap(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
}

function isFunctionLike(n) {
  return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n));
}

function isExported(n) {
  return !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function shortText(t, max) {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function warn(rule, msg) {
  return { rule, msg };
}

function hash(t) {
  return crypto.createHash("sha1").update(t).digest("hex").slice(0, 10);
}

function git(argv) {
  return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}
