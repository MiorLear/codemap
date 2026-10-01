# Contribuir

codemap es un prototipo y lo que más necesita ahora es **feedback de uso real**: ¿te ayuda a
revisar lo que escribe un agente? Abre un issue con la plantilla de feedback aunque solo hayas
probado el demo.

## Si quieres tocar código

```bash
npm install
npm test        # tiene que pasar antes de abrir un PR
npm run demo    # para verlo
```

Las pruebas (`test/run.mjs`) corren de extremo a extremo sobre una copia de `examples/demo`. Si
añades soporte para algo nuevo (un framework, un lenguaje, una regla), añade también el caso al
demo y una prueba que lo compruebe.

### Principios

- **El diagrama sale del código, no de un modelo.** Todo lo que se dibuja como hecho (llamadas,
  rutas, flujos) tiene que venir de un analizador. Lo que sea heurístico va marcado como aviso.
- **Nada se rompe en silencio.** Si algo no se puede resolver (un import, una ruta dinámica), el
  mapa lo dice en lugar de inventarlo.
- **Sin dependencias pesadas.** Hoy solo `typescript`; Python usa la librería estándar.

### Ideas por las que empezar

- Rutas de otros frameworks: Next.js (app router), NestJS, Fastify, Flask, Django.
- Más lenguajes (Go, Java) con el mismo formato de `graph.json`.
- Guardar en el repo (no solo en el navegador) la disposición acomodada a mano.
- Que el visor funcione sin internet (Cytoscape/ELK empaquetados).
