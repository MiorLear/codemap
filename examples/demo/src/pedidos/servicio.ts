/**
 * Lógica de pedidos: carga, totales y alta.
 */
import { buscar, guardar } from "../db.js";

export interface Linea { producto: string; cantidad: number; precio: number }
export interface Pedido { id: string; lineas: Linea[] }

/** Lee un pedido del inventario; null si no existe. */
export async function cargarPedido(id: string): Promise<Pedido | null> {
  return buscar("pedidos", id);
}

/** Total y número de artículos de un pedido. */
export function resumen(pedido: Pedido) {
  let total = 0;
  let articulos = 0;
  for (const linea of pedido.lineas) {
    total += linea.cantidad * linea.precio;
    articulos += linea.cantidad;
  }
  return { id: pedido.id, total, articulos };
}

/** Guarda un pedido nuevo y lo devuelve con su id. */
export async function crearPedido(lineas: Linea[]): Promise<Pedido> {
  const id = await guardar("pedidos", { lineas });
  return { id, lineas };
}
