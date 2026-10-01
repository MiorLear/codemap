/**
 * Rutas de pedidos.
 */
import { Router } from "express";
import { cargarPedido, resumen, crearPedido } from "./servicio.js";

export const pedidosRouter = Router();

/**
 * GET /api/pedidos/:id
 *
 * Devuelve el resumen de un pedido con su total calculado.
 */
pedidosRouter.get("/pedidos/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: "Identificador no válido." });
    return;
  }
  const pedido = await cargarPedido(id);
  if (!pedido) {
    res.status(404).json({ error: "No existe ese pedido." });
    return;
  }
  res.json(resumen(pedido));
});

/**
 * POST /api/pedidos
 *
 * Crea un pedido a partir de sus líneas.
 */
pedidosRouter.post("/pedidos", async (req, res) => {
  const lineas = req.body?.lineas;
  if (!Array.isArray(lineas) || lineas.length === 0) {
    res.status(400).json({ error: "El pedido no tiene líneas." });
    return;
  }
  try {
    const pedido = await crearPedido(lineas);
    res.status(201).json(resumen(pedido));
  } catch (e) {
    res.status(502).json({ error: "No se pudo guardar el pedido." });
  }
});
