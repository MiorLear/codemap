/**
 * Donde vive cada cosa de un proyecto y como se configura codemap para el.
 *
 *   <proyecto>/.codemap/config.json   configuracion (la crea `codemap init`; si falta, se detecta)
 *   <proyecto>/.codemap/plans/        planes de "diagrama primero"
 *   <proyecto>/.codemap/out/          mapa generado (no va al repo)
 *
 * La deteccion automatica no intenta adivinar el significado de negocio: agrupa por carpetas y
 * deja los nombres tal cual. Ponerles nombre ("Módulo · Pedidos") es trabajo para una persona o
 * para el agente, editando config.json.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
export const DEFAULT_EXCLUDE = [
  "node_modules/", "/dist/", "/build/", "/.next/", "/coverage/", "/out/", "/vendor/",
  "__pycache__/", "/.venv/", "/venv/", ".min.js", ".d.ts",
  ".test.", ".spec.", "/test_", "/test/", "/tests/", "/__tests__/",
];
const MAX_GROUPS = 24;
const SPLIT_ABOVE = 10; // un grupo con mas archivos que esto se parte en sus subcarpetas

/**
 * Raiz del proyecto: la carpeta mas cercana (subiendo desde `dir`) que ya tenga `.codemap/`; si no
 * hay ninguna, la raiz del repo git; si no hay git, `dir`. Asi un proyecto que vive en una
 * subcarpeta de un monorepo puede tener su propio mapa.
 */
export function findRoot(dir) {
  const start = path.resolve(dir);
  let gitRoot = null;
  try {
    gitRoot = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {}
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".codemap"))) return d;
    if (d === gitRoot || path.dirname(d) === d) break;
  }
  return gitRoot ?? start;
}

export function paths(root) {
  const cm = path.join(root, ".codemap");
  return { root, cm, config: path.join(cm, "config.json"), plans: path.join(cm, "plans"), out: path.join(cm, "out"), notes: path.join(cm, "ai-notes.json") };
}

/** Lee la config del proyecto o la detecta. Devuelve { cfg, root, detected }. */
export function loadConfig({ project, config }) {
  const root = findRoot(project ?? process.cwd());
  const file = config ? path.resolve(config) : paths(root).config;
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    // `root` en la config es relativo a la carpeta del archivo (por defecto, el padre de .codemap)
    const cfgRoot = cfg.root ? path.resolve(path.dirname(file), cfg.root) : root;
    return { cfg: withDefaults(cfg), root: cfgRoot, detected: false };
  }
  return { cfg: detectConfig(root), root, detected: true };
}

function withDefaults(cfg) {
  return {
    base: "HEAD",
    exclude: DEFAULT_EXCLUDE,
    extensions: SOURCE_EXT,
    paths: {},
    fileAliases: {},
    groups: [],
    layers: [],
    rules: { longFunctionLines: 80, express4AsyncErrors: false },
    python: { cmd: defaultPython(), roots: [] },
    ...cfg,
  };
}

/** Todos los archivos del proyecto que git conoce (o, sin git, un recorrido del disco). */
export function listFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || ["node_modules", "__pycache__", "dist", "build", "venv"].includes(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    walk(root, "");
    return files;
  }
}

export function isSource(f, cfg) {
  const p = "/" + f;
  // Carpetas ocultas (.codemap, .github, .claude...) nunca son codigo del producto
  if (f.split("/").slice(0, -1).some((seg) => seg.startsWith("."))) return false;
  return cfg.extensions.some((e) => f.endsWith(e)) && !cfg.exclude.some((x) => p.includes(x.startsWith("/") || x.startsWith(".") ? x : "/" + x));
}

/** Config razonable para un proyecto que nunca se configuro. */
export function detectConfig(root) {
  const base = withDefaults({});
  const files = listFiles(root).filter((f) => isSource(f, base) && fs.existsSync(path.join(root, f)));
  const exts = SOURCE_EXT.filter((e) => files.some((f) => f.endsWith(e)));
  const name = readJson(path.join(root, "package.json"))?.name ?? path.basename(root);

  // Que se incluye: las carpetas de primer nivel con codigo, y los archivos sueltos de la raiz
  const top = [...new Set(files.map((f) => (f.includes("/") ? f.split("/")[0] + "/" : f)))].sort();

  const prefixes = adaptiveGroups(files);
  // La capa es la carpeta de primer nivel; los archivos sueltos de la raiz van a "raíz"
  const layerOf = (p) => (p === "./" ? "raíz" : p.split("/")[0]);
  const layers = [...new Set(prefixes.map(layerOf))].map((id) => ({ id, name: id }));
  const groups = prefixes.map((p) => ({ id: p, prefix: p === "./" ? "" : p, name: p === "./" ? "raíz" : p.replace(/\/$/, ""), layer: layerOf(p) }));

  return withDefaults({
    name,
    root: "..",
    include: top,
    extensions: exts.length ? exts : SOURCE_EXT,
    paths: detectTsPaths(root, files),
    groups,
    layers,
    rules: { longFunctionLines: 80, express4AsyncErrors: usesExpress4(root) },
    python: { cmd: defaultPython(), roots: detectPythonRoots(root, files) },
  });
}

/**
 * Grupos por carpeta, con la profundidad que pida cada zona: se empieza por las carpetas de
 * primer nivel y se parte el grupo mas grande en sus subcarpetas mientras tenga mas de
 * SPLIT_ABOVE archivos y no se pase de MAX_GROUPS. Asi `src/modules/` (46 archivos) acaba en un
 * grupo por modulo y `src/config/` (1 archivo) se queda como esta. Las carpetas que solo
 * contienen otra carpeta se atraviesan (`web-app/src/app/cards/` no se queda en `web-app/`).
 */
function adaptiveGroups(files) {
  const dirOf = (f) => f.split("/").slice(0, -1).join("/");
  const childOf = (prefix, f) => {
    const rest = dirOf(f).slice(prefix.length).split("/").filter(Boolean);
    return rest.length ? prefix + rest[0] + "/" : null; // null: archivo directo en el prefijo
  };
  const under = (prefix) => files.filter((f) => (prefix ? f.startsWith(prefix) : !f.includes("/")));
  // Bajar mientras la carpeta tenga una sola subcarpeta y ningun archivo propio
  const collapse = (prefix) => {
    for (;;) {
      const kids = new Set(under(prefix).map((f) => childOf(prefix, f)));
      if (kids.size !== 1 || kids.has(null)) return prefix;
      prefix = [...kids][0];
    }
  };

  let groups = [...new Set(files.map((f) => (f.includes("/") ? f.split("/")[0] + "/" : "")))].map((p) => (p ? collapse(p) : p));
  // Los archivos de un grupo son los que no tienen un grupo mas especifico
  const own = (p) => under(p).filter((f) => !groups.some((q) => q !== p && q.length > p.length && q.startsWith(p) && f.startsWith(q)));
  for (;;) {
    const candidates = groups
      .filter((p) => p)
      .map((p) => {
        const ms = own(p);
        return { p, n: ms.length, kids: new Set(ms.map((f) => childOf(p, f))) };
      })
      .filter((g) => g.n > SPLIT_ABOVE && [...g.kids].filter(Boolean).length >= 1 && g.kids.size >= 2)
      .sort((a, b) => b.n - a.n);
    const next = candidates[0];
    if (!next || groups.length - 1 + next.kids.size > MAX_GROUPS) break;
    groups = groups.filter((p) => p !== next.p);
    for (const k of next.kids) groups.push(k ? collapse(k) : next.p); // los archivos directos se quedan en el padre
  }
  // Un grupo es un prefijo; los archivos sueltos de la raiz van al grupo "raíz"
  return [...new Set(groups)].sort().map((p) => p || "./");
}

/** Alias de TypeScript: los `paths` del tsconfig raiz y los paquetes del monorepo. */
function detectTsPaths(root, files) {
  const out = {};
  const tsconfig = readJson(path.join(root, "tsconfig.json"), true);
  const p = tsconfig?.compilerOptions?.paths;
  if (p) {
    const baseUrl = tsconfig.compilerOptions.baseUrl ?? ".";
    for (const [k, v] of Object.entries(p)) out[k] = v.map((x) => path.posix.join(baseUrl, x));
  }
  // Paquetes de un monorepo: "@acme/contracts" -> packages/contracts/src/index.ts
  for (const pkgFile of listFiles(root).filter((f) => f.endsWith("package.json") && !f.includes("node_modules/"))) {
    const pkg = readJson(path.join(root, pkgFile));
    if (!pkg?.name || pkgFile === "package.json") continue;
    const dir = path.posix.dirname(pkgFile);
    const entry = ["src/index.ts", "src/index.tsx", "index.ts", "src/index.js", "index.js"].map((e) => `${dir}/${e}`).find((e) => files.includes(e));
    if (entry && !out[pkg.name]) out[pkg.name] = [entry];
  }
  return out;
}

/** Carpetas desde las que se importan los paquetes de Python (el padre del paquete de arriba). */
function detectPythonRoots(root, files) {
  const inits = new Set(files.filter((f) => f.endsWith("__init__.py")).map((f) => path.posix.dirname(f)));
  const roots = new Set();
  for (const pkg of inits) {
    const parent = path.posix.dirname(pkg);
    if (!inits.has(parent)) roots.add(parent === "." ? "." : parent);
  }
  // Scripts sueltos (sin paquete): su propia carpeta
  for (const f of files.filter((x) => x.endsWith(".py"))) {
    const dir = path.posix.dirname(f);
    if (![...roots].some((r) => r === "." || dir === r || dir.startsWith(r + "/"))) roots.add(dir);
  }
  return [...roots].sort();
}

/** Express 4 no captura las promesas rechazadas de un handler async (Express 5 si). */
function usesExpress4(root) {
  for (const f of listFiles(root).filter((x) => x.endsWith("package.json") && !x.includes("node_modules/"))) {
    const v = (readJson(path.join(root, f)) ?? {}).dependencies?.express;
    if (v && /(^|[^\d])4(\.|$|\s|x)/.test(v)) return true;
  }
  return false;
}

export function defaultPython() {
  for (const cmd of process.platform === "win32" ? ["python", "py -3"] : ["python3", "python"]) {
    const [c, ...a] = cmd.split(" ");
    try {
      execFileSync(c, [...a, "--version"], { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  return "python";
}

function readJson(file, lenient = false) {
  try {
    let text = fs.readFileSync(file, "utf8");
    // tsconfig admite comentarios y comas finales
    if (lenient) text = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
