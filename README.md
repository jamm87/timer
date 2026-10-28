# Fichaje

Aplicación de control horario: **Entrada**, **Pausa**, **Reanudar** y **Salida**, con tabla de registros y barra de progreso de la jornada.

- Jornada: lunes a jueves **8h 30m**, viernes **6h** (sábado y domingo no laborables).
- Barra diaria con tiempo consumido, restante (o extra) y hora de salida estimada.
- Barra semanal (objetivo 40h).
- Tabla mensual con entrada, salida, pausas, trabajado, jornada y saldo. Pulsa un día para ver o borrar sus fichajes.
- Fichajes manuales (si se te olvidó fichar), exportación a CSV y copia de seguridad/restauración en JSON.
- Sin servidor ni base de datos: todo se guarda en el `localStorage` del navegador.

Las horas de jornada se cambian en `TARGET_HOURS`, al principio de `app.js`.

## Usarla como extensión de Chrome

1. Abre `chrome://extensions` y activa el **Modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y selecciona esta carpeta.
3. Fija el icono en la barra; al pulsarlo se abre el panel para fichar (con el botón ⤢ la abres en una pestaña).

## Usarla como webapp (PWA)

Es una web estática, se puede servir desde cualquier hosting estático. Con GitHub Pages:

1. En el repositorio: **Settings → Pages → Source: GitHub Actions**.
2. Al hacer push a `main`, el workflow `.github/workflows/pages.yml` la publica.
3. Abre la URL en Chrome y pulsa **Instalar** (icono en la barra de direcciones). Funciona sin conexión.

En local: `python3 -m http.server` y abre <http://localhost:8000>.

> Los datos de la extensión y los de la webapp son independientes (cada una tiene su propio almacenamiento). Usa
> *Copia completa (JSON)* / *Restaurar JSON* para pasar los datos de una a otra o para hacer copias de seguridad.
