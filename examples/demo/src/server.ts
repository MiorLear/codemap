/**
 * Servidor de la API de la tienda.
 *
 * Todo lo que cuelga de /api pide la clave de API antes de llegar a los routers.
 */
import express from "express";
import { requiereClave } from "./middleware/auth.js";
import { pedidosRouter } from "./pedidos/routes.js";

const app = express();
app.use(express.json());

app.get("/salud", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", requiereClave, pedidosRouter);

app.listen(3000);
