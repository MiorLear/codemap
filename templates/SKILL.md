---
name: codemap-diagrama-primero
description: Antes de implementar cualquier feature o fix que cambie la lógica de una función de este proyecto, proponer el flujo como plan de codemap (.codemap/plans), esperar a que el humano lo apruebe en el visor y, al terminar, verificar con `codemap check` que el código cumple el plan. No aplica a cambios de texto, estilos, configuración o documentación.
---

# Diagrama primero

El humano revisa la lógica como diagrama **antes** de que exista el código, que es donde
corregirla es barato. Después, codemap compara el código real contra lo aprobado.

## 1. Proponer el plan (sin tocar código)

Explora lo necesario y escribe `.codemap/plans/<id>.json` (id en kebab-case):

```json
{
  "id": "pedidos-404",
  "titulo": "Qué se va a hacer, en una línea",
  "estado": "propuesto",
  "intencion": "Por qué: el problema concreto y qué queda fuera.",
  "cambios": [
    {
      "funcion": "ruta/del/archivo.ts#nombre",
      "accion": "modificar",
      "resumen": "Qué cambia en esta función",
      "pasos": [
        { "si": "¿condición en lenguaje humano?", "entonces": [{ "responde": 400, "detalle": "mensaje" }] },
        { "intentar": [{ "hacer": "Cargar los datos", "llama": ["cargarPedido"] }],
          "siFalla": [{ "hacer": "Registrar el error" }, { "responde": 502, "detalle": "mensaje" }] },
        { "repetir": "cada línea del pedido", "pasos": [{ "hacer": "…", "llama": ["fn"] }] },
        { "hacer": "Paso sin llamadas" },
        { "devuelve": "qué" },
        { "lanza": "qué error" },
        { "responde": 200, "detalle": "Payload" }
      ]
    }
  ],
  "revision": [],
  "historial": [{ "estado": "propuesto", "fecha": "<ISO>", "por": "Claude" }]
}
```

- `funcion` es el id del mapa: `archivo#nombre`. Rutas de Express: `archivo#GET /ruta` con la ruta
  tal como está en el router. Rutas de FastAPI: `archivo#POST /ruta`. Métodos: `archivo#Clase.metodo`.
  Para una función nueva usa `"accion": "crear"` con el id que tendrá.
- `llama` usa nombres de función del proyecto, no de librerías: es lo que se verifica.
- Describe el flujo **completo** de la función, no solo el cambio: los pasos que el código ya hace
  salen en verde y le dan contexto al humano.

Comprueba que el plan se lee bien y que describe el código actual:

```bash
codemap check <id>
```

Los pasos que ya existen deben salir con ✓. Si uno que *debería* existir sale con ✗, el plan
describe mal el código: corrígelo antes de enseñarlo.

## 2. Pedir revisión y PARAR

Si el servidor no está levantado: `codemap serve` (en segundo plano). Pide al humano que revise en
`http://localhost:4321/#/plan/<id>` y **no escribas código** hasta que el archivo diga
`"estado": "aprobado"`.

- `"cambios"`: lee `revision` (cada entrada puede llevar `pasoTexto`, el paso comentado), ajusta el
  plan, vuelve a `"propuesto"` y añade la entrada al `historial`. Vuelve a pedir revisión.
- Si el humano aprueba en el chat en lugar del visor, cambia tú el estado y anótalo en el
  historial con `"por": "chat"`.

## 3. Implementar y verificar

Implementa exactamente lo aprobado. Al terminar:

```bash
codemap check <id>
```

- Todo ✗ debe quedar resuelto. Si no se puede, explícale por qué al humano; no lo ocultes.
- Cada `+ … no previsto` es algo que el código hace y el plan no decía: justifícalo o, si cambia la
  lógica, actualiza el plan y vuelve a pedir revisión.
- Cuando cumple: `"estado": "implementado"` + entrada en `historial`.

En el informe final di cuántos pasos cumple (`n/n`), qué quedó no previsto y por qué.
