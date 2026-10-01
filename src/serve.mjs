/**
 * codemap serve — sirve el mapa de un proyecto en local.
 *
 * - `GET /version?f=<pagina>` dice cuando se genero esa pagina; el visor lo consulta y se recarga solo.
 * - `POST /api/plans/<id>` guarda en `.codemap/plans/<id>.json` lo que la persona decide en el visor
 *   (aprobar, pedir cambios, comentar un paso) y regenera el mapa. Es el unico camino por el que la
 *   revision humana llega al archivo que el agente lee antes de implementar.
 *
 * Solo escucha en 127.0.0.1: nadie de la red puede aprobar planes.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLAN_STATES } from "./plans.mjs";
import { findRoot, paths } from "./project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function serve({ project = process.cwd(), port = 4321 } = {}) {
  const root = findRoot(project);
  const { out: OUT, plans: PLANS } = paths(root);
  const types = { ".html": "text/html; charset=utf-8", ".json": "application/json" };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "codemap.html";

    if (name === "version") {
      const page = path.basename(url.searchParams.get("f") || "codemap.html");
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(OUT, page)).mtimeMs;
      } catch {}
      return json(res, 200, { mtime });
    }

    const planMatch = /^api\/plans\/([a-z0-9-]+)$/.exec(name);
    if (planMatch && req.method === "POST") {
      try {
        const file = path.join(PLANS, `${planMatch[1]}.json`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "No existe ese plan." });
        const body = JSON.parse(await readBody(req));
        const plan = JSON.parse(fs.readFileSync(file, "utf8"));
        const at = new Date().toISOString();
        if (body.estado) {
          if (!PLAN_STATES.includes(body.estado)) return json(res, 400, { error: "Estado no valido." });
          plan.estado = body.estado;
          (plan.historial ??= []).push({ estado: body.estado, fecha: at, por: "revisión" });
        }
        if (body.comentario?.texto?.trim()) {
          (plan.revision ??= []).push({
            paso: body.comentario.paso ?? null,
            pasoTexto: body.comentario.pasoTexto ?? null,
            texto: body.comentario.texto.trim().slice(0, 2000),
            fecha: at,
          });
        }
        if (typeof body.quitar === "string") plan.revision = (plan.revision ?? []).filter((r) => r.fecha !== body.quitar);
        fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
        await rebuild(root);
        return json(res, 200, { ok: true, estado: plan.estado });
      } catch (e) {
        return json(res, 500, { error: String(e.message ?? e) });
      }
    }

    const file = path.join(OUT, path.normalize(name));
    if (!file.startsWith(OUT) || !fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end(fs.existsSync(OUT) ? "No encontrado." : "Aún no hay mapa: ejecuta `codemap build` en el proyecto.");
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://localhost:${port}`, root }));
  });
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error("Cuerpo demasiado grande."));
    });
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}

function rebuild(root) {
  return new Promise((resolve) => execFile(process.execPath, [path.join(HERE, "build.mjs"), "--project", root], { cwd: root }, () => resolve()));
}
