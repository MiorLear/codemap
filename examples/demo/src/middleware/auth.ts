/**
 * Clave de API para las rutas de /api.
 */
import type { Request, Response, NextFunction } from "express";

/** Rechaza la petición si no trae la cabecera x-api-key correcta. */
export function requiereClave(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-api-key") !== process.env.API_KEY) {
    res.status(401).json({ error: "Clave de API no válida." });
    return;
  }
  next();
}
