/**
 * codemap hook — lo llama Claude Code (PostToolUse y Stop) para regenerar el mapa cuando cambia
 * el codigo. Nunca bloquea al agente: decide rapido si hace falta y, si hace falta, regenera en
 * segundo plano y sale.
 *
 * Dos filtros para no regenerar de mas:
 *  1. Si la herramienta toco un archivo, solo cuenta si es codigo que el mapa incluye o algo de
 *     `.codemap/` (config, planes).
 *  2. Huella del arbol: HEAD + `git status` + diff de las carpetas incluidas + planes y config.
 *     Si no cambio desde la ultima regeneracion, no se hace nada.
 *
 * Y un rebote: varias ediciones seguidas dejan una sola regeneracion, la ultima.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, paths, isSource, listFiles } from "./project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEBOUNCE_MS = 1500;

/** Entrada del hook: lee el JSON de Claude Code por stdin y, si toca, lanza la regeneracion. */
export async function trigger(project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
  const input = await readStdin();
  const { cfg, root } = loadConfig({ project });
  const P = paths(root);
  const STATE = path.join(P.out, ".hook-state.json");

  const touched = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (touched) {
    const rel = path.relative(root, path.resolve(touched)).split(path.sep).join("/");
    const relevant =
      (cfg.include.some((p) => rel.startsWith(p)) && isSource(rel, cfg)) ||
      (rel.startsWith(".codemap/") && !rel.startsWith(".codemap/out/"));
    if (!relevant) return;
  }

  const print = fingerprint(root, cfg);
  const state = readJson(STATE, {});
  if (state.built === print) return;

  // Se apunta la peticion y se lanza el trabajador desprendido; si llega otra antes de que
  // venza el rebote, la anterior ve que ya no es la ultima y se retira.
  const ticket = `${Date.now()}-${process.pid}`;
  fs.mkdirSync(P.out, { recursive: true });
  writeJson(STATE, { ...state, pending: ticket, pendingPrint: print });
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--run", ticket, root], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

async function runDebounced(ticket, root) {
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
  const P = paths(root);
  const STATE = path.join(P.out, ".hook-state.json");
  const state = readJson(STATE, {});
  if (state.pending !== ticket) return;
  const log = fs.openSync(path.join(P.out, "hook.log"), "w");
  try {
    execFileSync(process.execPath, [path.join(HERE, "build.mjs"), "--project", root], { cwd: root, stdio: ["ignore", log, log] });
    writeJson(STATE, { ...readJson(STATE, {}), built: state.pendingPrint, builtAt: new Date().toISOString(), error: null });
  } catch (e) {
    writeJson(STATE, { ...readJson(STATE, {}), error: String(e.message).split("\n")[0], failedAt: new Date().toISOString() });
  } finally {
    fs.closeSync(log);
  }
}

function fingerprint(root, cfg) {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const h = crypto.createHash("sha1");
  const mtime = (abs) => {
    try {
      return String(fs.statSync(abs).mtimeMs);
    } catch {
      return "-";
    }
  };
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  if (isRepo) {
    h.update(git(["rev-parse", "HEAD"]));
    h.update(git(["status", "--porcelain", "--", ...cfg.include]));
    h.update(git(["diff", "HEAD", "--", ...cfg.include]));
  } else {
    // Sin git no hay diff: la huella son las fechas de modificacion del codigo incluido
    for (const f of listFiles(root).filter((x) => cfg.include.some((p) => x.startsWith(p)) && isSource(x, cfg))) {
      h.update(f + mtime(path.join(root, f)));
    }
  }
  // Archivos nuevos (sin seguimiento): el diff no los ve
  for (const f of git(["ls-files", "-o", "--exclude-standard", "--", ...cfg.include]).split("\n").filter(Boolean)) {
    h.update(f + mtime(path.join(root, f)));
  }
  // Config, planes y el propio codemap: cambiarlos tambien obliga a regenerar
  const P = paths(root);
  let plans = [];
  try {
    plans = fs.readdirSync(P.plans).map((f) => path.join(P.plans, f));
  } catch {}
  for (const f of [P.config, P.notes, ...plans, ...["build.mjs", "plans.mjs", "py_extract.py", "viewer.html", "project.mjs"].map((x) => path.join(HERE, x))]) {
    h.update(f + mtime(f));
  }
  return h.digest("hex");
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 1));
}

// Trabajador desprendido: node hook.mjs --run <ticket> <root>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--run") {
  await runDebounced(process.argv[3], process.argv[4]);
}
