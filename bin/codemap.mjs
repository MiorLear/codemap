#!/usr/bin/env node
/**
 * codemap — mapa navegable del codigo para revisar lo que escribe un agente.
 *
 *   codemap init                  guarda en .codemap/config.json la config detectada, para ajustarla
 *   codemap build [--base main]   genera el mapa del proyecto (.codemap/out/codemap.html)
 *   codemap file <ruta> [--depth 1]   mapa de un solo archivo y lo que importa
 *   codemap serve [--port 4321]   sirve el mapa; recarga sola y guarda la revision de planes
 *   codemap check <plan>          compara el codigo con un plan de "diagrama primero"
 *   codemap claude                instala el hook y el skill de Claude Code en el proyecto
 *   codemap hook                  (lo llama Claude Code; no hace falta usarlo a mano)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const TOOL = path.resolve(path.dirname(SELF), "..");
const SRC = path.join(TOOL, "src");
const [cmd = "help", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const project = path.resolve(flags.project ?? process.cwd());

const { findRoot, paths, detectConfig, loadConfig } = await import(pathToUrl(path.join(SRC, "project.mjs")));

switch (cmd) {
  case "init": {
    // Con --project se respeta la carpeta tal cual (un subproyecto de un monorepo)
    const root = flags.project ? project : findRoot(project);
    const P = paths(root);
    if (fs.existsSync(P.config) && !flags.force) {
      console.log(`Ya existe ${rel(P.config)}. Usa --force para regenerarla.`);
      break;
    }
    const cfg = detectConfig(root);
    fs.mkdirSync(P.plans, { recursive: true });
    fs.writeFileSync(P.config, JSON.stringify(cfg, null, 2) + "\n");
    fs.writeFileSync(path.join(P.cm, ".gitignore"), "out/\n");
    console.log(`Creado ${rel(P.config)}`);
    console.log(`  ${cfg.include.length} carpetas · ${cfg.groups.length} grupos · ${cfg.extensions.join(" ")}`);
    if (cfg.python.roots.length) console.log(`  Python desde: ${cfg.python.roots.join(", ")}`);
    if (Object.keys(cfg.paths).length) console.log(`  Alias: ${Object.keys(cfg.paths).join(", ")}`);
    console.log("\nLos grupos se llaman como sus carpetas: ponles nombre de negocio en config.json");
    console.log("(o pídeselo a Claude). Luego: codemap build && codemap serve");
    break;
  }

  case "build":
  case "check": {
    const args = ["--project", project];
    if (cmd === "check") {
      if (!rest[0] || rest[0].startsWith("--")) fail("Uso: codemap check <id-del-plan>");
      args.push("--plan", rest[0]);
    }
    for (const k of ["base", "config", "out"]) if (flags[k]) args.push(`--${k}`, flags[k]);
    run(path.join(SRC, "build.mjs"), args);
    break;
  }

  case "file": {
    const target = rest.find((x) => !x.startsWith("--"));
    if (!target) fail("Uso: codemap file <ruta/al/archivo> [--depth 1]");
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) fail(`No existe ${target}`);
    const args = ["--only", abs, "--depth", String(flags.depth ?? 1)];
    if (flags.project) args.push("--project", project);
    const r = run(path.join(SRC, "build.mjs"), args, { capture: true });
    process.stdout.write(r);
    const page = /→ (.+\.html)/.exec(r)?.[1];
    if (page) {
      console.log(`\nCon \`codemap serve\` abierto: http://localhost:${flags.port ?? 4321}/${path.basename(page)}`);
      console.log(`O ábrelo directo (sin recarga ni revisión de planes): ${page}`);
      if (flags.open) openInBrowser(page);
    }
    break;
  }

  case "serve": {
    const { serve } = await import(pathToUrl(path.join(SRC, "serve.mjs")));
    const root = findRoot(project);
    if (!fs.existsSync(path.join(paths(root).out, "codemap.html"))) run(path.join(SRC, "build.mjs"), ["--project", root]);
    const { url } = await serve({ project: root, port: Number(flags.port ?? 4321) }).catch((e) =>
      fail(e.code === "EADDRINUSE" ? `El puerto ${flags.port ?? 4321} está ocupado (¿ya hay un codemap serve?). Prueba --port ${Number(flags.port ?? 4321) + 1}.` : e.message),
    );
    console.log(`codemap en ${url}  ·  Ctrl+C para cerrar`);
    if (flags.open) openInBrowser(url);
    break;
  }

  case "hook": {
    const { trigger } = await import(pathToUrl(path.join(SRC, "hook.mjs")));
    await trigger(process.env.CLAUDE_PROJECT_DIR ?? project).catch(() => {});
    break;
  }

  case "claude": {
    installClaude(findRoot(project));
    break;
  }

  case "help":
  case "--help":
  case "-h":
    console.log(fs.readFileSync(SELF, "utf8").split("*/")[0].split("\n").slice(2).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    break;

  default:
    fail(`Comando desconocido: ${cmd}. Usa \`codemap help\`.`);
}

/* ───────── Claude Code: hook + skill ───────── */

function installClaude(root) {
  const settingsFile = path.join(root, ".claude", flags.shared ? "settings.json" : "settings.local.json");
  const command = `node "${SELF.split(path.sep).join("/")}" hook`;
  if (/[\\/]_npx[\\/]/.test(SELF)) {
    console.warn("Aviso: estás usando codemap desde la caché de npx; el hook apuntaría a una ruta temporal.");
    console.warn("Instálalo antes: npm install -g github:<usuario>/codemap   (o como devDependency del proyecto)\n");
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  settings.hooks ??= {};
  const add = (event, matcher) => {
    const list = (settings.hooks[event] ??= []);
    const already = list.some((e) => e.hooks?.some((h) => /codemap(\.mjs)?["']?\s+hook/.test(h.command ?? "")));
    if (already) return false;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 15 }] });
    return true;
  };
  const a = add("PostToolUse", "Edit|Write|MultiEdit|NotebookEdit");
  const b = add("Stop");
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  console.log(`${a || b ? "Hook instalado en" : "El hook ya estaba en"} ${rel(settingsFile)}`);

  const skillDir = path.join(root, ".claude", "skills", "codemap-diagrama-primero");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(path.join(TOOL, "templates", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  console.log(`Skill "diagrama primero" en ${rel(skillDir)}`);
  console.log("\nAbre una sesión nueva de Claude Code en el proyecto para que cargue ambos.");
  if (!flags.shared) console.log("(Con --shared se instala en .claude/settings.json, para todo el equipo.)");
}

/* ───────── utilidades ───────── */

function run(script, args, { capture = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout;
}

function openInBrowser(target) {
  const [c, ...a] = process.platform === "win32" ? ["cmd", "/c", "start", ""] : process.platform === "darwin" ? ["open"] : ["xdg-open"];
  spawn(c, [...a, target], { detached: true, stdio: "ignore" }).unref();
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function rel(p) {
  return path.relative(process.cwd(), p) || ".";
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function pathToUrl(p) {
  return new URL("file:///" + p.split(path.sep).join("/").replace(/^\/+/, "")).href;
}
